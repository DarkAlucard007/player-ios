# 视频播放器

用「GitHub 云端编译 + 一键出 IPA」工作方式开发的 iOS App。

## 快速开始

```bash
npm install        # 装依赖
npm run dev        # 本地开发
npm run build      # 构建（产出自包含的 dist/index.html）
npm run check      # 类型检查 + 构建（提交前跑）
```

## 出 IPA

双击 **`一键生成IPA.bat`** —— 自动提交、推送、触发云端 macOS 构建、下载并解压安装包。

产物落在 `downloads/` 目录，文件名带版本号。

```bash
npm run ipa:check    # 只做环境自检，不触发构建
npm run ipa:build    # 等同于双击 bat
npm run ipa:verify   # 深度校验 downloads/ 里的 IPA
```

## 目录

```
app.config.json          唯一配置入口（App 名 / bundle id / 仓库 / 原生插件）
capacitor.config.ts      Capacitor 配置
vite.config.ts           打包配置
src/                     前端源码
scripts/                 打包与图标脚本
upload-tools/            构建与校验脚本
.github/workflows/       云端构建流水线
```

## 三条不能违反的技术约束

1. **前端产物必须自包含单文件，不能有动态 `import()`** — 否则真机上路径 404，功能静默失效
2. **排版测量与渲染必须共用同一套 HTML** — 否则加粗/变字号后测量低估高度，文字溢出
3. **`ios.contentInset` 必须是 `'never'`** — 否则安全区被算两遍，顶部留白、底栏不贴底

详见上级目录的《新App开发指南.md》。

## 安装到 iPhone

产物是**未签名 IPA**，需要用爱思助手或 Sideloadly 选 **Apple ID 签名** 后安装。
免费账号签名 7 天过期，到期重签一次即可。
