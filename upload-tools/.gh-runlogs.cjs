// 下载整个 run 的日志 zip，解出 pod install 部分
const fs = require('fs');
const { execFileSync } = require('child_process');
const out = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
  windowsHide: true
});
const token = out.split(/\r?\n/).find((l) => l.startsWith('password=')).slice('password='.length).trim();
const RUN = process.argv[2] || '44540245621';

(async () => {
  const res = await fetch('https://api.github.com/repos/DarkAlucard007/player-ios/actions/runs/' + RUN + '/logs', {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/octet-stream',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  console.log('status', res.status);
  if (!res.ok) {
    console.log((await res.text()).slice(0, 300));
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const zipPath = __dirname + '/.run-logs.zip';
  fs.writeFileSync(zipPath, buf);
  console.log('zip saved', buf.length, 'bytes');
  const dir = __dirname + '/.run-logs';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xf', zipPath, '-C', dir], { windowsHide: true });
  const files = fs.readdirSync(dir);
  console.log('files:', files.join(', '));
  for (const f of files) {
    const text = fs.readFileSync(dir + '/' + f, 'utf8');
    const lines = text.split('\n');
    const idx = lines.findIndex((l) => l.includes('pod install') || l.includes('CocoaPods'));
    if (idx >= 0) {
      console.log('=== ' + f + ' (from line ' + idx + ') ===');
      console.log(lines.slice(Math.max(0, idx - 5), idx + 150).join('\n'));
      break;
    }
  }
})().catch((e) => {
  console.log('FATAL ' + String(e).slice(0, 300));
  process.exit(9);
});
