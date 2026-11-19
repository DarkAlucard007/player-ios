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
        CAPPluginMethod(name: "saveImageToPhotos", returnType: CAPPluginReturnPromise)
    ]

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

    // MARK: - 注册 URL scheme 处理器

    public override func load() {
        bridge?.webView?.configuration.setURLSchemeHandler(self, forURLScheme: Self.scheme)
    }

    // MARK: - Actions

    @objc func pickMedia(_ call: CAPPluginCall) {
        let allowSubtitles = (call.options["subtitles"] as? NSNumber)?.boolValue ?? false
        guard let anchor = bridge?.viewController ?? Self.topViewController() else {
            call.reject("no presentation anchor")
            return
        }
        var types: [UTType] = [.movie, .video, .mpeg4Movie, .quickTimeMovie]
        if allowSubtitles {
            types.append(contentsOf: [.plainText, .utf8PlainText, .item])
        }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
        picker.allowsMultipleSelection = true
        picker.delegate = self
        bridge?.saveCall(call)
        pendingPickId = call.callbackId
        anchor.present(picker, animated: true)
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
        controller.dismiss(animated: true)
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
        controller.dismiss(animated: true)
        if let id = pendingPickId {
            resolveSaved(id, data: ["files": []])
        }
        pendingPickId = nil
    }

    // MARK: - WKURLSchemeHandler（localmedia:// 流式读取，支持 Range）

    public func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(Self.error(404, "bad url"))
            return
        }
        var path = url.path
        if path.hasPrefix("/") { path.removeFirst() }
        guard !path.isEmpty else {
            urlSchemeTask.didFailWithError(Self.error(404, "empty path"))
            return
        }
        let fileURL = mediaDir.appendingPathComponent(path)
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            urlSchemeTask.didFailWithError(Self.error(404, path))
            return
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
