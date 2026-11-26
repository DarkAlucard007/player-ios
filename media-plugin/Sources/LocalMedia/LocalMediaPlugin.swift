//
//  LocalMediaPlugin.swift
//
//  本地媒体插件：
//  - pickMedia: 系统文件选择器导入视频/字幕，拷贝进 App 缓存目录
//  - localmedia:// 自定义 scheme 流式读取（支持 HTTP Range，视频可拖动进度）
//  - captureFrame: AVAssetImageGenerator 原生截帧（截图/缩略图，绕开 canvas 污染）
//  - saveImageToPhotos: 仅添加权限保存到相册
//

import Capacitor
import UIKit
import WebKit
import AVFoundation
import Photos
import UniformTypeIdentifiers

// 让同模块其他文件（SMB2Client / FFmpegPlayer / FFmpegPlayerViewController）能直接用 `Log`
typealias Log = LocalMediaPlugin.Log

@objc(LocalMediaPlugin)
public class LocalMediaPlugin: CAPPlugin, CAPBridgedPlugin, WKURLSchemeHandler, UIDocumentPickerDelegate {

    // MARK: - CAPBridgedPlugin（Capacitor 7 自动发现，类名必须与 packageClassList 一致）

    public let identifier = "LocalMediaPlugin"
    public let jsName = "LocalMedia"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickMedia", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearCache", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "captureFrame", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveImageToPhotos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "browseSMB", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listSMBFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseSMBFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readLog", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearLog", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selfTest", returnType: CAPPluginReturnPromise),
        // v1.1.26：旋转 / 本地文件夹管理 / NAS 目录枚举与文件操作
        CAPPluginMethod(name: "setOrientation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "renameItem", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "moveItem", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copyItem", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listSMBDir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createSMBFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "renameSMBItem", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "moveSMBItem", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copySMBItem", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteSMBItem", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSMBFile", returnType: CAPPluginReturnPromise),
        // v1.1.27：系统选择器授权一次拿到 NAS 共享根（LiveFiles 安全作用域），目录树在其上遍历
        CAPPluginMethod(name: "connectSMB", returnType: CAPPluginReturnPromise),
        // v1.1.31：FFmpeg 原生播放（MKV/AVI/FLV 等 <video> 不支持的容器）
        CAPPluginMethod(name: "playNative", returnType: CAPPluginReturnPromise)
    ]

    // MARK: - 调试日志（同步写文件：闪退后日志依然存活，供 App 内查看/复制）

    enum Log {
        static let fileURL: URL = {
            let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            return dir.appendingPathComponent("app-debug.log")
        }()
        static let iso = ISO8601DateFormatter()
        static let queue = DispatchQueue(label: "localmedia.log")

        static func write(_ s: String) {
            let line = "[\(iso.string(from: Date()))] \(s)\n"
            NSLog("%@", line.trimmingCharacters(in: .newlines))
            queue.sync {
                if let data = line.data(using: .utf8) {
                    if let handle = try? FileHandle(forWritingTo: fileURL) {
                        handle.seekToEndOfFile()
                        handle.write(data)
                        try? handle.close()
                    } else {
                        try? data.write(to: fileURL)
                    }
                }
            }
        }

        static func tail(_ n: Int) -> String {
            queue.sync {
                guard let content = try? String(contentsOf: fileURL, encoding: .utf8) else { return "" }
                let lines = content.components(separatedBy: "\n").filter { !$0.isEmpty }
                return lines.suffix(n).joined(separator: "\n")
            }
        }

        /// v1.1.29：真正清空日志文件（旧版只追加一行“已清空”标记，文件从未被截断）
        static func clear() {
            queue.sync {
                let marker = "[\(iso.string(from: Date()))] ---- 日志已清空 ----\n"
                try? marker.write(to: fileURL, atomically: true, encoding: .utf8)
            }
        }
    }

    // MARK: - 存储

    private static let scheme = "localmedia"
    private static let videoExts: Set<String> = [
        "mp4", "m4v", "mov", "mkv", "avi", "webm", "rmvb", "rm", "wmv", "ts", "flv", "3gp", "mpg", "mpeg"
    ]
    private static let subtitleExts: Set<String> = ["srt", "ass", "ssa", "sub"]

    /// v1.1.13：SMB picker 用通用类型 .item（不过滤）。
    /// 原因：picker 按内容类型过滤文件，但 SMB 远程文件的 UTType 探测不可靠，
    /// 用 [.movie,.video,…] 会把全部远程文件过滤掉→空列表（v1.1.12 实测）。
    /// .item 显示全部文件，用户直接选视频即可（前端按扩展名判字幕/视频）。
    private static let smbPickTypes: [UTType] = [.item]

    private var mediaDir: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("localmedia", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// pickMedia 的异步回调 id（文件选择器回调时再取回 call）
    private var pendingPickId: String?

    /// browseSMB 的异步回调 id（SMB picker 模式；didPickDocumentsAt 见它已设置就走流式登记、不拷贝）
    private var pendingSMBBrowseId: String?

    /// SMB 会话文件：名称 → 安全作用域 URL（保持 startAccessing 直到 release）。
    /// v1.1.20 改为 static：scheme handler 实例（LocalMediaBridgeViewController 创建）
    /// 与 bridge 插件实例（JS 调 browseSMB）是两个对象，会话状态必须共享。
    private static var smbFiles: [String: URL] = [:]
    /// SMB 会话文件的类型（video/subtitle/other），listSMBFiles 时回传，前端据此区分
    private static var smbKinds: [String: String] = [:]
    /// v1.1.25：SMB 文件大小缓存（登记时 stat 一次）。旧代码每个 scheme 请求都同步
    /// resourceValues(forKeys:) 走一趟 NAS——.ips 崩溃时刻主线程正卡在这类 stat 上，
    /// 几十个并发探测请求把 stat 堆成雪崩。会话期内文件不变，缓存即够。
    private static var smbSizes: [String: Int64] = [:]

    /// v1.1.27：NAS 共享根（LiveFiles 安全作用域 URL）。
    /// 沙盒 App 里 FileManager 直连 smb:// 没有权限——必须经系统「文件」选择器授权一次，
    /// 拿到 file:///private/var/mobile/Library/LiveFiles/com.apple.filesystems.smbclientd/<挂载> 形式的根，
    /// 之后目录树（枚举/新建/改名/移动/复制/删除/播放）全部在这个根上用 FileManager 操作。
    /// 授权的生命周期 = App 进程；App 被杀后需重新 connectSMB。
    private static var smbRoot: URL?
    private static var smbRootHost: String = ""

    // v1.1.28：内置 SMB2 客户端直连（无需系统选择器授权）。
    // key = "smb2:<host>|<port>|<share>|<path>/<name>"，值是持久连接的文件流。
    private static var smb2Streams: [String: SMB2Stream] = [:]
    private static var smb2Sizes: [String: Int64] = [:]

    /// 从 JS options 构造 SMB2 连接配置（host/port/share/user/pass）
    private static func smb2Cfg(_ opts: [AnyHashable: Any]) -> SMB2Connection.Config? {
        guard let host = opts["host"] as? String, !host.isEmpty,
              let share = opts["share"] as? String, !share.isEmpty else { return nil }
        let port = (opts["port"] as? String).flatMap { Int($0) } ?? 445
        return SMB2Connection.Config(host: host, port: port, user: opts["user"] as? String ?? "", pass: opts["pass"] as? String ?? "")
    }

    /// connectSMB 的异步回调 id（picker 授权回调时再取回 call）
    private var pendingSMBConnectId: String?

    // MARK: - 播放自测（装机一键验证：样本复制 → scheme handler → 媒体引擎）

    private static let selfTestName = "selftest-sample.mp4"

    /// 把内置 sample.mp4（Big Buck Bunny 10 秒，788 KB，H.264+AAC）复制进媒体缓存目录，
    /// 返回文件名与大小。前端用它构造 localmedia:// URL，依次做 Range 探测和
    /// <video> 真实播放，一键证明"原生层能播视频"——不再依赖用户手动导入。
    @objc func selfTest(_ call: CAPPluginCall) {
        let dest = mediaDir.appendingPathComponent(Self.selfTestName)
        if !FileManager.default.fileExists(atPath: dest.path) {
            guard let src = sampleResourceURL() else {
                Log.write("selfTest 失败：找不到内置 sample.mp4 资源（pod Resources 未生效？）")
                call.reject("sample.mp4 resource missing (pod Resources not effective?)")
                return
            }
            do {
                try FileManager.default.copyItem(at: src, to: dest)
                Log.write("selfTest 已复制内置样本 → \(dest.path)")
            } catch {
                Log.write("selfTest 复制失败：\(error.localizedDescription)")
                call.reject("sample copy failed: \(error.localizedDescription)")
                return
            }
        }
        let size = (try? dest.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        call.resolve(["name": Self.selfTestName, "size": size])
    }

    private func sampleResourceURL() -> URL? {
        // CocoaPods 动态库：Resources/sample.mp4 → LocalMedia.framework/LocalMedia.bundle/sample.mp4
        for bundle in [Bundle(for: Self.self), Bundle.main] {
            if let u = bundle.url(forResource: "sample", withExtension: "mp4") {
                return u
            }
            if let rb = bundle.url(forResource: "LocalMedia", withExtension: "bundle"),
               let inner = Bundle(url: rb), let u = inner.url(forResource: "sample", withExtension: "mp4") {
                return u
            }
        }
        return nil
    }

    @objc func readLog(_ call: CAPPluginCall) {
        call.resolve(["log": Log.tail(400)])
    }

    @objc func clearLog(_ call: CAPPluginCall) {
        Log.clear()
        call.resolve(["ok": true])
    }

    // MARK: - 注册 URL scheme 处理器

    private var schemeRegistered = false

    /// v1.1.24：LocalMediaBridgeViewController 在 webview 创建**之前**已挂上 handler 时置 true。
    /// load() 看到此标记必须跳过重复注册——iOS 26 WebKit 对同一 scheme 的第二次
    /// setURLSchemeHandler 抛 NSInvalidArgumentException → SIGABRT 闪退（.ips 实锤，
    /// 崩溃栈 setURLSchemeHandler:forURLScheme: ← registerSchemeHandler closure）。
    static var schemeInstalledByVC = false

    public override func load() {
        Log.write("load() 插件初始化 webView=\(bridge?.webView == nil ? "nil" : "存在")")
        if Self.schemeInstalledByVC {
            Log.write("load()：handler 已由 LocalMediaBridgeViewController 预挂（webview 创建前），跳过重复注册")
            return
        }
        registerSchemeHandler(attempt: 0)
    }

    /// v1.1.20：主注册点已移到 LocalMediaBridgeViewController.webViewConfiguration(for:)
    /// （webview 创建之前，WebKit 才认）。此处 load() 里的注册是冗余兜底——
    /// 创建后再挂理论上不生效，但保留它：日志能同时呈现两处状态，便于真机排查。
    /// v1.1.24：VC 已注册时整个兜底不再执行（重复注册会崩，见上）。
    private func registerSchemeHandler(attempt: Int) {
        if schemeRegistered { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.schemeRegistered { return }
            guard let config = self.bridge?.webView?.configuration else {
                if attempt < 5 {
                    Log.write("scheme 注册：webView 仍为 nil，500ms 后重试（\(attempt + 1)/5）")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                        self?.registerSchemeHandler(attempt: attempt + 1)
                    }
                } else {
                    Log.write("scheme 注册失败：webView 持续为 nil —— localmedia:// 播放将全部 code=4（请把此日志发出）")
                }
                return
            }
            config.setURLSchemeHandler(self, forURLScheme: Self.scheme)
            self.schemeRegistered = true
            Log.write("scheme 注册成功 localmedia://（主线程，attempt=\(attempt)）")
        }
    }

    // MARK: - Actions

    @objc func pickMedia(_ call: CAPPluginCall) {
        // Capacitor 7 把插件方法调度到后台串行队列 "bridge" 上执行——一切 UIKit 操作
        // （取锚点、present）必须切回主线程，否则文档类 UI 弹出时 UIKit 层级检查断言崩溃。
        // （.ips 实锤：testBrowserLocal 在 bridge 队列 present → _addChildViewController
        //  performHierarchyCheck 失败 → SIGABRT，v1.1.0–v1.1.4 全部闪退的真正根因）
        DispatchQueue.main.async {
            Log.write("pickMedia 开始 subtitles=\((call.options["subtitles"] as? NSNumber)?.boolValue ?? false)")
            let allowSubtitles = (call.options["subtitles"] as? NSNumber)?.boolValue ?? false
            guard let anchor = self.presentingAnchor() else {
                Log.write("pickMedia 失败：无展示锚点")
                call.reject("no presentation anchor")
                return
            }
            Log.write("pickMedia 锚点=\(type(of: anchor)) 开始展示系统选择器（主线程）")
            var types: [UTType] = [.movie, .video, .mpeg4Movie, .quickTimeMovie]
            if allowSubtitles {
                types.append(contentsOf: [.plainText, .utf8PlainText, .item])
            }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
            picker.allowsMultipleSelection = true
            picker.delegate = self
            self.bridge?.saveCall(call)
            self.pendingPickId = call.callbackId
            anchor.present(picker, animated: true)
        }
    }

    /// v1.1.26：listFiles 支持 folder 参数（相对子目录路径，""=根目录）。
    /// 返回 folders（子文件夹名列表）+ files（该层级的视频/字幕，不含更深目录）。
    @objc func listFiles(_ call: CAPPluginCall) {
        let folder = (call.options["folder"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let dir = folder.isEmpty ? mediaDir : mediaDir.appendingPathComponent(folder)
        let fm = FileManager.default
        var folders: [String] = []
        var files: [[String: Any]] = []
        guard let entries = try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey, .isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            call.resolve(["folders": [], "files": []])
            return
        }
        for url in entries {
            let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            if isDir {
                folders.append(url.lastPathComponent)
                continue
            }
            let ext = url.pathExtension.lowercased()
            let isSubtitle = Self.subtitleExts.contains(ext)
            let isVideo = Self.videoExts.contains(ext)
            guard isVideo || isSubtitle else { continue }
            let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            files.append([
                "name": url.lastPathComponent,
                "size": values?.fileSize ?? 0,
                "kind": isSubtitle ? "subtitle" : "video",
                "modifiedAt": (values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000
            ])
        }
        folders.sort { $0.localizedStandardCompare($1) == .orderedAscending }
        files.sort { ($0["modifiedAt"] as? Double ?? 0) > ($1["modifiedAt"] as? Double ?? 0) }
        call.resolve(["folders": folders, "files": files])
    }

    @objc func deleteFile(_ call: CAPPluginCall) {
        guard let name = call.options["name"] as? String, !name.isEmpty else {
            call.reject("missing name")
            return
        }
        let folder = (call.options["folder"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let target = folder.isEmpty ? mediaDir.appendingPathComponent(name) : mediaDir.appendingPathComponent(folder).appendingPathComponent(name)
        try? FileManager.default.removeItem(at: target)
        call.resolve(["ok": true])
    }

    /// v1.1.26：在指定层级新建文件夹（folder 为父目录，""=根）
    @objc func createFolder(_ call: CAPPluginCall) {
        guard let name = call.options["name"] as? String, !name.isEmpty else {
            call.reject("missing name")
            return
        }
        let folder = (call.options["folder"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let parent = folder.isEmpty ? mediaDir : mediaDir.appendingPathComponent(folder)
        let dest = parent.appendingPathComponent(name, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
            call.resolve(["ok": true])
        } catch {
            call.reject("create folder failed: \(error.localizedDescription)")
        }
    }

    /// v1.1.26：重命名文件夹或文件
    @objc func renameItem(_ call: CAPPluginCall) {
        guard let name = call.options["name"] as? String,
              let newName = call.options["newName"] as? String, !newName.isEmpty else {
            call.reject("missing name/newName")
            return
        }
        let folder = (call.options["folder"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let parent = folder.isEmpty ? mediaDir : mediaDir.appendingPathComponent(folder)
        let src = parent.appendingPathComponent(name)
        let dst = parent.appendingPathComponent(newName)
        guard FileManager.default.fileExists(atPath: src.path) else {
            call.reject("not found: \(name)")
            return
        }
        do {
            try FileManager.default.moveItem(at: src, to: dst)
            call.resolve(["ok": true])
        } catch {
            call.reject("rename failed: \(error.localizedDescription)")
        }
    }

    /// v1.1.26：移动文件或文件夹到 destFolder（""=根）
    @objc func moveItem(_ call: CAPPluginCall) {
        guard let name = call.options["name"] as? String else {
            call.reject("missing name")
            return
        }
        let folder = (call.options["folder"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let destFolder = (call.options["destFolder"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let src = folder.isEmpty ? mediaDir.appendingPathComponent(name) : mediaDir.appendingPathComponent(folder).appendingPathComponent(name)
        let destParent = destFolder.isEmpty ? mediaDir : mediaDir.appendingPathComponent(destFolder)
        try? FileManager.default.createDirectory(at: destParent, withIntermediateDirectories: true)
        do {
            try FileManager.default.moveItem(at: src, to: destParent.appendingPathComponent(name))
            call.resolve(["ok": true])
        } catch {
            call.reject("move failed: \(error.localizedDescription)")
        }
    }

    /// v1.1.26：复制文件到 destFolder（""=根）
    @objc func copyItem(_ call: CAPPluginCall) {
        guard let name = call.options["name"] as? String else {
            call.reject("missing name")
            return
        }
        let folder = (call.options["folder"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let destFolder = (call.options["destFolder"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let src = folder.isEmpty ? mediaDir.appendingPathComponent(name) : mediaDir.appendingPathComponent(folder).appendingPathComponent(name)
        let destParent = destFolder.isEmpty ? mediaDir : mediaDir.appendingPathComponent(destFolder)
        try? FileManager.default.createDirectory(at: destParent, withIntermediateDirectories: true)
        do {
            try FileManager.default.copyItem(at: src, to: destParent.appendingPathComponent(name))
            call.resolve(["ok": true])
        } catch {
            call.reject("copy failed: \(error.localizedDescription)")
        }
    }

    // MARK: - v1.1.26：屏幕旋转（自动横屏 + 手动 ⟲/⟳）

    /// orientation: portrait | landscapeLeft | landscapeRight
    @objc func setOrientation(_ call: CAPPluginCall) {
        guard let o = call.options["orientation"] as? String else {
            call.reject("missing orientation")
            return
        }
        let mask: UIInterfaceOrientationMask
        switch o {
        case "portrait": mask = .portrait
        case "landscapeLeft": mask = .landscapeLeft
        case "landscapeRight": mask = .landscapeRight
        default:
            call.reject("bad orientation: \(o)")
            return
        }
        // v1.1.27：.ips 实锤 requestGeometryUpdate 从 Capacitor bridge 的后台队列调用时
        // 抛 NSException（UIApplication 断言主线程）→ 未捕获 → SIGABRT。
        // 一律切主线程执行，并用 ObjC++ 异常护栏兜底（场景状态异常时只丢这次请求不闪退）。
        DispatchQueue.main.async {
            Log.write("setOrientation \(o)（主线程）")
            var done = false
            if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene {
                if #available(iOS 16.0, *) {
                    done = localmedia_runGuarded {
                        scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { err in
                            if let e = err as NSError? { Log.write("requestGeometryUpdate 回调：\(e.localizedDescription)") }
                        }
                    }
                }
            }
            if !done {
                // iOS 14/15 回退（私有 API，仅兜底，同样护栏）
                let dev: UIDeviceOrientation
                switch mask {
                case .landscapeLeft: dev = .landscapeRight
                case .landscapeRight: dev = .landscapeLeft
                default: dev = .portrait
                }
                _ = localmedia_runGuarded {
                    UIDevice.current.setValue(dev, forKey: "orientation")
                }
            }
            call.resolve(["ok": true])
        }
    }

    // MARK: - v1.1.26：NAS（SMB）目录枚举与文件操作
    // v1.1.27 重写：沙盒 App 里 FileManager 直连 smb:// 无权限（v1.1.26 实测 listSMBDir 全部
    // 失败）。改为 connectSMB 经系统「文件」选择器授权一次，拿到 LiveFiles 共享根的安全作用域，
    // 之后所有目录树操作都在这个根上做。

    /// v1.1.27：连接 NAS——弹系统选择器（「文件」App 界面），用户在 NAS 共享里随便选一个
    /// 文件/文件夹即完成授权；从选中 URL 反推共享根并 startAccessing，登记为 smbRoot。
    @objc func connectSMB(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let host = call.options["host"] as? String ?? ""
            Log.write("connectSMB 开始 host=\(host)（系统选择器授权）")
            guard !host.isEmpty else {
                call.reject("missing host")
                return
            }
            guard let anchor = self.presentingAnchor() else {
                call.reject("no presentation anchor")
                return
            }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: Self.smbPickTypes, asCopy: false)
            picker.delegate = self
            self.bridge?.saveCall(call)
            self.pendingSMBConnectId = call.callbackId
            anchor.present(picker, animated: true)
        }
    }

    /// 从 LiveFiles URL 反推 NAS 共享根（…/com.apple.filesystems.smbclientd/<挂载>/）
    private static func smbRootFromLiveFilesURL(_ url: URL) -> URL? {
        let comps = url.pathComponents
        guard let i = comps.firstIndex(of: "com.apple.filesystems.smbclientd"), i + 1 < comps.count else {
            return nil
        }
        let rootPath = "/" + comps[1...(i + 1)].joined(separator: "/")
        return URL(fileURLWithPath: rootPath)
    }

    private func smbBaseURL(host: String, port: String, share: String) -> URL? {
        var h = host.trimmingCharacters(in: .whitespaces)
        if !port.isEmpty && port != "445" { h += ":\(port)" }
        guard let base = URL(string: "smb://\(h)/\(share)") else { return nil }
        return base
    }

    /// 列出 NAS 目录：folders + files（视频/字幕，含大小）。path 为相对共享根的路径。
    @objc func listSMBDir(_ call: CAPPluginCall) {
        guard let cfg = Self.smb2Cfg(call.options),
              let share = call.options["share"] as? String else {
            call.reject("missing host/share")
            return
        }
        let rel = (call.options["path"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        Log.write("listSMBDir \(cfg.host)/\(share) \(rel)")
        do {
            let entries = try SMB2Client.list(cfg: cfg, share: share, path: rel)
            var folders: [String] = []
            var files: [[String: Any]] = []
            for e in entries {
                if e.isDirectory { folders.append(e.name); continue }
                let ext = (e.name as NSString).pathExtension.lowercased()
                guard Self.videoExts.contains(ext) || Self.subtitleExts.contains(ext) else { continue }
                files.append(["name": e.name, "size": Int(e.endOf), "kind": Self.subtitleExts.contains(ext) ? "subtitle" : "video"])
            }
            folders.sort { $0.localizedStandardCompare($1) == .orderedAscending }
            files.sort { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
            call.resolve(["folders": folders, "files": files])
        } catch {
            call.reject("smb list failed: \(error.localizedDescription)")
        }
    }

    @objc func createSMBFolder(_ call: CAPPluginCall) {
        guard let cfg = Self.smb2Cfg(call.options),
              let share = call.options["share"] as? String,
              let name = call.options["name"] as? String, !name.isEmpty else {
            call.reject("missing host/share/name")
            return
        }
        let rel = (call.options["path"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        do { try SMB2Client.createDirectory(cfg: cfg, share: share, path: rel, name: name); call.resolve(["ok": true]) }
        catch { call.reject("create smb folder failed: \(error.localizedDescription)") }
    }

    @objc func renameSMBItem(_ call: CAPPluginCall) {
        guard let cfg = Self.smb2Cfg(call.options),
              let share = call.options["share"] as? String,
              let name = call.options["name"] as? String,
              let newName = call.options["newName"] as? String, !newName.isEmpty else {
            call.reject("missing host/share/name/newName")
            return
        }
        let rel = (call.options["path"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        do { try SMB2Client.rename(cfg: cfg, share: share, path: rel, name: name, newName: newName); call.resolve(["ok": true]) }
        catch { call.reject("rename smb item failed: \(error.localizedDescription)") }
    }

    @objc func moveSMBItem(_ call: CAPPluginCall) {
        guard let cfg = Self.smb2Cfg(call.options),
              let share = call.options["share"] as? String,
              let name = call.options["name"] as? String else {
            call.reject("missing host/share/name")
            return
        }
        let rel = (call.options["path"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let destRel = (call.options["destPath"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        do { try SMB2Client.move(cfg: cfg, share: share, srcPath: rel, name: name, destPath: destRel); call.resolve(["ok": true]) }
        catch { call.reject("move smb item failed: \(error.localizedDescription)") }
    }

    @objc func copySMBItem(_ call: CAPPluginCall) {
        guard let cfg = Self.smb2Cfg(call.options),
              let share = call.options["share"] as? String,
              let name = call.options["name"] as? String else {
            call.reject("missing host/share/name")
            return
        }
        let rel = (call.options["path"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let destRel = (call.options["destPath"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        do { try SMB2Client.copy(cfg: cfg, share: share, srcPath: rel, name: name, destPath: destRel); call.resolve(["ok": true]) }
        catch { call.reject("copy smb item failed: \(error.localizedDescription)") }
    }

    @objc func deleteSMBItem(_ call: CAPPluginCall) {
        guard let cfg = Self.smb2Cfg(call.options),
              let share = call.options["share"] as? String,
              let name = call.options["name"] as? String else {
            call.reject("missing host/share/name")
            return
        }
        let rel = (call.options["path"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        do { try SMB2Client.remove(cfg: cfg, share: share, path: rel, name: name); call.resolve(["ok": true]) }
        catch { call.reject("delete smb item failed: \(error.localizedDescription)") }
    }

    /// v1.1.28：内置 SMB2 客户端直连打开视频，无需系统选择器授权。
    /// 打开持久流登记进 smb2Streams，返回 localmedia URL（key 前缀 smb2:），
    /// scheme handler 从该流按 Range 偏移读取。
    @objc func openSMBFile(_ call: CAPPluginCall) {
        guard let cfg = Self.smb2Cfg(call.options),
              let share = call.options["share"] as? String,
              let name = call.options["name"] as? String else {
            call.reject("missing host/share/name")
            return
        }
        let rel = (call.options["path"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let key = "smb2:\(cfg.host)|\(cfg.port)|\(share)|" + (rel.isEmpty ? "" : rel + "/") + name
        if let existing = Self.smb2Streams[key] {
            let size = Self.smb2Sizes[key] ?? Int64(existing.endOf)
            call.resolve(["name": key, "size": size, "url": "localmedia:///smb2%2F\(key.addingPercentEncoding(withAllowedCharacters: CharacterSet.urlPathAllowed) ?? key)"])
            return
        }
        do {
            let stream = try SMB2Stream(cfg: cfg, share: share, path: rel, name: name)
            Self.smb2Streams[key] = stream
            Self.smb2Sizes[key] = Int64(stream.endOf)
            Log.write("openSMBFile 登记 \(key)（\(stream.endOf) bytes，SMB2 直连）")
            call.resolve(["name": key, "size": Int64(stream.endOf), "url": "localmedia:///smb2%2F\(key.addingPercentEncoding(withAllowedCharacters: CharacterSet.urlPathAllowed) ?? key)"])
        } catch {
            call.reject("open smb file failed: \(error.localizedDescription)")
        }
    }

    // MARK: - FFmpeg 原生播放（v1.1.31）

    /// 依据 URL 构造 FFmpegDataSource（smb2: / localmedia:// / file://）
    private func makeFFSource(url: String) -> FFmpegDataSource? {
        if url.hasPrefix("smb2:") {
            let key = url
            guard let stream = Self.smb2Streams[key] else {
                Log.write("playNative smb2 流不存在: \(key)")
                return nil
            }
            return FFmpegDataSource(endOf: Int64(stream.endOf)) { off, buf, n in
                let d = stream.read(offset: off, length: n)
                if d.isEmpty { return 0 }
                buf.update(from: (d as NSData).bytes.assumingMemoryBound(to: UInt8.self), count: d.count)
                return d.count
            }
        }
        if url.hasPrefix("localmedia:///") || url.hasPrefix("file://") {
            let raw = url.hasPrefix("localmedia:///") ? String(url.dropFirst("localmedia:///".count)) : String(url.dropFirst("file://".count))
            let decoded = raw.removingPercentEncoding ?? raw
            let path = url.hasPrefix("localmedia:///") ? mediaDir.appendingPathComponent(decoded) : URL(fileURLWithPath: decoded)
            guard let fh = try? FileHandle(forReadingFrom: path) else { return nil }
            let size = (try? fh.seekToEnd()) ?? 0
            return FFmpegDataSource(endOf: Int64(size)) { off, buf, n in
                _ = try? fh.seek(toFileOffset: UInt64(max(0, off)))
                let d = (try? fh.readData(ofLength: n)) ?? Data()
                if d.isEmpty { return 0 }
                buf.update(from: (d as NSData).bytes.assumingMemoryBound(to: UInt8.self), count: d.count)
                return d.count
            }
        }
        return nil
    }

    @objc func playNative(_ call: CAPPluginCall) {
        guard let url = call.getString("url") else { call.reject("no url"); return }
        let title = call.getString("title") ?? url
        var subs: [FFmpegDataSource] = []
        if let arr = call.options["subs"] as? [[String: Any]] {
            for s in arr { if let su = s["url"] as? String, let d = makeFFSource(url: su) { subs.append(d) } }
        }
        guard let src = makeFFSource(url: url) else {
            call.reject("无法构造数据源: \(url)")
            return
        }
        let nextUrl = call.getString("nextUrl")
        let nextTitle = call.getString("nextTitle")
        let vc = FFmpegPlayerViewController(source: src, title: title, subSources: subs) { [weak self] in
            guard let self, let nu = nextUrl, let nd = self.makeFFSource(url: nu) else { return }
            let nvc = FFmpegPlayerViewController(source: nd, title: nextTitle ?? nu)
            if let anchor = self.presentingAnchor() { anchor.present(nvc, animated: true) }
        }
        guard let anchor = presentingAnchor() else { call.reject("no anchor to present"); return }
        anchor.present(vc, animated: true)
        Log.write("playNative 打开 \(title)")
        call.resolve([:])
    }

    @objc func clearCache(_ call: CAPPluginCall) {
        try? FileManager.default.removeItem(at: mediaDir)
        _ = mediaDir
        call.resolve(["ok": true])
    }

    @objc func captureFrame(_ call: CAPPluginCall) {
        guard let name = call.options["name"] as? String, !name.isEmpty else {
            call.reject("missing name")
            return
        }
        let seconds = (call.options["time"] as? NSNumber)?.doubleValue ?? 1.0
        let fileURL = mediaDir.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            call.reject("file not found: \(name)")
            return
        }
        bridge?.saveCall(call)
        let asset = AVURLAsset(url: fileURL)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 1280, height: 1280)
        let time = CMTime(seconds: max(0, seconds), preferredTimescale: 600)
        generator.generateCGImagesAsynchronously(forTimes: [NSValue(time: time)]) {
            (_ requestedTime: CMTime, image: CGImage?, _ actualTime: CMTime, _ result: AVAssetImageGenerator.Result, _ error: Error?) in
            guard let image else {
                self.resolveSaved(call.callbackId, data: ["error": "frame capture failed"])
                return
            }
            let uiImage = UIImage(cgImage: image, scale: 1, orientation: .up)
            guard let data = uiImage.jpegData(compressionQuality: 0.8) else {
                self.resolveSaved(call.callbackId, data: ["error": "encode failed"])
                return
            }
            self.resolveSaved(call.callbackId, data: ["image": data.base64EncodedString()])
        }
    }

    // MARK: - SMB（系统文件选择器：「文件」App 导航界面进 NAS，点视频即流式播放）

    /// v1.1.12：改回 UIDocumentPickerViewController（asCopy:false 原地读取、不下载）。
    /// 文档浏览器（UIDocumentBrowserViewController）实测弃用：本 iOS 26 环境下它的
    /// delegate 回调（initialURLsForListingIn / previewViewControllerFor / didFailToRead）
    /// 全部从不触发，点文件永远走系统 QuickLook 预览、播不了 smb:// 流。
    /// picker 的 didPickDocumentsAt 是协议必需方法（Swift 自动暴露），自 v1.0.0 起 100% 可靠
    /// （pickMedia 路径）。picker 的导航界面就是「文件」App 的：可进 NAS、逐层进文件夹、选视频（可多选）。
    /// v1.1.0 曾闪退是 present 在后台队列 "bridge" 上调用所致，v1.1.6 起一律主线程 present。
    @objc func browseSMB(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let host = call.options["host"] as? String ?? ""
            let port = (call.options["port"] as? NSNumber)?.stringValue ?? ""
            let share = call.options["share"] as? String ?? ""
            Log.write("browseSMB 开始 host=\(host) port=\(port) share=\(share)（picker 模式）")
            guard !host.isEmpty else {
                Log.write("browseSMB 失败：缺少 host")
                call.reject("missing host")
                return
            }
            guard let anchor = self.presentingAnchor() else {
                Log.write("browseSMB 失败：无展示锚点")
                call.reject("no presentation anchor")
                return
            }
            Log.write("browseSMB 锚点=\(type(of: anchor)) 开始展示系统选择器（主线程，目标共享=\(share)）")
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: Self.smbPickTypes, asCopy: false)
            picker.allowsMultipleSelection = true
            picker.delegate = self
            self.bridge?.saveCall(call)
            self.pendingSMBBrowseId = call.callbackId
            anchor.present(picker, animated: true)
        }
    }

    /// 展示锚点：优先 key window 里最上层的 VC（其 view 一定在 window 里），
    /// 回退到 bridge 的 VC。避免从不在 window 里的 VC 展示导致崩溃。
    private func presentingAnchor() -> UIViewController? {
        let top = Self.topViewController()
        if let top, top.view.window != nil {
            return top
        }
        if let bridgeVC = bridge?.viewController, bridgeVC.view.window != nil {
            return bridgeVC
        }
        return top ?? bridge?.viewController
    }

    @objc func listSMBFiles(_ call: CAPPluginCall) {
        var files: [[String: Any]] = []
        for (name, url) in Self.smbFiles {
            // v1.1.25：优先读缓存，避免 listSMBFiles 时逐个同步 stat NAS
            let size = Self.smbSizes[name] ?? smbFileSize(url)
            files.append(["name": name, "size": size, "kind": Self.smbKinds[name] ?? "video"])
        }
        files.sort { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
        call.resolve(["files": files])
    }

    @objc func releaseSMBFile(_ call: CAPPluginCall) {
        guard let name = call.options["name"] as? String else {
            call.reject("missing name")
            return
        }
        if let url = Self.smbFiles.removeValue(forKey: name) {
            // v1.1.27：授权根（smbRoot）作用域内的子文件不再单独 stopAccessing——
            // 作用域挂在根上，子路径 start/stop 不平衡会破坏根的授权。
            let underRoot = Self.smbRoot.map { url.path.hasPrefix($0.path) } ?? false
            if !underRoot {
                url.stopAccessingSecurityScopedResource()
            }
        }
        Self.smbKinds.removeValue(forKey: name)
        Self.smbSizes.removeValue(forKey: name)
        if let s2 = Self.smb2Streams.removeValue(forKey: name) {
            Self.smb2Sizes.removeValue(forKey: name)
            s2.close()
        }
        call.resolve(["ok": true])
    }

    @objc func saveImageToPhotos(_ call: CAPPluginCall) {
        guard let b64 = call.options["image"] as? String,
              let data = Data(base64Encoded: b64),
              let image = UIImage(data: data) else {
            call.reject("missing or invalid image")
            return
        }
        bridge?.saveCall(call)
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { [weak self] status in
            guard let self else { return }
            if status == .authorized || status == .limited {
                PHPhotoLibrary.shared().performChanges {
                    PHAssetChangeRequest.creationRequestForAsset(from: image)
                } completionHandler: { success, error in
                    if success {
                        self.resolveSaved(call.callbackId, data: ["ok": true])
                    } else {
                        self.rejectSaved(call.callbackId, message: error?.localizedDescription ?? "save failed")
                    }
                }
            } else {
                self.rejectSaved(call.callbackId, message: "photo library permission denied")
            }
        }
    }

    // MARK: - 异步回调辅助

    private func resolveSaved(_ callbackId: String, data: [String: Any?]) {
        bridge?.savedCall(withID: callbackId)?.resolve(data)
    }

    private func rejectSaved(_ callbackId: String, message: String) {
        bridge?.savedCall(withID: callbackId)?.reject(message)
    }

    // MARK: - UIDocumentPickerDelegate

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        Log.write("documentPicker 选中 \(urls.count) 个文件")
        controller.dismiss(animated: true)

        // v1.1.27：connectSMB 授权——从选中 URL 反推 LiveFiles 共享根并 startAccessing
        if let id = pendingSMBConnectId {
            pendingSMBConnectId = nil
            guard let url = urls.first else {
                resolveSaved(id, data: ["ok": false])
                return
            }
            guard let root = Self.smbRootFromLiveFilesURL(url) else {
                rejectSaved(id, message: "请选择 NAS 共享内的任意文件/文件夹（当前选中的不是 SMB 共享内容）")
                return
            }
            let ok = root.startAccessingSecurityScopedResource()
            Log.write("connectSMB 根 \(root.lastPathComponent) startAccessing=\(ok)")
            guard ok else {
                rejectSaved(id, message: "NAS 授权失败，请重试")
                return
            }
            Self.smbRoot = root
            Self.smbRootHost = ""
            // 顺便登记选中的文件（若是视频/字幕），连接完即可直接播放
            var pickedName: String? = nil
            let ext = url.pathExtension.lowercased()
            if Self.videoExts.contains(ext) || Self.subtitleExts.contains(ext) {
                let relParent = String(url.deletingLastPathComponent().path.dropFirst(root.path.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                let key = relParent.isEmpty ? url.lastPathComponent : relParent + "/" + url.lastPathComponent
                Self.smbFiles[key] = url
                Self.smbSizes[key] = smbFileSize(url)
                Self.smbKinds[key] = Self.subtitleExts.contains(ext) ? "subtitle" : "video"
                pickedName = key
                Log.write("connectSMB 顺带登记 \(key)")
            }
            resolveSaved(id, data: ["ok": true, "name": pickedName ?? NSNull()])
            return
        }

        // SMB 流式模式（browseSMB，asCopy:false）：不拷贝，保持安全作用域访问登记进会话表，播放器直接从 NAS 流式读
        if let id = pendingSMBBrowseId {
            pendingSMBBrowseId = nil
            var results: [[String: Any]] = []
            for url in urls {
                let key = uniqueSMBName(url.lastPathComponent)
                url.startAccessingSecurityScopedResource()
                Self.smbFiles[key] = url
                let size = smbFileSize(url)
                Self.smbSizes[key] = size
                let ext = url.pathExtension.lowercased()
                let kind: String
                if Self.subtitleExts.contains(ext) {
                    kind = "subtitle"
                } else if Self.videoExts.contains(ext) {
                    kind = "video"
                } else {
                    kind = "other"
                }
                Self.smbKinds[key] = kind
                Log.write("SMB 登记 \(key) <- \(url)（\(kind)）")
                results.append([
                    "name": key,
                    "size": size,
                    "kind": kind,
                    "url": "localmedia:///smb%2F\(key.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? key)"
                ])
            }
            resolveSaved(id, data: ["files": results])
            Log.write("SMB 回调 JS，\(results.count) 个文件")
            return
        }

        // 普通导入（pickMedia，asCopy:true）：拷贝进 App 缓存目录
        var results: [[String: Any]] = []
        for url in urls {
            let name = url.lastPathComponent
            url.startAccessingSecurityScopedResource()
            let dest = mediaDir.appendingPathComponent(uniqueName(name))
            do {
                try FileManager.default.copyItem(at: url, to: dest)
            } catch {
                url.stopAccessingSecurityScopedResource()
                continue
            }
            url.stopAccessingSecurityScopedResource()
            let size = (try? dest.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            let ext = dest.pathExtension.lowercased()
            results.append([
                "name": dest.lastPathComponent,
                "size": size,
                "kind": Self.subtitleExts.contains(ext) ? "subtitle" : "video",
                "url": "localmedia:///\(dest.lastPathComponent.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? dest.lastPathComponent)"
            ])
        }
        if let id = pendingPickId {
            resolveSaved(id, data: ["files": results])
        }
        pendingPickId = nil
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        Log.write("documentPicker 取消")
        controller.dismiss(animated: true)
        if let id = pendingSMBConnectId {
            pendingSMBConnectId = nil
            rejectSaved(id, message: "已取消连接")
            return
        }
        if let id = pendingSMBBrowseId {
            pendingSMBBrowseId = nil
            resolveSaved(id, data: ["files": []])
            return
        }
        if let id = pendingPickId {
            resolveSaved(id, data: ["files": []])
        }
        pendingPickId = nil
    }

    /// SMB 文件大小：.fileSizeKey 在 SMB 远程文件上可能为 nil。
    /// 注意 .totalFileLengthKey 是 macOS 专用，iOS 上不存在（v1.1.17 云端构建踩坑），
    /// 这里用 FileManager 的 attributesOfItem 兜底，仍取不到就返回 0（=长度未知）。
    private func smbFileSize(_ url: URL) -> Int64 {
        if let v = try? url.resourceValues(forKeys: [.fileSizeKey]), let sz = v.fileSize, sz > 0 {
            return Int64(sz)
        }
        if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
           let sz = (attrs[.size] as? Int).map(Int64.init), sz > 0 {
            return sz
        }
        return 0
    }

    /// SMB 会话表内的唯一名称（同名追加序号）
    private func uniqueSMBName(_ name: String) -> String {
        var candidate = name
        var i = 1
        while Self.smbFiles[candidate] != nil {
            if let dot = name.lastIndex(of: "."), dot > name.index(name.startIndex, offsetBy: 1) {
                candidate = name[..<dot] + " (\(i))" + name[dot...]
            } else {
                candidate = name + " (\(i))"
            }
            i += 1
        }
        return candidate
    }

    // MARK: - WKURLSchemeHandler（localmedia:// 流式读取，支持 Range）

    public func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(Self.error(404, "bad url"))
            return
        }
        let range = urlSchemeTask.request.value(forHTTPHeaderField: "Range") ?? "-"
        Log.write("scheme 请求 \(url.path) range=\(range) method=\(urlSchemeTask.request.httpMethod ?? "GET")")
        // v1.1.19：CORS 预检。带 Range 等"非简单头"的 fetch 会先发 OPTIONS 预检，
        // 响应必须含 Access-Control-Allow-Origin + Allow-Headers，否则 fetch 直接
        // TypeError: Load failed（真机自测第 2 步的失败原因之一）。
        if urlSchemeTask.request.httpMethod == "OPTIONS" {
            let pre = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: Self.corsHeaders())!
            urlSchemeTask.didReceive(pre)
            urlSchemeTask.didReceive(Data())
            urlSchemeTask.didFinish()
            return
        }
        // v1.1.17 修复：Foundation 的 URL.path 不会解码 %2F（只有 iOS 16+ 的
        // path(percentEncoded: false) 才解）。browseSMB 返回的 URL 是单段
        // "smb%2F<文件名>"，不解码的话 hasPrefix("smb/") 永远 false → 落入
        // else 分支去找一个字面叫 "smb%2F<文件名>" 的本地文件 → 404 → 媒体引擎
        // 报 code=4。v1.1.16 交付说明里"url.path 自动把 %2F 解码回 /smb/"的说法
        // 不成立（那是 v1.1.15 旧 URL 形式 localmedia:///smb/<name> 的行为）。
        var path = url.path.replacingOccurrences(of: "%2F", with: "/")
        if path.hasPrefix("/") { path.removeFirst() }
        guard !path.isEmpty else {
            urlSchemeTask.didFailWithError(Self.error(404, "empty path"))
            return
        }
        // v1.1.28：smb2/<key> → 内置 SMB2 直连流（无需系统选择器授权）
        if path.hasPrefix("smb2/") {
            // key 本身含 "smb2:" 前缀且经 percent-encode，解码后才能命中 smb2Streams
            let rawKey = String(path.dropFirst(5))
            let key = rawKey.removingPercentEncoding ?? rawKey
            Log.write("scheme 路由 SMB2 直连流 key=\(key)")
            guard let s2 = Self.smb2Streams[key] else {
                urlSchemeTask.didFailWithError(Self.error(404, "smb2 stream not open: " + key))
                return
            }
            let total = Int64(s2.endOf)
            let namePart = key.split(separator: "|").last.map(String.init) ?? key
            let ext = namePart.split(separator: "/").last.map(String.init).flatMap { ($0 as NSString).pathExtension } ?? ""
            let mime = Self.mimeType(for: ext)
            let rangeHeader = urlSchemeTask.request.value(forHTTPHeaderField: "Range")
            if let rangeHeader, let (start, end) = Self.parseRange(rangeHeader, total: total) {
                var h = Self.corsHeaders()
                h["Content-Type"] = mime
                h["Content-Range"] = "bytes \(start)-\(end)/\(total)"
                h["Accept-Ranges"] = "bytes"
                h["Content-Length"] = "\(end - start + 1)"
                let response = HTTPURLResponse(url: url, statusCode: 206, httpVersion: "HTTP/1.1", headerFields: h)!
                urlSchemeTask.didReceive(response)
                streamSMB2(s2, from: start, length: end - start + 1, task: urlSchemeTask)
            } else {
                let start: Int64 = {
                    if let rangeHeader, let (s, _) = Self.parseRangeOpen(rangeHeader) { return s }
                    return 0
                }()
                var h = Self.corsHeaders()
                h["Content-Type"] = mime
                h["Accept-Ranges"] = "bytes"
                h["Content-Length"] = "\(total)"
                let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: h)!
                urlSchemeTask.didReceive(response)
                streamSMB2(s2, from: start, length: total - start, task: urlSchemeTask)
            }
            return
        }
        // smb/<name> → 会话表里的安全作用域 URL（直接从 NAS 流式读取）
        let smbKey = path.hasPrefix("smb/") ? String(path.dropFirst(4)) : nil
        let fileURL: URL
        if let key = smbKey {
            Log.write("scheme 路由 SMB 会话文件 key=\(key) 现有会话=\(Array(Self.smbFiles.keys))")
            guard let smbURL = Self.smbFiles[key] else {
                urlSchemeTask.didFailWithError(Self.error(404, "smb file not in session: " + key))
                return
            }
            fileURL = smbURL
        } else {
            fileURL = mediaDir.appendingPathComponent(path)
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                urlSchemeTask.didFailWithError(Self.error(404, path))
                return
            }
        }
        // v1.1.17 修复：SMB 流式文件 .fileSizeKey 可能取不到（nil）。
        // 旧代码 total=0 时：200 响应 Content-Length:0（媒体引擎拿到空文件），
        // Range 请求 parseRange 的 start<total 判断全失败 → 也落到 CL:0。
        // 现在 0 表示"长度未知"：响应不带 Content-Length（HTTP 分块传输），
        // 从偏移流读到 EOF，媒体引擎照常边下边播。
        // v1.1.25：SMB 尺寸改读登记时缓存（smbSizes），不再每请求同步 stat NAS——
        // .ips 崩溃时刻主线程正卡在 smbFileSize 的 resourceValues 上。
        let fileSize: Int64 = {
            if let key = smbKey {
                if let cached = Self.smbSizes[key], cached > 0 {
                    return cached
                }
                // 缓存未命中：stat 一次并回填
                let s = smbFileSize(fileURL)
                Self.smbSizes[key] = s
                return s
            }
            // 本地文件：.fileSizeKey 可靠
            if let v = try? fileURL.resourceValues(forKeys: [.fileSizeKey]),
               let sz = v.fileSize, sz > 0 {
                return Int64(sz)
            }
            return 0
        }()
        Log.write("scheme 文件 \(fileURL.lastPathComponent) 总长度=\(fileSize)（0=未知，分块流式）")
        let mime = Self.mimeType(for: fileURL.pathExtension)

        let rangeHeader = urlSchemeTask.request.value(forHTTPHeaderField: "Range")
        if fileSize > 0, let rangeHeader, let (start, end) = Self.parseRange(rangeHeader, total: fileSize) {
            var h = Self.corsHeaders()
            h["Content-Type"] = mime
            h["Content-Range"] = "bytes \(start)-\(end)/\(fileSize)"
            h["Accept-Ranges"] = "bytes"
            h["Content-Length"] = "\(end - start + 1)"
            let response = HTTPURLResponse(url: url, statusCode: 206, httpVersion: "HTTP/1.1", headerFields: h)!
            urlSchemeTask.didReceive(response)
            stream(fileURL, from: start, length: end - start + 1, task: urlSchemeTask)
        } else if fileSize > 0 {
            var h = Self.corsHeaders()
            h["Content-Type"] = mime
            h["Accept-Ranges"] = "bytes"
            h["Content-Length"] = "\(fileSize)"
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: h)!
            urlSchemeTask.didReceive(response)
            stream(fileURL, from: 0, length: fileSize, task: urlSchemeTask)
        } else {
            // 长度未知（SMB 流）：从 Range 起点（或 0）流到 EOF，无 Content-Length
            let start: Int64 = {
                if let rangeHeader, let (s, _) = Self.parseRangeOpen(rangeHeader) { return s }
                return 0
            }()
            var h = Self.corsHeaders()
            h["Content-Type"] = mime
            h["Accept-Ranges"] = "bytes"
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: h)!
            urlSchemeTask.didReceive(response)
            stream(fileURL, from: start, length: -1, task: urlSchemeTask)
        }
    }

    /// v1.1.19：localmedia:// 响应的统一 CORS 头。页面源（file:// 或 capacitor://）与
    /// localmedia:// 不同源，fetch/XHR 必走 CORS 检查；<video> 元素不做 CORS，
    /// 但自测的 fetch 探针与预检需要这些头。
    private static func corsHeaders() -> [String: String] {
        ["Access-Control-Allow-Origin": "*",
         "Access-Control-Allow-Methods": "GET, OPTIONS",
         "Access-Control-Allow-Headers": "range, content-range",
         "Access-Control-Expose-Headers": "content-range, content-length"]
    }

    /// WKURLSchemeTask 没有取消状态属性，用 ObjectIdentifier 集合自行跟踪
    private var cancelledTasks = Set<ObjectIdentifier>()

    public func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        Log.write("scheme 停止 \(urlSchemeTask.request.url?.path ?? "?")")
        cancelledTasks.insert(ObjectIdentifier(urlSchemeTask))
    }

    private func stream(_ fileURL: URL, from start: Int64, length: Int64, task: any WKURLSchemeTask) {
        let taskID = ObjectIdentifier(task)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            guard let handle = try? FileHandle(forReadingFrom: fileURL) else {
                task.didFailWithError(Self.error(500, "open failed"))
                return
            }
            defer {
                try? handle.close()
                self.cancelledTasks.remove(taskID)
            }
            // v1.1.25：整体包进 ObjC 异常护栏。SMB/LiveFiles 读取失败时 FileHandle 的非 throwing
            // 重载抛 NSException（Swift do/catch 接不住）→ 未捕获 → SIGABRT（.ips 实锤：
            // 崩溃栈 closure #1 in stream ← objc_exception_throw）。护栏内任何残留异常都只让
            // 这一次流式请求干净结束，不再拖垮整个 App。
            localmedia_runGuarded {
                do {
                    try handle.seek(toOffset: UInt64(start))
                } catch {
                    task.didFailWithError(Self.error(500, "seek failed"))
                    return
                }
                // length == -1：长度未知，一直流到 EOF（readData 返回空即结束）
                let chunk: Int64 = 256 * 1024
                var remaining = length
                while length < 0 || remaining > 0 {
                    if self.cancelledTasks.contains(taskID) { break }
                    let n = length < 0 ? chunk : min(chunk, remaining)
                    let data: Data
                    do {
                        // v1.1.25：显式 try 选中 throwing 重载——普通读取错误变成 Swift Error，
                        // 走 didFailWithError 干净收尾，而不是 NSException 闪退。
                        data = try handle.readData(ofLength: Int(n))
                    } catch {
                        Log.write("stream 读取失败（转为错误而非崩溃）：\(error.localizedDescription)")
                        task.didFailWithError(Self.error(500, "read failed"))
                        return
                    }
                    // v1.1.25：慢速 SMB 读取期间任务可能已被取消（日志里「scheme 停止」与
                    // 后续请求交替出现就是这种竞态）；取消后再 didReceive 也会抛 NSException，
                    // 所以读完必须再查一次。
                    if self.cancelledTasks.contains(taskID) { break }
                    if data.isEmpty { break }
                    task.didReceive(data)
                    if length >= 0 { remaining -= Int64(data.count) }
                }
                if !self.cancelledTasks.contains(taskID) {
                    task.didFinish()
                }
            }
        }
    }

    /// v1.1.28：从内置 SMB2 流读取。与 stream() 相同的安全模型——后台队列、取消竞态复查、
    /// 异常护栏——只是数据源换成 SMB2Stream.read（走 SMB2 READ 命令而非 FileHandle）。
    private func streamSMB2(_ s2: SMB2Stream, from start: Int64, length: Int64, task: any WKURLSchemeTask) {
        let taskID = ObjectIdentifier(task)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            defer { self.cancelledTasks.remove(taskID) }
            localmedia_runGuarded {
                let chunk: Int64 = 256 * 1024
                var offset = start
                var remaining = length
                while length < 0 || remaining > 0 {
                    if self.cancelledTasks.contains(taskID) { break }
                    let n = length < 0 ? chunk : min(chunk, remaining)
                    let data: [UInt8]
                    do { data = try s2.read(offset: UInt64(offset), length: Int(n)) }
                    catch {
                        Log.write("streamSMB2 读取失败（转为错误而非崩溃）：\(error.localizedDescription)")
                        task.didFailWithError(Self.error(500, "smb2 read failed"))
                        return
                    }
                    if self.cancelledTasks.contains(taskID) { break }
                    if data.isEmpty { break }
                    task.didReceive(Data(data))
                    offset += Int64(data.count)
                    if length >= 0 { remaining -= Int64(data.count) }
                }
                if !self.cancelledTasks.contains(taskID) { task.didFinish() }
            }
        }
    }

    // MARK: - 工具

    private func uniqueName(_ name: String) -> String {
        var candidate = name
        var i = 1
        while FileManager.default.fileExists(atPath: mediaDir.appendingPathComponent(candidate).path) {
            if let dot = name.lastIndex(of: "."), dot > name.index(name.startIndex, offsetBy: 1) {
                candidate = name[..<dot] + " (\(i))" + name[dot...]
            } else {
                candidate = name + " (\(i))"
            }
            i += 1
        }
        return candidate
    }

    private func enumerateFiles() -> [[String: Any]] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: mediaDir,
            includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }
        var out: [[String: Any]] = []
        for url in entries {
            let ext = url.pathExtension.lowercased()
            let isSubtitle = Self.subtitleExts.contains(ext)
            let isVideo = Self.videoExts.contains(ext)
            guard isVideo || isSubtitle else { continue }
            let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            out.append([
                "name": url.lastPathComponent,
                "size": values?.fileSize ?? 0,
                "kind": isSubtitle ? "subtitle" : "video",
                "modifiedAt": (values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000
            ])
        }
        out.sort { ($0["modifiedAt"] as? Double ?? 0) > ($1["modifiedAt"] as? Double ?? 0) }
        return out
    }

    /// 只解析 Range 头的起始偏移（用于长度未知时的流式起点），不做 total 校验
    private static func parseRangeOpen(_ header: String) -> (Int64, Int64)? {
        let parts = header.components(separatedBy: "=")
        guard parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces) == "bytes" else { return nil }
        let bounds = parts[1].trimmingCharacters(in: .whitespaces).components(separatedBy: "-")
        guard bounds.count == 2, !bounds[0].isEmpty, let start = Int64(bounds[0]), start >= 0 else { return nil }
        let end = bounds[1].isEmpty ? -1 : (Int64(bounds[1]) ?? -1)
        return (start, end)
    }

    private static func parseRange(_ header: String, total: Int64) -> (Int64, Int64)? {
        let parts = header.components(separatedBy: "=")
        guard parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces) == "bytes" else { return nil }
        let range = parts[1].trimmingCharacters(in: .whitespaces)
        let bounds = range.components(separatedBy: "-")
        guard bounds.count == 2 else { return nil }
        if bounds[0].isEmpty {
            guard let suffix = Int64(bounds[1]), suffix > 0 else { return nil }
            return (max(0, total - suffix), total - 1)
        }
        guard let start = Int64(bounds[0]), start >= 0, start < total else { return nil }
        let end = bounds[1].isEmpty ? total - 1 : min(Int64(bounds[1]) ?? total - 1, total - 1)
        guard end >= start else { return nil }
        return (start, end)
    }

    private static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "mp4", "m4v": return "video/mp4"
        case "mov": return "video/quicktime"
        case "webm": return "video/webm"
        case "mkv": return "video/x-matroska"
        case "avi": return "video/x-msvideo"
        case "rmvb", "rm": return "video/rmvb"
        case "wmv": return "video/x-ms-wmv"
        case "ts": return "video/mp2t"
        case "3gp": return "video/3gpp"
        case "mpg", "mpeg": return "video/mpeg"
        case "srt", "ass", "ssa", "sub": return "text/plain"
        default: return "application/octet-stream"
        }
    }

    private static func error(_ code: Int, _ message: String) -> NSError {
        NSError(domain: "localmedia", code: code, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private static func topViewController() -> UIViewController? {
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first else {
            return nil
        }
        var vc = window.rootViewController
        while let presented = vc?.presentedViewController {
            vc = presented
        }
        return vc
    }
}
