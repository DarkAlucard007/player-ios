// v1.1.12: SMB 从文档浏览器改回 picker（asCopy:false 流式）。锚点校验 + 行号 splice。
const fs = require('fs');
const p = 'F:/DSH/苹果应用/01视频播放器/player/media-plugin/Sources/LocalMedia/LocalMediaPlugin.swift';
let lines = fs.readFileSync(p, 'utf8').split('\n');

function assert(idx, mustContain, label) {
  const line = lines[idx];
  if (!line || !line.includes(mustContain)) {
    console.error(`ANCHOR FAIL ${label}: line ${idx + 1} = ${JSON.stringify(line)}`);
    process.exit(1);
  }
  console.log(`ok ${label}: L${idx + 1}`);
}

// ---- 锚点校验（1-based 行号 → 0-based idx）----
assert(18, 'UIDocumentBrowserViewControllerDelegate {', '类声明 L19');
assert(32, 'testBrowserLocal', 'pluginMethods L33');
assert(84, 'browseContentTypes', 'browseContentTypes L85');
assert(97, 'pendingSMBBrowseId', '属性 L98');
assert(100, 'smbBrowser', '属性 L101');
assert(103, 'smbRootURL', '属性 L104');
assert(106, 'smbTestMode', '属性 L107');
assert(208, 'MARK: - SMB（系统文档浏览器', 'browseSMB 段 L209');
assert(279, 'testBrowserLocal present 返回', 'testBrowserLocal 日志行 L280');
assert(281, '    }', 'testBrowserLocal 末行 L282');
assert(355, 'didPickDocumentsAt urls', 'didPick L356');
assert(393, 'pendingPickId = nil', 'wasCancelled 清空行 L394');
assert(394, '    }', 'wasCancelled 末行 L395');
assert(396, 'MARK: - UIDocumentBrowserDelegate', '浏览器代理段 L397');
assert(484, '浏览器已关闭，回调 JS', 'registerSMBFileAndFinish 日志行 L485');
assert(486, '    }', 'registerSMBFileAndFinish 末行 L487');
assert(488, 'SMB 会话表内的唯一名称', 'uniqueSMBName 注释 L489');
assert(692, '}', '插件类结束 L693');
assert(694, 'SMB 文件预览页', '预览类 L695');
assert(767, '}', '文件尾 L768');

// ---- 新代码块 ----
const newBrowseSMB = `    // MARK: - SMB（系统文件选择器：「文件」App 导航界面进 NAS，点视频即流式播放）

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
            Log.write("browseSMB 开始 host=\\(host) port=\\(port) share=\\(share)（picker 模式）")
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
            Log.write("browseSMB 锚点=\\(type(of: anchor)) 开始展示系统选择器（主线程，目标共享=\\(share)）")
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: Self.smbPickTypes, asCopy: false)
            picker.allowsMultipleSelection = true
            picker.delegate = self
            self.bridge?.saveCall(call)
            self.pendingSMBBrowseId = call.callbackId
            anchor.present(picker, animated: true)
        }
    }`;

const newPickMethods = `    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        Log.write("documentPicker 选中 \\(urls.count) 个文件")
        controller.dismiss(animated: true)

        // SMB 流式模式（browseSMB，asCopy:false）：不拷贝，保持安全作用域访问登记进会话表，播放器直接从 NAS 流式读
        if let id = pendingSMBBrowseId {
            pendingSMBBrowseId = nil
            var results: [[String: Any]] = []
            for url in urls {
                let key = uniqueSMBName(url.lastPathComponent)
                url.startAccessingSecurityScopedResource()
                smbFiles[key] = url
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                Log.write("SMB 登记 \\(key) <- \\(url)")
                results.append([
                    "name": key,
                    "size": size,
                    "kind": "video",
                    "url": "localmedia://smb/\\(key.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? key)"
                ])
            }
            resolveSaved(id, data: ["files": results])
            Log.write("SMB 回调 JS，\\(results.count) 个文件")
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
                "url": "localmedia:///\\(dest.lastPathComponent.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? dest.lastPathComponent)"
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
    }`;

const newSmbTypes = `    /// v1.1.12：SMB picker 的内容类型（与 pickMedia 相同）。picker 的导航界面就是「文件」App 的，
    /// 可进 NAS、逐层进文件夹，选中视频（可多选）。
    private static let smbPickTypes: [UTType] = [.movie, .video, .mpeg4Movie, .quickTimeMovie]`;

const newProp = `    /// browseSMB 的异步回调 id（SMB picker 模式；didPickDocumentsAt 见它已设置就走流式登记、不拷贝）
    private var pendingSMBBrowseId: String?`;

// ---- 自底向上 splice（0-based 行号）----
// 9) 删 SMBPreviewViewController：L694-768 → idx 693..767
lines.splice(693, 767 - 693 + 1);
// 8) 删浏览器代理段：L397-488（MARK 注释到 registerSMBFileAndFinish 后的空行）→ idx 396..487
lines.splice(396, 487 - 396 + 1);
// 6+7) 替换 didPickDocumentsAt + wasCancelled：L356-395 → idx 355..394
lines.splice(355, 394 - 355 + 1, ...newPickMethods.split('\n'));
// 5) 替换 browseSMB + testBrowserLocal：L209-282 → idx 208..281
lines.splice(208, 281 - 208 + 1, ...newBrowseSMB.split('\n'));
// 4) 替换属性块：L97-107 → idx 96..106
lines.splice(96, 106 - 96 + 1, ...newProp.split('\n'));
// 3) 替换 browseContentTypes：L83-85 → idx 82..84
lines.splice(82, 84 - 82 + 1, ...newSmbTypes.split('\n'));
// 2) 删 testBrowserLocal 方法注册：L33 → idx 32
lines.splice(32, 1);
// 1) 类声明去协议：L19
lines[18] = lines[18].replace(', UIDocumentBrowserViewControllerDelegate', '');

const out = lines.join('\n');
// 收尾检查：不该再有任何浏览器残留（跳过注释行——新注释里会提到弃用的类名）
const codeLines = out.split('\n').filter((l) => !l.trim().startsWith('//'));
const code = codeLines.join('\n');
for (const bad of ['UIDocumentBrowserViewController', 'smbTestMode', 'smbBrowser', 'SMBPreviewViewController', 'testBrowserLocal', 'browseContentTypes', 'smbRootURL', 'registerSMBFileAndFinish']) {
  if (code.includes(bad)) {
    console.error(`LEFTOVER: ${bad}`);
    process.exit(1);
  }
}
fs.writeFileSync(p, out);
console.log(`DONE. 新行数=${out.split('\n').length}`);
