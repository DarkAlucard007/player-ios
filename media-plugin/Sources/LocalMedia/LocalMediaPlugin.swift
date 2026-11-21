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

@objc(LocalMediaPlugin)
public class LocalMediaPlugin: CAPPlugin, CAPBridgedPlugin, WKURLSchemeHandler, UIDocumentPickerDelegate, UIDocumentBrowserViewControllerDelegate {

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
        CAPPluginMethod(name: "testBrowserLocal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listSMBFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseSMBFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readLog", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearLog", returnType: CAPPluginReturnPromise)
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
    }

    // MARK: - 存储

    private static let scheme = "localmedia"
    private static let videoExts: Set<String> = [
        "mp4", "m4v", "mov", "mkv", "avi", "webm", "rmvb", "rm", "wmv", "ts", "flv", "3gp", "mpg", "mpeg"
    ]
    private static let subtitleExts: Set<String> = ["srt", "ass", "ssa", "sub"]

    private var mediaDir: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("localmedia", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// pickMedia 的异步回调 id（文件选择器回调时再取回 call）
    private var pendingPickId: String?

    /// browseSMB 的异步回调 id
    private var pendingSMBBrowseId: String?

    /// 当前展示的文档浏览器（用于点中视频后整体关闭）
    private var smbBrowser: UIDocumentBrowserViewController?

    /// 本次浏览要直连的共享目录（smb://host[:port]/share）
    private var smbRootURL: URL?

    /// 测试模式：文档浏览器打开本地目录（不碰 SMB），用于二分定位崩溃源
    private var smbTestMode = false

    /// SMB 会话文件：名称 → 安全作用域 URL（保持 startAccessing 直到 release）
    private var smbFiles: [String: URL] = [:]

    @objc func readLog(_ call: CAPPluginCall) {
        call.resolve(["log": Log.tail(400)])
    }

    @objc func clearLog(_ call: CAPPluginCall) {
        Log.write("---- 日志已清空 ----")
        call.resolve(["ok": true])
    }

    // MARK: - 注册 URL scheme 处理器

    public override func load() {
        Log.write("load() 插件初始化")
        bridge?.webView?.configuration.setURLSchemeHandler(self, forURLScheme: Self.scheme)
        Log.write("load() localmedia:// scheme handler 已注册")
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

    @objc func listFiles(_ call: CAPPluginCall) {
        call.resolve(["files": enumerateFiles()])
    }

    @objc func deleteFile(_ call: CAPPluginCall) {
        guard let name = call.options["name"] as? String, !name.isEmpty else {
            call.reject("missing name")
            return
        }
        try? FileManager.default.removeItem(at: mediaDir.appendingPathComponent(name))
        call.resolve(["ok": true])
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

    // MARK: - SMB（系统文档浏览器：进入 NAS 目录树浏览，点中视频即流式播放）

    @objc func browseSMB(_ call: CAPPluginCall) {
        // 同 pickMedia：插件方法在 Capacitor 后台队列 "bridge" 上执行，present 必须切主线程
        DispatchQueue.main.async {
            let host = call.options["host"] as? String ?? ""
            let port = (call.options["port"] as? NSNumber)?.stringValue ?? ""
            let share = call.options["share"] as? String ?? ""
            Log.write("browseSMB 开始 host=\(host) port=\(port) share=\(share)")
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
            guard !share.isEmpty else {
                Log.write("browseSMB 失败：共享文件夹名为空")
                call.reject("missing share（请在添加源时填写共享文件夹名，例如 video）")
                return
            }
            // v1.1.7：直连服务器根 smb://host[:port]（先列共享）。
            // 深层 smb://host/share 在 SMB 会话未建立时解析为空列表且不报错；
            // 先进根目录列出共享（同「文件」App 的路径）会激活会话，用户点共享名即进入。
            var urlString = "smb://" + host
            if !port.isEmpty, let p = Int(port), p > 0 { urlString += ":" + String(p) }
            guard let smbURL = URL(string: urlString) else {
                call.reject("bad smb url: \(urlString)")
                return
            }
            self.smbRootURL = smbURL
            Log.write("browseSMB 锚点=\(type(of: anchor))，直连服务器根 \(urlString)（主线程，目标共享=\(share)）")
            let browser = UIDocumentBrowserViewController()
            browser.delegate = self
            // 创建/删除/重命名/移动默认都是 false，正好只要「浏览 + 打开」
            self.smbBrowser = browser
            self.bridge?.saveCall(call)
            self.pendingSMBBrowseId = call.callbackId
            Log.write("browseSMB 调用 present(animated:) …")
            anchor.present(browser, animated: true)
            Log.write("browseSMB present 返回，浏览器已展示（若下一步日志出现 documentBrowser 直连 smb://… 说明回调已通）")
        }
    }

    /// 诊断用：文档浏览器打开 App 自己的本地目录（完全不碰 SMB）。
    /// v1.1.6 起 present 已切主线程，此按钮应能正常弹出（不再闪退），可用于验证文档浏览器整体可用。
    @objc func testBrowserLocal(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            Log.write("testBrowserLocal 开始（本地目录，无 SMB）")
            guard let anchor = self.presentingAnchor() else {
                call.reject("no presentation anchor")
                return
            }
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            self.smbRootURL = docs
            self.smbTestMode = true
            Log.write("testBrowserLocal 锚点=\(type(of: anchor))，直连 \(docs.path)（主线程）")
            let browser = UIDocumentBrowserViewController()
            browser.delegate = self
            self.smbBrowser = browser
            self.bridge?.saveCall(call)
            self.pendingSMBBrowseId = call.callbackId
            anchor.present(browser, animated: true)
            Log.write("testBrowserLocal present 返回")
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
        for (name, url) in smbFiles {
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            files.append(["name": name, "size": size, "kind": "video"])
        }
        files.sort { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
        call.resolve(["files": files])
    }

    @objc func releaseSMBFile(_ call: CAPPluginCall) {
        guard let name = call.options["name"] as? String else {
            call.reject("missing name")
            return
        }
        if let url = smbFiles.removeValue(forKey: name) {
            url.stopAccessingSecurityScopedResource()
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

        // 普通导入：拷贝进 App 缓存目录
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
        if let id = pendingPickId {
            resolveSaved(id, data: ["files": []])
        }
        pendingPickId = nil
    }

    // MARK: - UIDocumentBrowserDelegate（SMB 目录浏览）

    /// 首次进入：直接给出 smb:// 服务器根（列共享）或本地测试目录，不枚举全部位置。
    /// v1.1.8：@objc 必须——协议是 ObjC 的，缺 @objc 时运行时找不到此回调，浏览器显示默认本地位置
    @objc public func documentBrowser(_ controller: UIDocumentBrowserViewController,
                                      initialURLsForListingIn bookmarkData: Data,
                                      completionHandler: @escaping ([URL]?, Error?) -> Void) {
        if let root = smbRootURL {
            Log.write("documentBrowser 直连 \(root)")
            completionHandler([root], nil)
        } else {
            Log.write("documentBrowser 无直连地址，回退显示全部位置")
            completionHandler(nil, nil)
        }
    }

    /// 读取目录失败（smb:// 不被识别 / 认证失败 / 网络不通）→ 通知 JS 显示指引（v1.1.8 加 @objc）
    @objc public func documentBrowser(_ controller: UIDocumentBrowserViewController,
                                      didFailToReadDirectoryContentsOf url: URL,
                                      withError error: Error) {
        Log.write("documentBrowser 读目录失败 \(url) error=\(error.localizedDescription)")
        controller.dismiss(animated: true)
        if let id = pendingSMBBrowseId {
            resolveSaved(id, data: ["files": [], "error": error.localizedDescription])
            pendingSMBBrowseId = nil
        }
        smbBrowser = nil
        smbRootURL = nil
    }

    /// 点中文件 → 返回预览页（视频显示「播放」按钮，点一下就登记并播放）。
    /// v1.1.8：改用同步版 @objc 代理方法——异步版 (async -> (VC?, Error?)) 无法被 ObjC 运行时发现，
    /// 缺 @objc 的代理回调全部静默失效，导致浏览器显示默认本地位置、点中文件走系统 QuickLook。
    @objc public func documentBrowser(_ controller: UIDocumentBrowserViewController,
                                      previewViewControllerFor url: URL) -> UIViewController? {
        if smbTestMode {
            Log.write("documentBrowser [测试模式] 点中本地文件 \(url.lastPathComponent)（仅日志，不播放）")
            return nil
        }
        Log.write("documentBrowser 点中文件 \(url.lastPathComponent)")
        // 无扩展名的条目（如点中共享名本身）返回 nil → 浏览器直接钻进目录，不弹预览
        if url.pathExtension.isEmpty {
            Log.write("documentBrowser 目录项，进入 \(url)")
            return nil
        }
        let isVideo = Self.videoExts.contains(url.pathExtension.lowercased())
        return SMBPreviewViewController(fileName: url.lastPathComponent, isVideo: isVideo) { [weak self] in
            self?.registerSMBFileAndFinish(url)
        }
    }

    /// 登记 SMB 文件（保持安全作用域访问）→ 关闭浏览器 → 回调 JS
    private func registerSMBFileAndFinish(_ url: URL) {
        Log.write("registerSMBFileAndFinish \(url.lastPathComponent)")
        let key = uniqueSMBName(url.lastPathComponent)
        url.startAccessingSecurityScopedResource()
        smbFiles[key] = url
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        let file: [String: Any] = [
            "name": key,
            "size": size,
            "kind": "video",
            "url": "localmedia://smb/\(key.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? key)"
        ]
        smbBrowser?.dismiss(animated: true) { [weak self] in
            guard let self else { return }
            if let id = self.pendingSMBBrowseId {
                self.resolveSaved(id, data: ["files": [file]])
                self.pendingSMBBrowseId = nil
            }
            self.smbBrowser = nil
            Log.write("registerSMBFileAndFinish 浏览器已关闭，回调 JS")
        }
    }

    /// SMB 会话表内的唯一名称（同名追加序号）
    private func uniqueSMBName(_ name: String) -> String {
        var candidate = name
        var i = 1
        while smbFiles[candidate] != nil {
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
        Log.write("scheme 请求 \(url.path) range=\(range)")
        var path = url.path
        if path.hasPrefix("/") { path.removeFirst() }
        guard !path.isEmpty else {
            urlSchemeTask.didFailWithError(Self.error(404, "empty path"))
            return
        }
        // smb/<name> → 会话表里的安全作用域 URL（直接从 NAS 流式读取）
        let fileURL: URL
        if path.hasPrefix("smb/") {
            let key = String(path.dropFirst(4))
            guard let smbURL = smbFiles[key] else {
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
        let fileSize = Int64((try? fileURL.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
        let mime = Self.mimeType(for: fileURL.pathExtension)

        if let rangeHeader = urlSchemeTask.request.value(forHTTPHeaderField: "Range"),
           let (start, end) = Self.parseRange(rangeHeader, total: fileSize) {
            let response = HTTPURLResponse(url: url, statusCode: 206, httpVersion: "HTTP/1.1", headerFields: [
                "Content-Type": mime,
                "Content-Range": "bytes \(start)-\(end)/\(fileSize)",
                "Accept-Ranges": "bytes",
                "Content-Length": "\(end - start + 1)",
                "Access-Control-Allow-Origin": "*"
            ])!
            urlSchemeTask.didReceive(response)
            stream(fileURL, from: start, length: end - start + 1, task: urlSchemeTask)
        } else {
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
                "Content-Type": mime,
                "Accept-Ranges": "bytes",
                "Content-Length": "\(fileSize)",
                "Access-Control-Allow-Origin": "*"
            ])!
            urlSchemeTask.didReceive(response)
            stream(fileURL, from: 0, length: fileSize, task: urlSchemeTask)
        }
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
            do {
                try handle.seek(toOffset: UInt64(start))
            } catch {
                task.didFailWithError(Self.error(500, "seek failed"))
                return
            }
            let chunk: Int64 = 256 * 1024
            var remaining = length
            while remaining > 0 && !self.cancelledTasks.contains(taskID) {
                let n = min(chunk, remaining)
                let data = handle.readData(ofLength: Int(n))
                if data.isEmpty { break }
                task.didReceive(data)
                remaining -= Int64(data.count)
            }
            if !self.cancelledTasks.contains(taskID) {
                task.didFinish()
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

/// SMB 文件预览页：视频显示「播放」按钮，非视频显示提示
private final class SMBPreviewViewController: UIViewController {
    private let fileName: String
    private let isVideo: Bool
    private let onPlay: () -> Void

    init(fileName: String, isVideo: Bool, onPlay: @escaping () -> Void) {
        self.fileName = fileName
        self.isVideo = isVideo
        self.onPlay = onPlay
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        modalPresentationStyle = .fullScreen

        let icon = UILabel()
        icon.text = isVideo ? "🎬" : "📄"
        icon.font = .systemFont(ofSize: 56)
        icon.textAlignment = .center
        icon.translatesAutoresizingMaskIntoConstraints = false

        let name = UILabel()
        name.text = fileName
        name.font = .systemFont(ofSize: 17, weight: .medium)
        name.textColor = .white
        name.textAlignment = .center
        name.numberOfLines = 0
        name.translatesAutoresizingMaskIntoConstraints = false

        let sub = UILabel()
        sub.text = isVideo ? "点下方按钮，直接从 NAS 流式播放" : "不是视频文件"
        sub.font = .systemFont(ofSize: 13)
        sub.textColor = .gray
        sub.textAlignment = .center
        sub.translatesAutoresizingMaskIntoConstraints = false

        let stack = UIStackView(arrangedSubviews: [icon, name, sub])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        let btnTitle = isVideo ? "▶  播放这个视频" : "关闭"
        let btn = UIButton(type: .system)
        btn.setTitle(btnTitle, for: .normal)
        btn.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        btn.backgroundColor = isVideo ? .systemBlue : .darkGray
        btn.setTitleColor(.white, for: .normal)
        btn.layer.cornerRadius = 12
        btn.translatesAutoresizingMaskIntoConstraints = false
        btn.addAction(UIAction { [weak self] _ in
            if self?.isVideo == true { self?.onPlay() }
            else { self?.dismiss(animated: true) }
        }, for: .touchUpInside)
        view.addSubview(btn)

        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -40),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -32),
            btn.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            btn.topAnchor.constraint(equalTo: stack.bottomAnchor, constant: 36),
            btn.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 32),
            btn.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -32),
            btn.heightAnchor.constraint(equalToConstant: 50)
        ])
    }
}
