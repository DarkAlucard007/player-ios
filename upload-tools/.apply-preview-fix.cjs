const fs = require('fs');
const p = 'F:/DSH/苹果应用/01视频播放器/player/media-plugin/Sources/LocalMedia/LocalMediaPlugin.swift';
const lines = fs.readFileSync(p, 'utf8').split('\n');

// 校验锚点：427-446 行必须是同步版 preview 方法
const expect = [
  [427, '/// 点中文件 → 返回预览页'],
  [430, '@objc public func documentBrowser(_ controller: UIDocumentBrowserViewController,'],
  [431, 'previewViewControllerFor url: URL) -> UIViewController? {'],
  [446, '    }']
];
for (const [n, frag] of expect) {
  const actual = lines[n - 1];
  if (!actual || !actual.includes(frag)) {
    console.error('ANCHOR FAIL line', n, 'expected to contain:', frag);
    console.error('actual:', JSON.stringify(actual));
    process.exit(1);
  }
}

const replacement = [
  '    /// 点中文件 → 返回预览页（视频显示「播放」按钮，点一下就登记并播放）。',
  '    /// v1.1.11：恢复 completionHandler 版代理——iOS 26 实测只调用这个版本。',
  '    /// v1.1.8 曾误判"异步版无法被 ObjC 运行时发现"换成同步版，结果点中文件走系统 QuickLook',
  '    /// （从 SMB 流式拉视频/图片做预览，几秒一个、非常卡，且没有"用本 App 播放"入口）。',
  '    /// 闭包参数在 ObjC 里就是 block，@objc 可正常暴露。返回自绘预览页 = 秒开、不拉流预览、点按钮才播放。',
  '    @objc public func documentBrowser(_ controller: UIDocumentBrowserViewController,',
  '                                       previewViewControllerFor url: URL,',
  '                                       completionHandler: @escaping (UIViewController?, Error?) -> Void) {',
  '        if smbTestMode {',
  '            Log.write("documentBrowser [测试模式] 点中本地文件 \\(url.lastPathComponent)（仅日志，不播放）")',
  '            completionHandler(nil, nil)',
  '            return',
  '        }',
  '        Log.write("documentBrowser 点中文件 \\(url.lastPathComponent) (\\(url))")',
  '        // 无扩展名的条目（如点中共享名本身）返回 nil → 浏览器直接钻进目录，不弹预览',
  '        if url.pathExtension.isEmpty {',
  '            Log.write("documentBrowser 目录项，进入 \\(url)")',
  '            completionHandler(nil, nil)',
  '            return',
  '        }',
  '        let isVideo = Self.videoExts.contains(url.pathExtension.lowercased())',
  '        completionHandler(SMBPreviewViewController(fileName: url.lastPathComponent, isVideo: isVideo) { [weak self] in',
  '            self?.registerSMBFileAndFinish(url)',
  '        }, nil)',
  '    }',
  '',
  '    /// 同步版预览代理（保留作旧系统回退路径；iOS 26 实测不调用它）',
  '    @objc public func documentBrowser(_ controller: UIDocumentBrowserViewController,',
  '                                       previewViewControllerFor url: URL) -> UIViewController? {',
  '        Log.write("documentBrowser [同步版] 点中文件 \\(url.lastPathComponent)")',
  '        if smbTestMode { return nil }',
  '        if url.pathExtension.isEmpty { return nil }',
  '        let isVideo = Self.videoExts.contains(url.pathExtension.lowercased())',
  '        return SMBPreviewViewController(fileName: url.lastPathComponent, isVideo: isVideo) { [weak self] in',
  '            self?.registerSMBFileAndFinish(url)',
  '        }',
  '    }'
];

lines.splice(426, 20, ...replacement);
fs.writeFileSync(p, lines.join('\n'));
console.log('OK: replaced lines 427-446 with completionHandler + sync fallback preview methods');
console.log('new total lines:', lines.length);
