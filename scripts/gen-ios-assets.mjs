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

// 播放三角（512 坐标系），与 public 图标一致
const TRI = [[196, 140], [196, 372], [392, 256]];
function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}
function inTriangle(u, v) {
  const p = [u, v];
  const s1 = cross(TRI[0], TRI[1], p);
  const s2 = cross(TRI[1], TRI[2], p);
  const s3 = cross(TRI[2], TRI[0], p);
  const hasNeg = s1 < 0 || s2 < 0 || s3 < 0;
  const hasPos = s1 > 0 || s2 > 0 || s3 > 0;
  return !(hasNeg && hasPos);
}

function iconPixel(x, y, size) {
  const u = (x / size) * 512;
  const v = (y / size) * 512;
  const t = v / 512;
  const bg = [Math.round(30 + t * -14), Math.round(41 + t * -19), Math.round(59 + t * -21)];
  if (inTriangle(u, v)) return [255, 255, 255];
  return bg;
}

// 启动图：深色底 + 中央小播放三角
function splashPixel(x, y, size) {
  const cx = size / 2;
  const cy = size / 2;
  const half = size * 0.16;
  const u = ((x - cx) / half) * 256 + 256;
  const v = ((y - cy) / half) * 256 + 256;
  if (inTriangle(u, v)) return [255, 255, 255];
  return [15, 23, 42];
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

// 修正 LaunchScreen 背景色为深色（#0f172a）
const launchPath = path.join(ROOT, 'ios', 'App', 'App', 'Base.lproj', 'LaunchScreen.storyboard');
if (fs.existsSync(launchPath)) {
  let sb = fs.readFileSync(launchPath, 'utf8');
  sb = sb.replace(/<color key="backgroundColor" systemColor="systemBackgroundColor"\/>/g,
    '<color key="backgroundColor" red="0.058823529411764705" green="0.090196078431372548" blue="0.16470588235294117" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>');
  fs.writeFileSync(launchPath, sb);
  console.log('patched LaunchScreen background');
}
