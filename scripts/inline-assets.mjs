import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = path.join(ROOT, 'dist');
const htmlPath = path.join(DIST, 'index.html');

if (!fs.existsSync(htmlPath)) {
  console.error('dist/index.html 不存在，请先执行 vite build');
  process.exit(1);
}

let html = fs.readFileSync(htmlPath, 'utf8');

function findAsset(ext) {
  const assetsDir = path.join(DIST, 'assets');
  if (!fs.existsSync(assetsDir)) return null;
  const files = fs.readdirSync(assetsDir).filter((f) => f.endsWith(ext));
  return files.length ? path.join(assetsDir, files[0]) : null;
}

function listAssets(ext) {
  const assetsDir = path.join(DIST, 'assets');
  if (!fs.existsSync(assetsDir)) return [];
  return fs.readdirSync(assetsDir).filter((f) => f.endsWith(ext));
}

function escapeForHtmlTag(content, tag) {
  return content.replace(new RegExp('</' + tag, 'gi'), '<\\/' + tag);
}

const jsFile = findAsset('.js');
const cssFile = findAsset('.css');

// 自包含 HTML 与「代码分割」天生冲突：
// 内联后的脚本位于 dist/index.html，chunk 之间的 import("./xxx.js") 会解析到
// dist/xxx.js，而文件实际在 dist/assets/xxx.js —— 真机上必然 404。
// 因此这里强制要求只有一个 JS chunk（vite.config.ts 已设置 inlineDynamicImports）。
const jsChunks = listAssets('.js');
if (jsChunks.length > 1) {
  console.error('检测到多个 JS chunk：' + jsChunks.join(', '));
  console.error('内联成单个 index.html 后这些 chunk 的 import() 会 404，请确认 vite.config.ts 里 inlineDynamicImports: true 生效。');
  process.exit(1);
}

if (jsFile) {
  const js = fs.readFileSync(jsFile, 'utf8');
  // 再兜底检查一次：内联脚本里不允许残留指向其它文件的动态 import
  const leftovers = js.match(/import\s*\(\s*["'][^"']+["']\s*\)/g);
  if (leftovers) {
    console.error('内联脚本里仍有动态 import，真机上会 404：', leftovers.slice(0, 10).join(', '));
    process.exit(1);
  }
  const inline = '<script type="module">' + escapeForHtmlTag(js, 'script') + '</script>';
  html = html.replace(/<script[^>]*src="(?:\.\/|\/)?assets\/[^"]+\.js"[^>]*><\/script>/, () => inline);
  console.log('inlined JS:', path.basename(jsFile));
}

if (cssFile) {
  const css = fs.readFileSync(cssFile, 'utf8');
  const inline = '<style>' + escapeForHtmlTag(css, 'style') + '</style>';
  html = html.replace(/<link[^>]*href="(?:\.\/|\/)?assets\/[^"]+\.css"[^>]*>/, () => inline);
  console.log('inlined CSS:', path.basename(cssFile));
}

function toDataUri(file, mime) {
  if (!fs.existsSync(file)) return null;
  const b64 = fs.readFileSync(file).toString('base64');
  return 'data:' + mime + ';base64,' + b64;
}

const touchIcon = toDataUri(path.join(DIST, 'apple-touch-icon.png'), 'image/png');
if (touchIcon) {
  html = html.replace(/<link[^>]*rel="apple-touch-icon"[^>]*>/, '<link rel="apple-touch-icon" href="' + touchIcon + '" />');
  console.log('inlined apple-touch-icon');
}

const favicon = toDataUri(path.join(DIST, 'icon-192.png'), 'image/png');
if (favicon) {
  html = html.replace(/<link[^>]*rel="icon"[^>]*>/, '<link rel="icon" href="' + favicon + '" type="image/png" />');
  console.log('inlined favicon');
}

const manifest = toDataUri(path.join(DIST, 'manifest.webmanifest'), 'application/manifest+json');
if (manifest) {
  html = html.replace(/<link[^>]*rel="manifest"[^>]*>/, '<link rel="manifest" href="' + manifest + '" />');
  console.log('inlined manifest');
}

fs.writeFileSync(htmlPath, html);
console.log('self-contained index.html written,', Buffer.byteLength(html), 'bytes');
