import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

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

function pixel(x, y, size) {
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

function makePng(size, file) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y, size);
      const p = row + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(path.join(PUBLIC, file), png);
  console.log('generated', file, size + 'x' + size);
}

fs.mkdirSync(PUBLIC, { recursive: true });
makePng(180, 'apple-touch-icon.png');
makePng(192, 'icon-192.png');
makePng(512, 'icon-512.png');
