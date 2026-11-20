const fs = require('fs');
const raw = fs.readFileSync('F:/苹果应用/App-2026-11-20-235949.ips', 'utf8');
const lines = raw.split('\n');
const o = JSON.parse(lines.slice(1).join('\n'));
console.log('faultingThread =', o.faultingThread);
const t = o.threads[o.faultingThread];
console.log('queue =', t.queue || '(none)');
console.log('--- faulting thread frames ---');
t.frames.forEach((f, i) => {
  const img = f.imageIndex >= 0 ? o.usedImages[f.imageIndex].name : '?';
  console.log(String(i).padStart(3), (f.symbol || '(no symbol)').padEnd(72), `[${img}] offset ${f.imageOffset}`);
});
console.log('--- all thread queues ---');
o.threads.forEach((th, i) => {
  console.log(`thread ${i}: ${th.queue || '(no queue)'}  frames=${th.frames.length}`);
});
console.log('--- exception ---');
console.log(JSON.stringify(o.exception));
console.log('asi:', JSON.stringify(o.asi));
