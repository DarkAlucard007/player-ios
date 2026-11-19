# -*- coding: utf-8 -*-
"""v1 UI 回归测试（Playwright + WebKit，真实界面驱动）。

覆盖：
  1. 首页渲染
  2. 媒体库导入本地视频（file input 回退路径）
  3. 播放器：播放 / 拖动进度 / 倍速
  4. 外挂字幕：同名 SRT 自动加载 + 时间轴显示
  5. WebDAV：添加源 → 浏览目录 → 播放网络视频（mock 服务器，Range 流式）

运行：python upload-tools/test-ui.py
"""
import http.server
import os
import re
import socketserver
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DIST = os.path.join(ROOT, "dist", "index.html")
# 本机 Playwright WebKit 构建不含任何视频解码器（h264/webm 都静默失败），
# UI 测试用 Chromium（自带完整解码器）；真机 iOS 的 WKWebView 原生支持 H.264。
SAMPLE = os.path.join(HERE, "sample.mp4")
SRT = os.path.join(HERE, "sample.srt")

passed = 0
failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("  [PASS] " + name)
    else:
        failed += 1
        print("  [FAIL] " + name + (("  (" + str(detail) + ")") if detail else ""))


SAMPLE_NAME = os.path.basename(SAMPLE)
MULTISTATUS = (
    '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">'
    '<D:response><D:href>/videos/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>'
    '<D:response><D:href>/videos/' + SAMPLE_NAME + '</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>{size}</D:getcontentlength></D:prop></D:propstat></D:response>'
    "</D:multistatus>"
).format(size=os.path.getsize(SAMPLE))


class WebDAVHandler(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        # 页面在 file:// 源下，PROPFIND 是非简单请求，必须过 CORS 预检
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PROPFIND, MOVE, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Depth, Destination, Overwrite")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_PROPFIND(self):
        self.send_response(207)
        self.send_header("Content-Type", "application/xml")
        self._cors()
        self.end_headers()
        self.wfile.write(MULTISTATUS.encode("utf-8"))

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.rstrip("/") != "/videos/" + SAMPLE_NAME:
            self.send_response(404)
            self.end_headers()
            return
        data = open(SAMPLE, "rb").read()
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d+)-(\d*)", rng)
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else len(data) - 1
            end = min(end, len(data) - 1)
            self.send_response(206)
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, len(data)))
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Content-Type", "video/mp4")
            self._cors()
            self.end_headers()
            self.wfile.write(data[start : end + 1])
        else:
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Type", "video/mp4")
            self._cors()
            self.end_headers()
            self.wfile.write(data)

    def log_message(self, *args):
        pass


def start_server():
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", 0), WebDAVHandler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, httpd.server_address[1]


def main():
    global passed, failed
    from playwright.sync_api import sync_playwright

    # 同名外挂字幕（1s-4s 一条）
    with open(SRT, "w", encoding="utf-8") as f:
        f.write("1\n00:00:01,000 --> 00:00:04,000\nSUBTITLE TEST LINE\n")

    httpd, port = start_server()
    webdav_url = "http://127.0.0.1:%d" % port

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 390, "height": 844})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto("file:///" + DIST.replace("\\", "/"))
        page.wait_for_selector("h1", timeout=10000)
        check("首页渲染（h1=视频播放器）", page.locator("h1").first.inner_text() == "视频播放器")
        check("底部标签栏 6 个标签", page.locator("#tabbar .tab").count() == 6)

        # ---- 媒体库导入 ----
        page.goto("file:///" + DIST.replace("\\", "/") + "#/library")
        page.wait_for_selector("#lib-add")
        page.click("#lib-add")
        page.wait_for_selector("input[type=file]", timeout=5000, state="attached")
        page.set_input_files("input[type=file]", [SAMPLE, SRT])
        page.wait_for_selector(".media-card", timeout=10000)
        check("导入后媒体库出现视频卡片", page.locator(".media-card").count() >= 1)
        check("字幕文件出现在列表", "sample.srt" in page.locator("#lib-body").inner_text())

        # ---- 播放器 ----
        page.click(".media-card")
        page.wait_for_selector(".player-root video", timeout=10000)
        # 等 canplay
        ok = False
        for _ in range(40):
            ready = page.evaluate("document.querySelector('#pv').readyState")
            if ready >= 3:
                ok = True
                break
            time.sleep(0.25)
        check("视频加载到 canplay", ok, "readyState=%s" % ready)
        duration = page.evaluate("document.querySelector('#pv').duration")
        check("时长 > 5s", duration > 5, duration)

        # 若被自动播放策略拦截，点播放键
        if page.evaluate("document.querySelector('#pv').paused"):
            page.click("#pv-play")
        played = False
        for _ in range(20):
            if page.evaluate("document.querySelector('#pv').currentTime") > 0.4:
                played = True
                break
            time.sleep(0.25)
        check("视频实际播放（currentTime 前进）", played)

        # 拖动进度到 50%
        page.evaluate(
            "const v=document.querySelector('#pv'); v.currentTime = v.duration/2;"
        )
        time.sleep(0.8)
        cur = page.evaluate("document.querySelector('#pv').currentTime")
        check("拖动进度到 50%", abs(cur - duration / 2) < 1.0, cur)

        # 倍速（控制层 3.5s 无操作自动隐藏，先唤醒）
        page.locator("#pv-bottom").dispatch_event("pointerdown")
        time.sleep(0.3)
        page.click("#pv-speed")
        rate = page.evaluate("document.querySelector('#pv').playbackRate")
        check("倍速切换（1 → 1.25）", rate == 1.25, rate)

        # 字幕：seek 到 2s，等字幕叠加层显示
        page.evaluate("const v=document.querySelector('#pv'); v.currentTime = 2;")
        time.sleep(0.8)
        sub_text = page.locator("#pv-sub").inner_text()
        check("同名 SRT 自动加载并显示", "SUBTITLE TEST LINE" in sub_text, sub_text)

        page.screenshot(path=os.path.join(HERE, "shot-player.png"))

        # ---- WebDAV 源 ----
        page.locator("#pv-top").dispatch_event("pointerdown")
        time.sleep(0.3)
        page.click("#pv-back")
        # 播放器关闭后回到之前的页面，点「浏览」标签进入源管理
        page.click('#tabbar a[href="#/browse"]')
        page.wait_for_selector("#br-add", timeout=5000)
        page.click("#br-add")
        page.wait_for_selector("#f-host")
        # SMB 类型选项存在且切换后显示 SMB 字段
        page.select_option("#f-type", "smb")
        page.wait_for_selector("#f-smb-host", timeout=3000)
        check("SMB 类型表单可切换", page.locator("#f-smb-share").count() == 1)
        page.select_option("#f-type", "webdav")
        page.wait_for_selector("#f-host", timeout=3000)
        page.fill("#f-name", "TestNAS")
        page.fill("#f-host", webdav_url)
        page.click("#f-save")
        page.wait_for_selector(".src-row", timeout=5000)
        check("媒体源已保存", "TestNAS" in page.locator(".src-row").first.inner_text())
        page.click(".src-row")
        page.wait_for_selector(".br-item", timeout=15000)
        check("WebDAV 目录列出视频", SAMPLE_NAME in page.locator("#br-items").inner_text())
        page.click(".br-item.video")
        page.wait_for_selector(".player-root video", timeout=10000)
        ok = False
        for _ in range(40):
            ready = page.evaluate("document.querySelector('#pv').readyState")
            if ready >= 3:
                ok = True
                break
            time.sleep(0.25)
        check("WebDAV 视频播放（Range 流式）", ok, "readyState=%s" % ready)
        if page.evaluate("document.querySelector('#pv').paused"):
            page.click("#pv-play")
        played = False
        for _ in range(20):
            if page.evaluate("document.querySelector('#pv').currentTime") > 0.4:
                played = True
                break
            time.sleep(0.25)
        check("WebDAV 视频实际播放", played)

        check("无未捕获 JS 错误", len(errors) == 0, "; ".join(errors[:3]))

        browser.close()
    httpd.shutdown()
    print("")
    print("===== UI 测试：%d 项通过，%d 项失败 =====" % (passed, failed))
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
