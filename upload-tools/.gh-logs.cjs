// 拉取 workflow run 的失败日志
const { execFileSync } = require('child_process');
const out = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
  windowsHide: true
});
const token = out.split(/\r?\n/).find((l) => l.startsWith('password=')).slice('password='.length).trim();
const RUN = process.argv[2] || '44540245621';
const auth = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };

(async () => {
  const jobsRes = await fetch('https://api.github.com/repos/DarkAlucard007/player-ios/actions/runs/' + RUN + '/jobs', { headers: auth });
  const jobs = await jobsRes.json();
  for (const job of jobs.jobs || []) {
    for (const step of job.steps || []) {
      if (step.conclusion === 'failure') {
        console.log('FAILED STEP: ' + step.name + ' (job ' + job.id + ')');
        const logRes = await fetch('https://api.github.com/repos/DarkAlucard007/player-ios/actions/jobs/' + job.id + '/logs', {
          headers: {
            Authorization: 'Bearer ' + token,
            Accept: 'application/octet-stream',
            'X-GitHub-Api-Version': '2022-11-28'
          }
        });
        const text = await logRes.text();
        const lines = text.split('\n');
        const idx = lines.findIndex((l) => l.includes(step.name));
        const start = Math.max(0, idx - 2);
        console.log(lines.slice(start, start + 120).join('\n'));
        break;
      }
    }
  }
})().catch((e) => {
  console.log('FATAL ' + String(e).slice(0, 200));
  process.exit(9);
});
