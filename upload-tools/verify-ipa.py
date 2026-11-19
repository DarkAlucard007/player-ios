# -*- coding: utf-8 -*-
"""通用 IPA 深度校验。

用法：
    python upload-tools/verify-ipa.py                 # 校验 downloads/ 下最新的 IPA
    python upload-tools/verify-ipa.py <ipa路径>        # 校验指定文件

所有期望值都从 app.config.json 读取，改 App 时不用改这个脚本。
"""
import io, os, plistlib, re, sys, zipfile, json, glob, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CFG = json.load(open(os.path.join(ROOT, 'app.config.json'), encoding='utf-8'))
APP = "Payload/App.app/"


def find_ipa():
    if len(sys.argv) > 1:
        return sys.argv[1]
    files = sorted(glob.glob(os.path.join(ROOT, 'downloads', '*.ipa')), key=os.path.getmtime)
    if not files:
        print('找不到 IPA 文件（downloads/ 目录为空）')
        sys.exit(2)
    return files[-1]


IPA = find_ipa()

ok_count = 0
fail_count = 0


def check(name, cond, detail=""):
    global ok_count, fail_count
    if cond:
        ok_count += 1
        print(f"  [PASS] {name}" + (f"  ({detail})" if detail else ""))
    else:
        fail_count += 1
        print(f"  [FAIL] {name}" + (f"  ({detail})" if detail else ""))


print(f"App: {CFG['appName']}")
print(f"IPA: {IPA}")
size = os.path.getsize(IPA)
print(f"大小: {size:,} bytes")
print("sha256:", hashlib.sha256(io.open(IPA, "rb").read()).hexdigest())
print()

z = zipfile.ZipFile(IPA)
names = z.namelist()

print("=== 1. 包结构 ===")
check("包含 Payload/App.app/", any(n.startswith(APP) for n in names))
check("包含 Info.plist", APP + "Info.plist" in names)
exe = [n for n in names if n.endswith("/App")]
check("可执行文件 App 存在", len(exe) == 1, exe[0] if exe else "")
for plugin in CFG.get('nativePlugins') or []:
    fw = plugin.replace('Plugin', '')
    check(f"包含 {fw}.framework", any(f"{fw}.framework/{fw}" in n for n in names))

print()
print("=== 2. Info.plist ===")
plist = plistlib.loads(z.read(APP + "Info.plist"))
expect_name = CFG.get('displayName') or CFG['appName']
check(f"显示名 = {expect_name}", plist.get('CFBundleDisplayName') == expect_name,
      str(plist.get('CFBundleDisplayName')))
pkg = json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))
check(f"版本 CFBundleShortVersionString = {pkg['version']}",
      plist.get('CFBundleShortVersionString') == pkg['version'],
      str(plist.get('CFBundleShortVersionString')))
check(f"构建号 CFBundleVersion = {pkg['version']}",
      plist.get('CFBundleVersion') == pkg['version'],
      str(plist.get('CFBundleVersion')))
check(f"bundle id = {CFG['bundleId']}",
      plist.get('CFBundleIdentifier') == CFG['bundleId'], str(plist.get('CFBundleIdentifier')))
if CFG.get('minIOS'):
    check(f"最低系统 = {CFG['minIOS']}",
          str(plist.get('MinimumOSVersion')) == str(CFG['minIOS']),
          str(plist.get('MinimumOSVersion')))
if CFG.get('needsArbitraryHttp'):
    ats = plist.get('NSAppTransportSecurity') or {}
    check("允许任意 HTTP 传输", ats.get('NSAllowsArbitraryLoads') is True, str(ats))
for key in (CFG.get('permissions') or {}):
    check(f"含权限说明 {key}", key in plist)
for key in (CFG.get('customPlistEntries') or {}):
    check(f"含自定义字段 {key}", key in plist)

print()
print("=== 3. 运行时插件注册表 ===")
# Capacitor 7 的 packageClassList 存在 App 包内的 capacitor.config.json（不是 Info.plist）
cap_json = json.loads(z.read(APP + "capacitor.config.json").decode("utf-8"))
pcl_list = cap_json.get("packageClassList") or []
for plugin in CFG.get('nativePlugins') or []:
    check(f"注册了 {plugin}", plugin in pcl_list, str(pcl_list))

print()
print("=== 4. 原生框架符号 ===")
for sym in CFG.get('frameworkSymbols') or []:
    found = False
    for n in names:
        if '.framework/' in n and not n.endswith('/') and z.getinfo(n).file_size > 0:
            try:
                if sym.encode() in z.read(n):
                    found = True
                    break
            except Exception:
                pass
    check("符号存在: " + sym, found)

print()
print("=== 5. 前端产物自包含 ===")
idx = z.read(APP + "public/index.html").decode("utf-8", "replace")
check("HTML 内联了 JS", '<script type="module">' in idx)
check("HTML 内联了 CSS", "<style>" in idx)
check("没有外链 JS（真机不会 404）", not re.findall(r'src="[^"]+\.js"', idx))
dyn = re.findall(r"import\s*\(\s*[\"'][^\"']+[\"']\s*\)", idx)
check("无动态 import（真机不会 404）", len(dyn) == 0, f"数量={len(dyn)}")
# 体积只做区间提示：小工具类 App 可能只有几 KB，不能卡死下限
html_bytes = len(idx.encode())
check("index.html 体积在合理区间",
      500 < html_bytes < 3000000, f"{html_bytes:,} bytes")

print()
print("=== 6. 安全区 / 外观 ===")
inset = (cap_json.get("ios") or {}).get("contentInset")
check("ios.contentInset = never（避免与 CSS env() 重复计算）", inset == "never", str(inset))
check(f"appId = {CFG['appId']}", cap_json.get("appId") == CFG['appId'], str(cap_json.get("appId")))
check(f"appName = {CFG['appName']}", cap_json.get("appName") == CFG['appName'], str(cap_json.get("appName")))

print()
print(f"===== 结果：{ok_count} 项通过，{fail_count} 项失败 =====")
sys.exit(1 if fail_count else 0)
