@echo off
chcp 65001 >nul
cd /d "%~dp0"
title App - One Click Build IPA

if /i "%~1"=="check" goto :check

echo.
echo ============================================================
echo    一键生成未签名 IPA
echo ============================================================
echo.
echo   1. 自动提交本地改动并推送到 GitHub main
echo   2. 触发云端 macOS 构建 (Xcode 16.4)
echo   3. 等待构建完成，下载并解压出 IPA
echo.
echo   说明: iOS 工具链只能在 macOS 上运行, 所以编译环节必须在
echo         GitHub Actions 上完成 -- 但你不需要手动做任何操作.
echo.
echo   预计 1-10 分钟, 请勿关闭本窗口.
echo.
echo ============================================================
echo.
node "upload-tools\build-ipa.mjs" --push
if errorlevel 1 goto :failed
echo.
echo ============================================================
echo   [成功] 安装包已生成, 见 downloads 目录, 文件名带版本号.
echo   用爱思助手 / Sideloadly 选 Apple ID 签名安装即可.
echo ============================================================
goto :end

:check
echo.
echo --- 环境自检 ---
node "upload-tools\build-ipa.mjs" --dry-run
if errorlevel 1 goto :failed
echo.
echo 自检通过. 直接双击本文件即可开始构建.
goto :end

:failed
echo.
echo ------------------------------------------------------------
echo   [失败] 上面的步骤没有全部成功.
echo   请把本窗口里的报错截图发给 WorkBuddy.
echo ------------------------------------------------------------

:end
echo.
pause
