const fs = require('fs');
const p = 'F:/DSH/苹果应用/01视频播放器/player/media-plugin/Sources/LocalMedia/LocalMediaPlugin.swift';
const raw = fs.readFileSync(p, 'utf8');
const crlf = raw.includes('\r\n');
console.log('CRLF =', crlf, '| has CR =', raw.includes('\r'));
const lines = raw.split(/\r?\n/);
const [a, b] = process.argv.slice(2).map(Number);
for (let i = a; i <= b && i < lines.length; i++) {
  console.log(JSON.stringify({ n: i + 1, s: lines[i] }));
}
