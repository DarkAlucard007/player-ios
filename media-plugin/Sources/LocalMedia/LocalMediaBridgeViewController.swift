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
/// Main.storyboard 的 customClass 完成；运行时 storyboard 用
/// NSClassFromString 实例化，能找到嵌入框架 LocalMedia.framework 里的本类。
///
/// 注意：本类创建的 handler 实例与 bridge 注册的插件实例是两个对象——
/// JS 调 browseSMB 走后者、播放请求走前者，所以 LocalMediaPlugin 的
/// smbFiles/smbKinds 已改为 static 共享会话状态。
/// 运行时 storyboard 用 NSClassFromString 按名字实例化根控制器。Swift 类在
/// ObjC 运行时的默认名字带模块前缀（LocalMedia.LocalMediaBridgeViewController），
/// 必须用 @objc(LocalMediaBridgeViewController) 显式去掉前缀，否则 storyboard
/// 里 customClass="LocalMediaBridgeViewController" 查不到类 → 根视图缺失 → 黑屏
/// （v1.1.20 真机事故，v1.1.21 修复）。
@objc(LocalMediaBridgeViewController)
public final class LocalMediaBridgeViewController: CAPBridgeViewController {
    override public func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: instanceConfiguration)
        config.setURLSchemeHandler(LocalMediaPlugin(), forURLScheme: "localmedia")
        LocalMediaPlugin.Log.write("LocalMediaBridgeViewController: localmedia:// handler 已挂到 webview 配置（早于 webview 创建）")
        return config
    }
}
