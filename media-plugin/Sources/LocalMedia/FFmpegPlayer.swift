import AVFoundation
import CoreMedia
import CoreVideo

// FFmpeg 解码播放引擎（用 FFmpegShim 的 C API，非 MP4 容器专用）。
// 所有 FFmpeg 交互都在 FFmpegShim.m 里，这里只调干净的 C 函数 + 做 AVFoundation 渲染。

// C 回调：从 FFmpegDataSource 在 offset 处读字节
private func ff_readerBridge(_ opaque: UnsafeMutableRawPointer?, _ offset: Int64, _ buf: UnsafeMutablePointer<UInt8>?, _ size: Int32) -> Int32 {
    guard let opaque, let buf else { return 0 }
    let src = Unmanaged<FFmpegDataSource>.fromOpaque(opaque).takeUnretainedValue()
    let n = src.reader(offset, buf, Int(size))
    return Int32(n)
}

/// 从任意 (offset,length) 读字节的源——由 LocalMediaPlugin 依据 localmedia:// / smb2: / 本地文件提供。
final class FFmpegDataSource {
    let endOf: Int64
    let reader: (Int64, UnsafeMutablePointer<UInt8>, Int) -> Int
    init(endOf: Int64, reader: @escaping (Int64, UnsafeMutablePointer<UInt8>, Int) -> Int) {
        self.endOf = endOf
        self.reader = reader
    }
}

final class FFmpegPlayer {
    private var player: OpaquePointer?
    private let displayLayer = AVSampleBufferDisplayLayer()
    private let audioEngine = AVAudioEngine()
    private var audioFormat: AVAudioFormat?
    private var isPaused = false
    private var stopped = false
    private var looping = false
    private let decodeQueue = DispatchQueue(label: "ffmpeg.decode", qos: .userInitiated)
    private(set) var duration: Double = 0
    private(set) var videoWidth = 0
    private(set) var videoHeight = 0
    private var bgraBuf: [UInt8]

    var onReady: (() -> Void)?
    var onTime: ((Double) -> Void)?
    var onEnd: (() -> Void)?
    var onError: ((String) -> Void)?

    init() { bgraBuf = [] }

    var display: AVSampleBufferDisplayLayer { displayLayer }
    var paused: Bool { isPaused }

    func open(source: FFmpegDataSource) {
        decodeQueue.async { [weak self] in self?.openInternal(source: source) }
    }

    private func openInternal(source: FFmpegDataSource) {
        let opaque = Unmanaged.passUnretained(source).toOpaque()
        player = ff_player_new(source.endOf, ff_readerBridge, opaque)
        guard player != nil else { fail("ff_player_new 失败"); return }
        let rc = ff_player_open(player)
        if rc != 0 { fail("ff_player_open 失败 rc=\(rc)"); return }
        duration = ff_player_duration(player)
        videoWidth = Int(ff_player_video_w(player))
        videoHeight = Int(ff_player_video_h(player))
        bgraBuf = [UInt8](repeating: 0, count: videoWidth * videoHeight * 4)
        configureAudioEngine()
        displayLayer.videoGravity = .resizeAspect
        MainActor.assumeIsolated { onReady?() }
        runDecodeLoop()
    }

    private func configureAudioEngine() {
        guard let fmt = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2) else { return }
        audioFormat = fmt
        audioEngine.attach(audioEngine.mainMixerNode)
        audioEngine.connect(audioEngine.mainMixerNode, to: audioEngine.outputNode, format: fmt)
        do { try audioEngine.start() } catch { Log.write("ffmpeg 音频引擎启动失败：\(error.localizedDescription)") }
    }

    private func runDecodeLoop() {
        while !stopped && !isPaused {
            let kind = Int(ff_player_next(player))
            if kind == 0 { // EOF
                if looping { seek(to: 0); continue }
                MainActor.assumeIsolated { onEnd?() }
                break
            } else if kind < 0 {
                fail("ff_player_next 错误 \(kind)")
                break
            } else if kind == 1 {
                renderVideo()
            } else if kind == 2 {
                renderAudio()
            }
        }
    }

    private func renderVideo() {
        var pb: CVPixelBuffer?
        let st = CVPixelBufferCreate(nil, videoWidth, videoHeight, kCVPixelFormatType_32BGRA,
                                     [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pb)
        guard st == kCVReturnSuccess, let pb else { return }
        let pts = bgraBuf.withUnsafeMutableBytes { ptr in
            ff_player_video_bgra(player, ptr.baseAddress!.assumingMemoryBound(to: UInt8.self), Int32(bgraBuf.count))
        }
        guard pts >= 0 else { CVPixelBufferRelease(pb); return }
        CVPixelBufferLockBaseAddress(pb, [])
        let base = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
        base.update(from: bgraBuf, count: bgraBuf.count)
        CVPixelBufferUnlockBaseAddress(pb, [])
        let timing = CMSampleTimingInfo(duration: CMTime(seconds: 1.0/30.0, preferredTimescale: 600),
                                        presentationTimeStamp: CMTime(seconds: pts, preferredTimescale: 600),
                                        decodeTimeStamp: CMTime.invalid)
        var sb: CMSampleBuffer?
        if CMSampleBufferCreateForImageBuffer(nil, pb, true, { timing }, nil, nil, &sb) == noErr, let sb {
            CVPixelBufferRetain(pb)
            displayLayer.enqueue(sb)
        }
        CVPixelBufferRelease(pb)
        MainActor.assumeIsolated { onTime?(pts) }
    }

    private func renderAudio() {
        guard let audioFormat, let chData = audioFormat.floatChannelData else { return }
        let cap = 4800 * 2 // ~100ms @48k stereo
        guard let pb = AVAudioPCMBuffer(pcmFormat: audioFormat, frameCapacity: AVAudioFrameCount(cap)) else { return }
        let n = Int(ff_player_audio_float(player, chData[0], chData[1], Int32(cap)))
        if n > 0 {
            pb.frameLength = AVAudioFrameCount(n)
            audioEngine.mainMixerNode.scheduleBuffer(pb, at: nil, options: .interrupts)
        }
    }

    func play() {
        isPaused = false
        displayLayer.play()
        decodeQueue.async { [weak self] in self?.runDecodeLoop() }
    }
    func pause() { isPaused = true; displayLayer.pause() }
    func seek(to seconds: Double) {
        ff_player_seek(player, seconds)
        displayLayer.removeAllCallbacks()
        if !isPaused { decodeQueue.async { [weak self] in self?.runDecodeLoop() } }
    }
    func setVolume(_ v: Float) { audioEngine.mainMixerNode.outputVolume = max(0, min(1, v)) }
    func setLooping(_ on: Bool) { looping = on }
    func stop() {
        stopped = true; isPaused = true
        displayLayer.pause(); displayLayer.removeAll()
        audioEngine.pause()
        if let p = player { ff_player_free(p); player = nil }
    }
    private func fail(_ msg: String) {
        Log.write("ffmpeg 失败：\(msg)")
        if let p = player { ff_player_free(p); player = nil }
        MainActor.assumeIsolated { onError?(msg) }
    }
}
