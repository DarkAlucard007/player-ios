import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ASSETS = path.join(ROOT, 'ios', 'App', 'App', 'Assets.xcassets');

const table = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function png(size, pixelFn) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a = 255] = pixelFn(x, y, size);
      const p = row + 1 + x * 4;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; raw[p + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// 书本图标（与 public 图标一致），缩放到任意尺寸
function iconPixel(x, y, size) {
  const u = (x / size) * 512;
  const v = (y / size) * 512;
  const bg = [47 + Math.round((v / 512) * 10), 111 + Math.round((v / 512) * 8), 94];
  const inRect = (x1, y1, x2, y2) => u >= x1 && u < x2 && v >= y1 && v < y2;
  if (inRect(112, 132, 240, 360)) return [244, 234, 214];
  if (inRect(272, 132, 400, 360)) return [255, 250, 240];
  if (inRect(251, 152, 261, 380)) return [47, 111, 94];
  if (inRect(136, 182, 224, 190) || inRect(136, 216, 224, 224)) return [168, 155, 132];
  if (inRect(288, 182, 376, 190) || inRect(288, 216, 376, 224)) return [168, 155, 132];
  return bg;
}

// 启动图：米色底 + 中央书本，居中留白
function splashPixel(x, y, size) {
  const cx = size / 2;
  const cy = size / 2;
  const half = size * 0.14;
  const inRect = (x1, y1, x2, y2) => x >= cx + x1 * half && x < cx + x2 * half && y >= cy + y1 * half && y < cy + y2 * half;
  if (inRect(-1.0, -0.95, -0.05, 0.95)) return [244, 234, 214];
  if (inRect(0.05, -0.95, 1.0, 0.95)) return [255, 250, 240];
  if (inRect(-0.02, -0.85, 0.02, 1.0)) return [47, 111, 94];
  return [247, 243, 234];
}

const appIconDir = path.join(ASSETS, 'AppIcon.appiconset');
fs.mkdirSync(appIconDir, { recursive: true });
fs.writeFileSync(path.join(appIconDir, 'AppIcon-512@2x.png'), png(1024, iconPixel));
console.log('generated AppIcon-512@2x.png (1024x1024)');

const splashDir = path.join(ASSETS, 'Splash.imageset');
fs.mkdirSync(splashDir, { recursive: true });
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  fs.writeFileSync(path.join(splashDir, name), png(2732, splashPixel));
  console.log('generated', name, '(2732x2732)');
}

// 修正 LaunchScreen 背景色为米色
const launchPath = path.join(ROOT, 'ios', 'App', 'App', 'Base.lproj', 'LaunchScreen.storyboard');
if (fs.existsSync(launchPath)) {
  let sb = fs.readFileSync(launchPath, 'utf8');
  sb = sb.replace(/<color key="backgroundColor" systemColor="systemBackgroundColor"\/>/g,
    '<color key="backgroundColor" red="0.96862745098039216" green="0.95294117647058818" blue="0.91764705882352937" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>');
  fs.writeFileSync(launchPath, sb);
  console.log('patched LaunchScreen background');
}
