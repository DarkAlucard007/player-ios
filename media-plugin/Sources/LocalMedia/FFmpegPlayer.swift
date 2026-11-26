import AVFoundation
import CoreMedia
import VideoToolbox
import CoreVideo
import FFmpegShim

// AVERROR(e) 是 C 宏（Swift 不导入宏），手工实现：AVERROR(e) = -(e)
@inline(__always) private func avErr(_ e: Int32) -> Int32 { -e }

// AVIO read/seek 回调必须是 C 函数指针（无捕获）→ 顶层私有函数
private func ff_avioRead(_ opaque: UnsafeMutableRawPointer?, _ buf: UnsafeMutablePointer<UInt8>?, _ size: Int32) -> Int32 {
    guard let opaque, let buf else { return AVERROR_EOF }
    let src = Unmanaged<FFmpegDataSource>.fromOpaque(opaque).takeUnretainedValue()
    let n = src.reader(src.offset, buf, Int(size))
    src.offset += Int64(n)
    return n > 0 ? Int32(n) : AVERROR_EOF
}
private func ff_avioSeek(_ opaque: UnsafeMutableRawPointer?, _ off: Int64, _ whence: Int32) -> Int64 {
    guard let opaque else { return -1 }
    let src = Unmanaged<FFmpegDataSource>.fromOpaque(opaque).takeUnretainedValue()
    let base: Int64
    switch Int(whence) {
    case AVSEEK_SET: base = 0
    case AVSEEK_CUR: base = src.offset
    default: base = src.endOf
    }
    src.offset = base + off
    return src.offset
}

/// 从任意 (offset,length) 读字节的源——由 LocalMediaPlugin 依据 localmedia:// / smb2: / 本地文件提供。
final class FFmpegDataSource {
    let endOf: Int64
    let reader: (Int64, UnsafeMutablePointer<UInt8>, Int) -> Int
    var offset: Int64 = 0
    init(endOf: Int64, reader: @escaping (Int64, UnsafeMutablePointer<UInt8>, Int) -> Int) {
        self.endOf = endOf
        self.reader = reader
    }
}

/// 纯 Swift + FFmpeg C API 解码播放引擎（非 MP4 容器专用）。
final class FFmpegPlayer {
    private var fmtCtx: OpaquePointer?
    private var videoDec: OpaquePointer?
    private var audioDec: OpaquePointer?
    private var videoStreamIdx = -1
    private var audioStreamIdx = -1
    private var swsCtx: OpaquePointer?
    private var swrCtx: OpaquePointer?
    private var inLayout = AVChannelLayout()
    private var outLayout = AVChannelLayout()
    private var ioBuf: UnsafeMutablePointer<UInt8>?
    private var ioOpaque: UnsafeMutableRawPointer?
    private let displayLayer = AVSampleBufferDisplayLayer()
    private let audioEngine = AVAudioEngine()
    private var audioFormat: AVAudioFormat?
    private var isPaused = false
    private var stopped = false
    private var looping = false
    private let decodeQueue = DispatchQueue(label: "ffmpeg.decode", qos: .userInitiated)
    private var currentPTS: Double = 0
    private var videoTimeBase: Double = 1.0 / 30.0
    private(set) var duration: Double = 0
    private(set) var videoWidth = 0
    private(set) var videoHeight = 0
    private var lastPixelBuffer: CVPixelBuffer?

    var onReady: (() -> Void)?
    var onTime: ((Double) -> Void)?
    var onEnd: (() -> Void)?
    var onError: ((String) -> Void)?
    var paused: Bool { isPaused }

    // MARK: - 打开

    func open(source: FFmpegDataSource) {
        decodeQueue.async { [weak self] in self?.openInternal(source: source) }
    }

    private func openInternal(source: FFmpegDataSource) {
        let ioSize = 65536
        ioBuf = malloc(ioSize)
        ioOpaque = Unmanaged.passUnretained(source).toOpaque()
        var ioCtx: UnsafeMutablePointer<AVIOContext>?
        ioCtx = avio_alloc_context(ioBuf, ioSize, 0, ioOpaque, ff_avioRead, nil, ff_avioSeek)
        guard ioCtx != nil else { fail("avio_alloc_context 失败"); return }
        let fmt = avformat_alloc_context()
        guard fmt != nil else { fail("avformat_alloc_context 失败"); return }
        ff_format_set_pb(fmt, ioCtx) // 挂自定义 AVIO，再用空 URL 打开
        let rc = avformat_open_input(&fmt, "", nil, nil)
        if rc < 0 { fail("avformat_open_input 失败 rc=\(rc)"); return }
        setupAfterOpen(fmt)
    }

    /// 直接 URL 打开（http/https，需 FFmpeg 启用 network 协议）
    func openURL(_ urlString: String) {
        decodeQueue.async { [weak self] in
            guard let self else { return }
            var fmt: OpaquePointer?
            let rc = avformat_open_input(&fmt, urlString, nil, nil)
            if rc < 0 { self.fail("avformat_open_input(url) 失败 rc=\(rc)"); return }
            self.setupAfterOpen(fmt)
        }
    }

    private func setupAfterOpen(_ fmt: OpaquePointer?) {
        guard let fmt else { return }
        fmtCtx = fmt
        let rc2 = avformat_find_stream_info(fmt, nil)
        if rc2 < 0 { fail("avformat_find_stream_info 失败 rc=\(rc2)"); return }
        let dur = av_format_context_get_duration(fmt)
        if dur > 0 { duration = Double(dur) / 1_000_000.0 }
        videoStreamIdx = Int(av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, &videoDec, 0))
        audioStreamIdx = Int(av_find_best_stream(fmt, AVMEDIA_TYPE_AUDIO, -1, -1, &audioDec, 0))
        guard videoStreamIdx >= 0, let vstream = avformat_get_stream(fmt, Int32(videoStreamIdx)) else {
            fail("未找到视频流"); return
        }
        let vpar = avcodec_parameters_from_stream(vstream)
        videoWidth = Int(avcodecpar_get_width(vpar))
        videoHeight = Int(avcodecpar_get_height(vpar))
        videoTimeBase = av_q2d(avformat_get_stream_time_base(fmt, Int32(videoStreamIdx)))
        guard let vcodec = avcodec_find_decoder(avcodecpar_get_codec_id(vpar)) else { fail("无视频解码器"); return }
        let rcv = avcodec_open2(videoDec, vcodec, nil)
        if rcv < 0 { fail("avcodec_open2(视频) 失败 rc=\(rcv)"); return }
        if audioStreamIdx >= 0, let astream = avformat_get_stream(fmt, Int32(audioStreamIdx)) {
            let apar = avcodec_parameters_from_stream(astream)
            if let acodec = avcodec_find_decoder(avcodecpar_get_codec_id(apar)), avcodec_open2(audioDec, acodec, nil) == 0 {
                configureAudioEngine()
            }
        }
        displayLayer.videoGravity = .resizeAspect
        MainActor.assumeIsolated { onReady?() }
        runDecodeLoop()
    }

    private func configureAudioEngine() {
        guard audioFormat == nil else { return }
        guard let fmt = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2) else { return }
        audioFormat = fmt
        audioEngine.attach(audioEngine.mainMixerNode)
        audioEngine.connect(audioEngine.mainMixerNode, to: audioEngine.outputNode, format: fmt)
        do { try audioEngine.start() } catch { Log.write("ffmpeg 音频引擎启动失败：\(error.localizedDescription)") }
    }

    /// 首帧音频时懒建 swr：用 frame 的真实采样格式 + codecpar 的采样率/声道，声道布局走字符串 API（FFmpeg6）
    private func ensureSwr(frame: OpaquePointer?, apar: OpaquePointer?) {
        guard swrCtx == nil else { return }
        let inRate = Int(avcodecpar_get_sample_rate(apar))
        let inCh = Int(avcodecpar_get_channels(apar))
        let inFmt = Int32(av_frame_get_format(frame))
        let inStr = inCh <= 1 ? "mono" : (inCh == 2 ? "stereo" : "5.1")
        _ = av_channel_layout_from_string(&inLayout, inStr)
        _ = av_channel_layout_from_string(&outLayout, "stereo")
        swrCtx = swr_alloc_set_opts2(nil, &outLayout, AV_SAMPLE_FMT_FLTP, 48000, &inLayout, inFmt, inRate, 0, nil)
        if swrCtx != nil { _ = swr_init(swrCtx) }
    }

    // MARK: - 解码循环

    private func runDecodeLoop() {
        guard let pkt = av_packet_alloc() else { return }
        while !stopped && !isPaused {
            let rc = av_read_frame(fmtCtx, pkt)
            if rc < 0 {
                if rc == AVERROR_EOF {
                    if looping { seekInternal(0); continue }
                    MainActor.assumeIsolated { onEnd?() }
                }
                break
            }
            let si = Int(av_packet_get_stream_index(pkt))
            if si == videoStreamIdx { decodeVideo(pkt) }
            else if si == audioStreamIdx { decodeAudio(pkt) }
            av_packet_unref(pkt)
        }
        av_packet_free(&pkt)
    }

    private func decodeVideo(_ pkt: OpaquePointer?) {
        guard let videoDec else { return }
        _ = avcodec_send_packet(videoDec, pkt)
        guard let frame = av_frame_alloc() else { return }
        while true {
            let rc = avcodec_receive_frame(videoDec, frame)
            if rc != 0 { break }
            renderVideoFrame(frame)
        }
        av_frame_free(&frame)
    }

    private func renderVideoFrame(_ frame: OpaquePointer?) {
        if swsCtx == nil {
            let srcFmt = Int32(av_frame_get_format(frame))
            swsCtx = sws_getContext(videoWidth, videoHeight, srcFmt,
                                    videoWidth, videoHeight, AV_PIX_FMT_BGRA, SWS_BILINEAR, nil, nil, nil)
            guard swsCtx != nil else { return }
        }
        var pb: CVPixelBuffer?
        let st = CVPixelBufferCreate(nil, videoWidth, videoHeight, kCVPixelFormatType_32BGRA,
                                     [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pb)
        guard st == kCVReturnSuccess, let pb else { return }
        CVPixelBufferLockBaseAddress(pb, [])
        let base = CVPixelBufferGetBaseAddress(pb).assumingMemoryBound(to: UInt8.self)
        let rowBytes = CVPixelBufferGetBytesPerRow(pb)
        sws_scale(swsCtx,
                  [frame.data.0, frame.data.1, frame.data.2, nil],
                  [Int(frame.linesize.0), Int(frame.linesize.1), Int(frame.linesize.2), 0],
                  0, videoHeight,
                  [base, nil, nil, nil],
                  [rowBytes, 0, 0, 0])
        CVPixelBufferUnlockBaseAddress(pb, [])
        if let old = lastPixelBuffer { CVPixelBufferRelease(old) }
        CVPixelBufferRetain(pb)
        lastPixelBuffer = pb
        let ts = av_frame_get_best_effort_timestamp(frame)
        let pts: Double
        if ts >= 0 { pts = Double(ts) * videoTimeBase } else { pts = currentPTS + 1.0 / 30.0 }
        currentPTS = pts
        let timing = CMSampleTimingInfo(duration: CMTime(seconds: 1.0 / 30.0, preferredTimescale: 600),
                                        presentationTimeStamp: CMTime(seconds: pts, preferredTimescale: 600),
                                        decodeTimeStamp: kCMTimeInvalid)
        var sb: CMSampleBuffer?
        if CMSampleBufferCreateForImageBuffer(nil, pb, true, &timing, nil, nil, &sb) == noErr, let sb {
            displayLayer.enqueue(sb)
        }
        MainActor.assumeIsolated { onTime?(pts) }
    }

    private func decodeAudio(_ pkt: OpaquePointer?) {
        guard let audioDec else { return }
        _ = avcodec_send_packet(audioDec, pkt)
        guard let frame = av_frame_alloc() else { return }
        while true {
            let rc = avcodec_receive_frame(audioDec, frame)
            if rc != 0 { break }
            if let apar = avcodec_parameters_from_context(audioDec) { ensureSwr(frame: frame, apar: apar) }
            renderAudioFrame(frame)
        }
        av_frame_free(&frame)
    }

    private func renderAudioFrame(_ frame: OpaquePointer?) {
        guard let swrCtx, let audioFormat else { return }
        let inSamples = Int(av_frame_get_nb_samples(frame))
        let outCap = inSamples * 4
        let ch = Int(audioFormat.channelCount)
        guard let pb = AVAudioPCMBuffer(pcmFormat: audioFormat, frameCapacity: AVAudioFrameCount(outCap)) else { return }
        let inPlane: [UnsafePointer<UInt8>?] = [frame.data.0, frame.data.1, frame.data.2, frame.data.3]
        guard let outBase = UnsafeMutablePointer<UnsafeMutablePointer<Float>>.allocate(capacity: ch) else { return }
        defer { outBase.deallocate() }
        for c in 0..<ch { outBase[c] = UnsafeMutableRawPointer(pb.floatChannelData![c]).assumingMemoryBound(to: Float.self) }
        let converted = swr_convert(swrCtx, outBase, outCap, inPlane, inSamples)
        if converted > 0 {
            pb.frameLength = AVAudioFrameCount(converted)
            audioEngine.mainMixerNode.scheduleBuffer(pb, at: nil, options: .interrupts)
        }
    }

    // MARK: - 控制

    func play() {
        isPaused = false
        displayLayer.play()
        decodeQueue.async { [weak self] in self?.runDecodeLoop() }
    }
    func pause() {
        isPaused = true
        displayLayer.pause()
    }
    func seek(to seconds: Double) { seekInternal(max(0, seconds)) }
    private func seekInternal(_ seconds: Double) {
        guard let fmtCtx, videoStreamIdx >= 0 else { return }
        let tb = av_q2d(avformat_get_stream_time_base(fmtCtx, Int32(videoStreamIdx)))
        let target = Int64(seconds / tb)
        av_seek_frame(fmtCtx, Int32(videoStreamIdx), target, AVSEEK_FLAG_BACKWARD)
        if let d = videoDec { avcodec_flush_buffers(d) }
        if let d = audioDec { avcodec_flush_buffers(d) }
        displayLayer.removeAllCallbacks()
        currentPTS = seconds
        if !isPaused { decodeQueue.async { [weak self] in self?.runDecodeLoop() } }
    }
    func setVolume(_ v: Float) { audioEngine.mainMixerNode.outputVolume = max(0, min(1, v)) }
    func setLooping(_ on: Bool) { looping = on }
    func stop() {
        stopped = true
        isPaused = true
        displayLayer.pause()
        displayLayer.removeAll()
        audioEngine.pause()
        teardownFFmpeg()
    }
    func screenshotPixelBuffer() -> CVPixelBuffer? { lastPixelBuffer }
    var display: AVSampleBufferDisplayLayer { displayLayer }

    private func teardownFFmpeg() {
        if let s = swsCtx { sws_freeContext(s); swsCtx = nil }
        if var s = swrCtx { swr_free(&s); swrCtx = nil }
        av_channel_layout_uninit(&inLayout)
        av_channel_layout_uninit(&outLayout)
        if var d = videoDec { avcodec_free_context(&d); videoDec = nil }
        if var d = audioDec { avcodec_free_context(&d); audioDec = nil }
        if var f = fmtCtx { avformat_close_input(&f); fmtCtx = nil }
        if let b = ioBuf { free(b); ioBuf = nil }
        ioOpaque = nil
        if let old = lastPixelBuffer { CVPixelBufferRelease(old); lastPixelBuffer = nil }
        currentPTS = 0
    }
    private func fail(_ msg: String) {
        Log.write("ffmpeg 失败：\(msg)")
        teardownFFmpeg()
        MainActor.assumeIsolated { onError?(msg) }
    }
}
