// 通过 check-runs annotations 拿失败步骤的错误信息
const { execFileSync } = require('child_process');
const out = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
  windowsHide: true
});
const token = out.split(/\r?\n/).find((l) => l.startsWith('password=')).slice('password='.length).trim();
const RUN = process.argv[2] || '44540245621';
const auth = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

(async () => {
  const jobsRes = await fetch('https://api.github.com/repos/DarkAlucard007/player-ios/actions/runs/' + RUN + '/jobs', { headers: auth });
  const jobs = await jobsRes.json();
  for (const job of jobs.jobs || []) {
    console.log('JOB ' + job.name + ' ' + job.conclusion + ' check_run=' + job.id);
    const annRes = await fetch('https://api.github.com/repos/DarkAlucard007/player-ios/check-runs/' + job.id + '/annotations', { headers: auth });
    console.log('annotations status=' + annRes.status);
    if (annRes.ok) {
      const anns = await annRes.json();
      for (const a of anns) {
        console.log('--- ' + a.annotation_level + ' @ ' + (a.path || '') + ':' + (a.start_line || ''));
        console.log((a.message || '').slice(0, 2000));
      }
    } else {
      console.log((await annRes.text()).slice(0, 200));
    }
    // 也试试 steps 列表
    for (const step of job.steps || []) {
      console.log('  step: ' + step.name + ' => ' + step.conclusion);
    }
  }
})().catch((e) => {
  console.log('FATAL ' + String(e).slice(0, 200));
  process.exit(9);
});
