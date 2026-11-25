import UIKit
import WebKit
import Capacitor

/// v1.1.20：localmedia:// scheme handler 的真正注册点。
///
/// 真机证据（v1.1.18/v1.1.19，两次全新启动日志）：
///   load() 里 `bridge?.webView?.configuration.setURLSchemeHandler(...)` 明明成功
///   （日志「scheme 注册成功 localmedia://（主线程，attempt=0）」），但之后
///   零条「scheme 请求」日志——fetch、<video> 的请求全部没到达处理器。
/// 结论：WKWebView 在**创建时**快照 URLSchemeHandler 表，创建之后对
/// `webView.configuration` 的任何 setURLSchemeHandler 调用都不生效。
/// Capacitor 在 CAPBridgeViewController.prepareWebView() 里创建 webview，
/// 而插件 load() 在其后执行——所以旧方案永远来不及。
///
/// 修法：Capacitor 7 提供官方 open 扩展点 `webViewConfiguration(for:)`，
/// 它在 prepareWebView() 内部、`WKWebView(frame:configuration:)` **之前**被调用
/// （源码注释明确推荐"调用 super 后修改结果"）。这里把 handler 挂上去。
///
/// 根控制器从 CAPBridgeViewController 换成本类由 build-ios.yml 改写
/// Main.storyboard 的 customClass + customModule 完成。
///
/// v1.1.23 勘误（v1.1.22 启动闪退根因）：
///   v1.1.21 误判"storyboard 需要裸 ObjC 类名"，加了 @objc(LocalMediaBridgeViewController)
///   把类的 ObjC 运行时名改成不带模块前缀的裸名。v1.1.22 把 customModule 改对了
///   （LocalMedia），storyboard 按 "LocalMedia.LocalMediaBridgeViewController" 做
///   模块限定查找——但 @objc 改名后精确匹配落空，解码抛异常 → 打开即闪退。
///   去掉 @objc，Swift 类的默认 ObjC 名就是 "模块.类名"，与查找串精确吻合。
///
/// 注意：本类创建的 handler 实例与 bridge 注册的插件实例是两个对象——
/// JS 调 browseSMB 走后者、播放请求走前者，所以 LocalMediaPlugin 的
/// smbFiles/smbKinds 已改为 static 共享会话状态。
public final class LocalMediaBridgeViewController: CAPBridgeViewController {

    /// v1.1.24：强持有 handler 实例（configuration 的持有方式不做假设，双保险）。
    private let localMediaHandler = LocalMediaPlugin()

    required public override init?(coder: NSCoder) {
        super.init(coder: coder)
        LocalMediaPlugin.Log.write("LocalMediaBridgeViewController init(coder): storyboard 已解析并实例化本类")
    }

    override public func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        LocalMediaPlugin.Log.write("LocalMediaBridgeViewController webViewConfiguration: 开始配置 webview")
        let config = super.webViewConfiguration(for: instanceConfiguration)
        config.setURLSchemeHandler(localMediaHandler, forURLScheme: "localmedia")
        // 打标后 LocalMediaPlugin.load() 跳过兜底注册——iOS 26 WebKit 对同一 scheme
        // 第二次 setURLSchemeHandler 抛 NSInvalidArgumentException → 闪退（.ips 实锤）。
        LocalMediaPlugin.schemeInstalledByVC = true
        LocalMediaPlugin.Log.write("LocalMediaBridgeViewController: localmedia:// handler 已挂到 webview 配置（早于 webview 创建，load() 将跳过重复注册）")
        return config
    }
}
