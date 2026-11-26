import UIKit
import AVFoundation
import CoreMedia
import CoreVideo

/// 纯原生全屏播放 UI（FFmpeg 解码，用于 MKV/AVI/FLV 等 <video> 不支持的容器）。
final class FFmpegPlayerViewController: UIViewController {
    private let source: FFmpegDataSource
    private let directURL: String?
    private let title: String
    private let subSources: [FFmpegDataSource]
    private let nextLoader: (() -> Void)?
    private let player = FFmpegPlayer()

    private let hostView = UIView()
    private var controls = UIView()
    private var playBtn: UIButton!
    private var slider: UISlider!
    private var timeLabel: UILabel!
    private var titleLabel: UILabel!
    private var closeBtn: UIButton!
    private var volSlider: UISlider!
    private var subtitleLabel: UILabel!
    private var ccBtn: UIButton!
    private var rotLBtn: UIButton!
    private var rotRBtn: UIButton!
    private var hideWork: DispatchWorkItem?
    private var subLines: [(t: Double, text: String)] = []
    private var subIndex = 0
    private var showSubs = false
    private var lastTime: Double = 0
    private var ended = false

    init(source: FFmpegDataSource, title: String, subSources: [FFmpegDataSource] = [], nextLoader: (() -> Void)? = nil) {
        self.source = source
        self.directURL = nil
        self.title = title
        self.subSources = subSources
        self.nextLoader = nextLoader
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        preferredContentSize = UIScreen.main.bounds.size
    }
    init(directURL: String, title: String, subSources: [FFmpegDataSource] = [], nextLoader: (() -> Void)? = nil) {
        self.source = FFmpegDataSource(endOf: 0) { _, _, _ in 0 }
        self.directURL = directURL
        self.title = title
        self.subSources = subSources
        self.nextLoader = nextLoader
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        preferredContentSize = UIScreen.main.bounds.size
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        hostView.backgroundColor = .black
        view.addSubview(hostView)
        player.display.frame = hostView.bounds
        hostView.layer.addSublayer(player.display)
        buildControls()
        parseSubtitles()
        player.onReady = { [weak self] in
            guard let self else { return }
            self.player.play()
            self.titleLabel.text = self.title
            self.player.onTime?(0)
            self.pokeControls()
        }
        player.onTime = { [weak self] t in
            guard let self else { return }
            self.lastTime = t
            if !self.ended { self.slider.value = Float(t) }
            let dur = self.player.duration > 0 ? self.player.duration : 1
            self.slider.maximumValue = Float(max(dur, 1))
            self.timeLabel.text = "\(Self.mmss(t)) / \(Self.mmss(self.player.duration))"
            self.updateSubtitle(at: t)
        }
        player.onEnd = { [weak self] in
            guard let self else { return }
            self.ended = true
            self.playBtn.setTitle("↻", for: .normal)
            if self.nextLoader != nil { self.pokeControls() }
        }
        player.onError = { [weak self] msg in
            guard let self else { return }
            self.titleLabel.text = "播放失败：\(msg)"
            self.pokeControls()
        }
        if let durl = directURL { player.openURL(durl) } else { player.open(source: source) }
    }

    private func buildControls() {
        controls = UIView()
        controls.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        view.addSubview(controls)
        let mk: (String, CGFloat, CGFloat, CGFloat) -> UIButton = { txt, w, h, x in
            let b = UIButton(type: .system); b.setTitle(txt, for: .normal)
            b.setTitleColor(.white, for: .normal); b.titleLabel?.font = .systemFont(ofSize: 20, weight: .medium)
            b.frame = CGRect(x: x, y: 0, width: w, height: h); return b
        }
        closeBtn = mk("✕", 44, 44, 8)
        titleLabel = UILabel(); titleLabel.textColor = .white; titleLabel.font = .systemFont(ofSize: 14); titleLabel.textAlignment = .center
        playBtn = mk("⏸", 44, 44, 0)
        rotLBtn = mk("⟲", 40, 40, 0)
        rotRBtn = mk("⟳", 40, 40, 0)
        ccBtn = mk("CC", 40, 40, 0); ccBtn.setTitleColor(.darkGray, for: .normal)
        timeLabel = UILabel(); timeLabel.textColor = .white; timeLabel.font = .monospacedDigitSystemFont(ofSize: 12)
        slider = UISlider()
        volSlider = UISlider(); volSlider.value = 1; volSlider.frame = CGRect(x: 0, y: 0, width: 90, height: 28)
        subtitleLabel = UILabel(); subtitleLabel.textColor = .white; subtitleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        subtitleLabel.textAlignment = .center; subtitleLabel.backgroundColor = UIColor.black.withAlphaComponent(0.5)
        subtitleLabel.numberOfLines = 0; subtitleLabel.isHidden = true
        [closeBtn, playBtn, rotLBtn, rotRBtn, ccBtn].forEach { controls.addSubview($0) }
        controls.addSubview(titleLabel); controls.addSubview(slider); controls.addSubview(timeLabel); controls.addSubview(volSlider)
        view.addSubview(subtitleLabel)
        closeBtn.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        playBtn.addTarget(self, action: #selector(playTapped), for: .touchUpInside)
        rotLBtn.addTarget(self, action: #selector(rotLeft), for: .touchUpInside)
        rotRBtn.addTarget(self, action: #selector(rotRight), for: .touchUpInside)
        ccBtn.addTarget(self, action: #selector(toggleCC), for: .touchUpInside)
        slider.addTarget(self, action: #selector(sliderChanged), for: .valueChanged)
        volSlider.addTarget(self, action: #selector(volChanged), for: .valueChanged)
        let tap = UITapGestureRecognizer(target: self, action: #selector(viewTapped))
        view.addGestureRecognizer(tap)
    }

    override func viewWillLayoutSubviews() {
        super.viewWillLayoutSubviews()
        hostView.frame = view.bounds
        player.display.frame = hostView.bounds
        let w = view.bounds.width, h = view.bounds.height
        let top: CGFloat = h * 0.06, bot: CGFloat = h * 0.06
        controls.frame = CGRect(x: 0, y: 0, width: w, height: h)
        closeBtn.frame.origin = CGPoint(x: 8, y: top + 4)
        titleLabel.frame = CGRect(x: 60, y: top + 8, width: w - 120, height: 24)
        let cx: CGFloat = (w - 3 * 44 - 4 * 8) / 4
        playBtn.frame.origin = CGPoint(x: 8 + cx * 0, y: h / 2 - 22)
        rotLBtn.frame.origin = CGPoint(x: 8, y: h / 2 - 20)
        rotRBtn.frame.origin = CGPoint(x: 8 + 44, y: h / 2 - 20)
        ccBtn.frame.origin = CGPoint(x: w - 48, y: h / 2 - 20)
        playBtn.frame = CGRect(x: w / 2 - 22, y: h / 2 - 22, width: 44, height: 44)
        slider.frame = CGRect(x: 16, y: h - bot - 40, width: w - 32, height: 28)
        timeLabel.frame = CGRect(x: 16, y: h - bot - 16, width: 120, height: 16)
        volSlider.frame.origin = CGPoint(x: w - 106, y: h - bot - 24)
        subtitleLabel.frame = CGRect(x: w * 0.1, y: h - bot - 90, width: w * 0.8, height: 60)
    }

    @objc private func viewTapped() {
        if controls.isHidden { pokeControls() } else { hideControlsSoon() }
    }
    private func pokeControls() {
        controls.isHidden = false
        hideWork?.cancel()
        let wk = DispatchWorkItem { [weak self] in self?.hideControlsSoon() }
        hideWork = wk
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5, execute: wk)
    }
    private func hideControlsSoon() { controls.isHidden = true }
    @objc private func playTapped() {
        if ended { player.seek(to: 0); ended = false; playBtn.setTitle("⏸", for: .normal); player.play(); pokeControls(); return }
        if player.paused { player.play(); playBtn.setTitle("⏸", for: .normal) }
        else { player.pause(); playBtn.setTitle("▶", for: .normal) }
        pokeControls()
    }
    @objc private func sliderChanged() {
        let t = Double(slider.value)
        lastTime = t
        timeLabel.text = "\(Self.mmss(t)) / \(Self.mmss(player.duration))"
        player.seek(to: t)
    }
    @objc private func volChanged() { player.setVolume(Float(volSlider.value)) }
    @objc private func rotLeft() { rotate(by: -1) }
    @objc private func rotRight() { rotate(by: 1) }
    private func rotate(by dir: Int) {
        let order: [ScreenOrientation] = [.portrait, .landscapeLeft, .landscapeRight]
        let cur = (Self.currentIdx + dir % 3 + 3) % 3
        Self.setScreenOrientation(order[cur])
        pokeControls()
    }
    @objc private func toggleCC() {
        showSubs.toggle()
        ccBtn.setTitleColor(showSubs ? .white : .darkGray, for: .normal)
        subtitleLabel.isHidden = !showSubs || subIndex >= subLines.count
        pokeControls()
    }
    @objc private func closeTapped() {
        player.stop()
        dismiss(animated: true)
    }
    private func updateSubtitle(at t: Double) {
        guard !subLines.isEmpty else { return }
        while subIndex + 1 < subLines.count && subLines[subIndex + 1].t <= t { subIndex += 1 }
        if subIndex < subLines.count && t >= subLines[subIndex].t {
            subtitleLabel.text = subLines[subIndex].text
            subtitleLabel.isHidden = !showSubs
        } else {
            subtitleLabel.isHidden = true
        }
    }
    private func parseSubtitles() {
        for s in subSources {
            var data = Data(); var off: Int64 = 0
            while off < s.endOf {
                var buf = [UInt8](repeating: 0, count: 65536)
                let n = s.reader(off, &buf, 65536)
                if n <= 0 { break }
                data.append(contentsOf: buf[0..<n]); off += Int64(n)
            }
            subLines = Self.parseSRT(data)
            if !subLines.isEmpty { break }
        }
    }
    static func parseSRT(_ data: Data) -> [(t: Double, text: String)] {
        guard let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else { return [] }
        var out: [(Double, String)] = []
        for block in text.components(separatedBy: "\n\n") {
            let lines = block.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            guard let tsIdx = lines.firstIndex(of: "-->"), tsIdx > 0, tsIdx + 1 < lines.count else { continue }
            let ts = lines[tsIdx - 1]
            let parts = ts.components(separatedBy: ",")
            guard let hh = Double(parts.count > 0 ? parts[0].split(separator: ":")[0] as Array<String>.Element.description : "0") else { continue }
            let t = Self.parseTS(ts)
            var txt: [String] = []
            for i in (tsIdx + 1)..<lines.count { if !lines[i].isEmpty { txt.append(lines[i]) } }
            if !txt.isEmpty { out.append((t, txt.joined(separator: "\n"))) }
        }
        return out
    }
    private static func parseTS(_ s: String) -> Double {
        let main = s.components(separatedBy: "-->")[0]
        let parts = main.components(separatedBy: ",")
        guard let hms = parts.first else { return 0 }
        let nums = hms.split(separator: ":").compactMap { Double($0) }
        guard nums.count == 3 else { return 0 }
        var ms = 0.0
        if parts.count > 1 { ms = Double(parts[1].replacingOccurrences(of: " ", with: "")) ?? 0 }
        return nums[0] * 3600 + nums[1] * 60 + nums[2] + ms / 1000
    }
    static func mmss(_ s: Double) -> String {
        let t = max(0, Int(s)); return String(format: "%02d:%02d:%02d", t / 3600, (t % 3600) / 60, t % 60)
    }
    deinit { player.stop() }
}

// 屏幕朝向（与 LocalMediaPlugin.setOrientation 复用）
enum ScreenOrientation: String { case portrait, landscapeLeft, landscapeRight }
extension FFmpegPlayerViewController {
    static var currentIdx = 0
    static func setScreenOrientation(_ o: ScreenOrientation) {
        switch o { case .portrait: currentIdx = 0; case .landscapeLeft: currentIdx = 1; case .landscapeRight: currentIdx = 2 }
        DispatchQueue.main.async {
            let mask: UIInterfaceOrientationMask
            switch o { case .portrait: mask = .portrait; case .landscapeLeft: mask = .landscapeLeft; case .landscapeRight: mask = .landscapeRight }
            if #available(iOS 16, *), let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first {
                _ = localmedia_runGuarded { scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { _ in } }
            }
            let dev: UIDeviceOrientation = (o == .landscapeLeft) ? .landscapeRight : (o == .landscapeRight) ? .landscapeLeft : .portrait
            _ = localmedia_runGuarded { UIDevice.current.setValue(dev.rawValue, forKey: "orientation") }
        }
    }
}
