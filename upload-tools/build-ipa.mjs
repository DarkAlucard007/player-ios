// 通用版：一键构建未签名 IPA。
//
// 完整链路：本地提交 → 推送到 GitHub → 触发云端 macOS 构建 → 等待 → 下载产物 → 解压出 IPA
//
// 用法：
//   node upload-tools/build-ipa.mjs --push              提交 + 推送 + 触发 + 等待 + 下载 + 解压
//   node upload-tools/build-ipa.mjs --push "提交信息"    同上，自定义提交信息
//   node upload-tools/build-ipa.mjs                     仅触发 + 等待 + 下载 + 解压
//   node upload-tools/build-ipa.mjs --dry-run           环境自检，不触发构建
//   RUN_ID=123456 node upload-tools/build-ipa.mjs       复用已有 run
//
// 所有可变项都从 app.config.json 读取；令牌从 Windows 凭据管理器（git credential）读取，
// 全程不打印、不落盘。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

// 本脚本所在目录（ESM 里没有 __dirname）
const HERE = path.dirname(fileURLToPath(import.meta.url));
// 项目根目录 = 本脚本所在目录的上一级（upload-tools/ -> 项目根）
const ROOT = process.env.PROJECT_ROOT || path.resolve(HERE, '..');

const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.config.json'), 'utf8'));
const REPO = process.env.APP_REPO || CFG.repo;
const BRANCH = process.env.APP_BRANCH || 'main';
const API = 'https://api.github.com';
const OUT_DIR = path.join(ROOT, 'downloads');

const argv = process.argv.slice(2);
const PUSH_FLAG = argv.includes('--push');
const DRY_RUN = argv.includes('--dry-run');
const PUSH_MSG = (() => {
  const i = argv.indexOf('--push');
  if (i < 0) return '';
  const next = argv[i + 1];
  // --push 后面没有跟文字时留空，由调用处用「v<版本号> build」兜底
  return next && !next.startsWith('--') ? next : '';
})();

/** 版本号唯一来源：package.json */
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const ARTIFACT = `${CFG.artifactPrefix}-v${VERSION}-unsigned-ipa`;
const IPA_NAME = `${CFG.artifactPrefix}-v${VERSION}-unsigned.ipa`;

function gitCredential() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    windowsHide: true
  });
  const line = out.split(/\r?\n/).find((l) => l.startsWith('password='));
  if (!line) throw new Error('凭据管理器里没有 GitHub 令牌（先执行一次 git push 完成授权）');
  return line.slice('password='.length).trim();
}

/**
 * 探测本机代理端口。
 * 注意：WorkBuddy 自带代理（55622）连不上 github.com 主站，Windows 系统代理（7890）才通，
 * 所以这里按优先级依次探测，但**不把 55622 排在内置列表里**。
 */
function portAlive(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { try { sock.destroy(); } catch { /* ignore */ } resolve(ok); };
    sock.setTimeout(1500);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

async function detectProxy() {
  if (process.env.GIT_PROXY) return process.env.GIT_PROXY;
  for (const p of [7890, 7897, 10809, 1080]) {
    if (await portAlive(p)) return `http://127.0.0.1:${p}`;
  }
  return '';
}

const PROXY = await detectProxy();
const GIT_ARGS = PROXY
  ? ['-c', `http.proxy=${PROXY}`, '-c', `https.proxy=${PROXY}`]
  : [];

function git(args, opts = {}) {
  return execFileSync('git', [...GIT_ARGS, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...opts
  });
}

/** 提交本地改动并推送到远端 */
function commitAndPush(message) {
  console.log('--- 提交并推送 ---');
  git(['add', '-A'], { quiet: true });
  const status = git(['status', '--porcelain'], { quiet: true }).trim();
  if (status) {
    git(['commit', '-m', message]);
    console.log('已提交:', message);
  } else {
    console.log('没有本地改动，跳过提交');
  }
  git(['push', 'origin', `HEAD:refs/heads/${BRANCH}`]);
  const sha = git(['rev-parse', 'HEAD'], { quiet: true }).trim();
  console.log('已推送到 ' + BRANCH + '，commit =', sha.slice(0, 10));
  return sha;
}

const TOKEN = gitCredential();
const auth = {
  Authorization: 'Bearer ' + TOKEN,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28'
};

async function api(pathname, options = {}) {
  const res = await fetch(API + pathname, { ...options, headers: { ...auth, ...(options.headers || {}) } });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && data.message) || text.slice(0, 300);
    throw new Error('HTTP ' + res.status + ' ' + pathname + ' → ' + msg);
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('App: ' + CFG.appName + ' | 版本 v' + VERSION + '（来源 package.json）');
  console.log('仓库: ' + REPO + ' | 产物: ' + ARTIFACT);
  console.log('代理: ' + (PROXY || '未使用（直连）'));

  if (PUSH_FLAG) commitAndPush(PUSH_MSG || `v${VERSION} build`);

  // 环境自检：只检查配置和连通性，不触发构建
  if (DRY_RUN) {
    console.log('--- 环境自检 ---');
    console.log('版本号        : v' + VERSION);
    console.log('代理          : ' + (PROXY || '未使用（直连）'));
    console.log('GitHub 令牌   : 已就绪（' + TOKEN.slice(0, 4) + '****，' + TOKEN.length + ' 位）');
    try {
      git(['ls-remote', '--heads', 'origin', BRANCH], { quiet: true });
    } catch {
      console.log('✗ 连不上远端仓库：' + REPO);
      console.log('  请检查这三点：');
      console.log('    1. GitHub 上是否已创建该仓库（建议选 Private）');
      console.log('    2. 是否已执行：git remote add origin https://github.com/' + REPO + '.git');
      console.log('    3. 是否已成功执行过 git push（这一步会把 GitHub 令牌存进凭据管理器）');
      process.exit(1);
    }
    const head0 = await api('/repos/' + REPO + '/commits/' + BRANCH).catch(() => null);
    if (!head0) {
      console.log('✗ 远端分支 ' + BRANCH + ' 不存在，先推送一次代码');
      process.exit(1);
    }
    console.log('GitHub 连通性 : 正常（远端 ' + BRANCH + ' = ' + head0.sha.slice(0, 10) + '）');
    console.log('目标产物      : ' + ARTIFACT);
    console.log('自检通过，可以开始构建。');
    process.exit(0);
  }

  // 1) 触发工作流（若已指定 RUN_ID 则跳过）
  const head = await api('/repos/' + REPO + '/commits/' + BRANCH);
  console.log('远端 ' + BRANCH + ' =', head.sha.slice(0, 10), '-', head.commit.message.split('\n')[0]);

  let run = null;
  if (process.env.RUN_ID) {
    run = await api('/repos/' + REPO + '/actions/runs/' + process.env.RUN_ID);
    console.log('使用已有 run:', run.id, '|', run.status, run.conclusion || '');
  } else {
    await api('/repos/' + REPO + '/actions/workflows/build-ios.yml/dispatches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: BRANCH })
    });
    console.log('已触发 build-ios.yml（macOS runner 上编译 IPA）');

    // 2) 找到这次运行
    for (let i = 0; i < 40; i++) {
      await sleep(3000);
      const list = await api('/repos/' + REPO + '/actions/runs?event=workflow_dispatch&per_page=10');
      run = (list.workflow_runs || []).find((r) => r.head_sha === head.sha);
      if (run) break;
    }
    if (!run) throw new Error('没有找到对应的 workflow run');
    console.log('run id =', run.id, '|', run.status, run.conclusion || '');
  }

  // 3) 等构建结束
  for (let i = 0; i < 200; i++) {
    await sleep(15000);
    const cur = await api('/repos/' + REPO + '/actions/runs/' + run.id);
    run = cur;
    process.stdout.write('\r  状态: ' + cur.status + ' ' + (cur.conclusion || '') + '   ');
    if (cur.status === 'completed') break;
  }
  console.log('\n构建结束:', run.status, run.conclusion);
  if (run.conclusion !== 'success') {
    const jobs = await api('/repos/' + REPO + '/actions/runs/' + run.id + '/jobs');
    for (const job of jobs.jobs || []) {
      for (const step of job.steps || []) {
        if (step.conclusion === 'failure') console.log('失败步骤:', step.name);
      }
    }
    throw new Error('构建失败，conclusion=' + run.conclusion);
  }

  // 4) 下载产物
  const arts = await api('/repos/' + REPO + '/actions/runs/' + run.id + '/artifacts');
  const art = (arts.artifacts || []).find((a) => a.name === ARTIFACT);
  if (!art) {
    console.log('可用产物:', (arts.artifacts || []).map((a) => a.name).join(', '));
    throw new Error('没找到产物 ' + ARTIFACT);
  }
  console.log('artifact:', art.name, art.size_in_bytes, 'bytes');

  const zipPath = path.join(os.tmpdir(), 'app-artifact.zip');
  const res = await fetch(API + '/repos/' + REPO + '/actions/artifacts/' + art.id + '/zip', { headers: auth });
  if (!res.ok) throw new Error('下载产物失败 HTTP ' + res.status);
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  console.log('zip 已下载:', fs.statSync(zipPath).size, 'bytes');
  fs.writeFileSync(path.join(ROOT, 'upload-tools', '.artifact.json'),
    JSON.stringify({ runId: run.id, artifactId: art.id, zipPath }));

  // 5) 解压出 IPA（Windows 自带的 bsdtar 支持 zip；Git Bash 的 GNU tar 不支持）
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const unzipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-unzip-'));
  const bsdtar = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
  execFileSync(bsdtar, ['-xf', zipPath, '-C', unzipDir], { windowsHide: true });
  const entries = fs.readdirSync(unzipDir).filter((f) => f.toLowerCase().endsWith('.ipa'));
  if (!entries.length) throw new Error('产物里没有 .ipa 文件');
  const ipaPath = path.join(OUT_DIR, IPA_NAME);
  fs.copyFileSync(path.join(unzipDir, entries[0]), ipaPath);
  console.log('IPA 已就位:', ipaPath, fs.statSync(ipaPath).size, 'bytes');
  console.log('\n完成。用爱思助手 / Sideloadly 选 Apple ID 签名安装即可。');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
