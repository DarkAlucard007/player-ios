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
        CAPPluginMethod(name: "selfTest", returnType: CAPPluginReturnPromise)
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

    /// SMB 会话文件：名称 → 安全作用域 URL（保持 startAccessing 直到 release）
    private var smbFiles: [String: URL] = [:]
    /// SMB 会话文件的类型（video/subtitle/other），listSMBFiles 时回传，前端据此区分
    private var smbKinds: [String: String] = [:]

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
        for (name, url) in smbFiles {
            let size = smbFileSize(url)
            files.append(["name": name, "size": size, "kind": smbKinds[name] ?? "video"])
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
        smbKinds.removeValue(forKey: name)
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

        // SMB 流式模式（browseSMB，asCopy:false）：不拷贝，保持安全作用域访问登记进会话表，播放器直接从 NAS 流式读
        if let id = pendingSMBBrowseId {
            pendingSMBBrowseId = nil
            var results: [[String: Any]] = []
            for url in urls {
                let key = uniqueSMBName(url.lastPathComponent)
                url.startAccessingSecurityScopedResource()
                smbFiles[key] = url
                let size = smbFileSize(url)
                let ext = url.pathExtension.lowercased()
                let kind: String
                if Self.subtitleExts.contains(ext) {
                    kind = "subtitle"
                } else if Self.videoExts.contains(ext) {
                    kind = "video"
                } else {
                    kind = "other"
                }
                smbKinds[key] = kind
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

    /// SMB 文件大小：.fileSizeKey 在 SMB 远程文件上可能为 nil，兜底 .totalFileLengthKey
    private func smbFileSize(_ url: URL) -> Int64 {
        if let v = try? url.resourceValues(forKeys: [.fileSizeKey, .totalFileLengthKey]) {
            return Int64(v.fileSize ?? v.totalFileLength ?? 0)
        }
        return 0
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
        // smb/<name> → 会话表里的安全作用域 URL（直接从 NAS 流式读取）
        let fileURL: URL
        if path.hasPrefix("smb/") {
            let key = String(path.dropFirst(4))
            Log.write("scheme 路由 SMB 会话文件 key=\(key) 现有会话=\(Array(smbFiles.keys))")
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
        // v1.1.17 修复：SMB 流式文件 .fileSizeKey 可能取不到（nil）。
        // 旧代码 total=0 时：200 响应 Content-Length:0（媒体引擎拿到空文件），
        // Range 请求 parseRange 的 start<total 判断全失败 → 也落到 CL:0。
        // 现在 0 表示"长度未知"：响应不带 Content-Length（HTTP 分块传输），
        // 从偏移流读到 EOF，媒体引擎照常边下边播。
        let fileSize: Int64 = {
            if let v = try? fileURL.resourceValues(forKeys: [.fileSizeKey, .totalFileLengthKey]),
               let sz = Int64(v.fileSize ?? v.totalFileLength ?? 0), sz > 0 {
                return sz
            }
            return 0
        }()
        Log.write("scheme 文件 \(fileURL.lastPathComponent) 总长度=\(fileSize)（0=未知，分块流式）")
        let mime = Self.mimeType(for: fileURL.pathExtension)

        let rangeHeader = urlSchemeTask.request.value(forHTTPHeaderField: "Range")
        if fileSize > 0, let rangeHeader, let (start, end) = Self.parseRange(rangeHeader, total: fileSize) {
            let response = HTTPURLResponse(url: url, statusCode: 206, httpVersion: "HTTP/1.1", headerFields: [
                "Content-Type": mime,
                "Content-Range": "bytes \(start)-\(end)/\(fileSize)",
                "Accept-Ranges": "bytes",
                "Content-Length": "\(end - start + 1)",
                "Access-Control-Allow-Origin": "*"
            ])!
            urlSchemeTask.didReceive(response)
            stream(fileURL, from: start, length: end - start + 1, task: urlSchemeTask)
        } else if fileSize > 0 {
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
                "Content-Type": mime,
                "Accept-Ranges": "bytes",
                "Content-Length": "\(fileSize)",
                "Access-Control-Allow-Origin": "*"
            ])!
            urlSchemeTask.didReceive(response)
            stream(fileURL, from: 0, length: fileSize, task: urlSchemeTask)
        } else {
            // 长度未知（SMB 流）：从 Range 起点（或 0）流到 EOF，无 Content-Length
            let start: Int64 = {
                if let rangeHeader, let (s, _) = Self.parseRangeOpen(rangeHeader) { return s }
                return 0
            }()
            let headers: [String: String] = [
                "Content-Type": mime,
                "Accept-Ranges": "bytes",
                "Access-Control-Allow-Origin": "*"
            ]
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
            urlSchemeTask.didReceive(response)
            stream(fileURL, from: start, length: -1, task: urlSchemeTask)
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
            // length == -1：长度未知，一直流到 EOF（readData 返回空即结束）
            let chunk: Int64 = 256 * 1024
            var remaining = length
            while (length < 0 || remaining > 0) && !self.cancelledTasks.contains(taskID) {
                let n = length < 0 ? chunk : min(chunk, remaining)
                let data = handle.readData(ofLength: Int(n))
                if data.isEmpty { break }
                task.didReceive(data)
                if length >= 0 { remaining -= Int64(data.count) }
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
