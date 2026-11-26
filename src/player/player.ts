// 播放器主界面：全屏播放 + 控制层 + 字幕叠加 + 倍速/PiP/投屏/截图/EQ/色彩 + 自动连播

import { state, saveRecord, setSettings, addToPlaylist } from '../core/store';
import { fmtTime, escapeHtml, extOf, titleOfKey } from '../core/util';
import { captureFrame, saveImageToPhotos, pickMedia, readTextFile, localUrl, setOrientation, listSMBDir, needsNativePlayer, playNative, writeDebug, type ScreenOrientation } from '../native/localMedia';
import { parseSubtitle, cueAt, type Cue } from './subtitles';
import { EQ, EQ_BAND_LABELS } from './eq';
import { resolvePlayback, findMatchingSubtitle } from '../sources/registry';
import { toast } from '../components/ui';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

interface PlayerSession {
  key: string;
  context: string[]; // 连播顺序
  index: number;
  cues: Cue[];
  subtitleOn: boolean;
  subtitleName: string | null;
  eq: EQ;
  eqOn: boolean;
  color: { brightness: number; contrast: number; saturation: number; hue: number };
  hideTimer: number | null;
  saveTimer: number | null;
  raf: number;
  closed: boolean;
  /** v1.1.26：当前屏幕方向（手动 ⟲/⟳ 循环用） */
  orient: ScreenOrientation;
  /** v1.1.26：横屏视频已自动切横屏（关闭时恢复竖屏） */
  autoLandscape: boolean;
}

let session: PlayerSession | null = null;
let root: HTMLElement | null = null;

// ---- 打开 / 关闭 ----

export function openPlayer(key: string, context?: string[]): void {
  if (session) teardown();
  const resolved = resolvePlayback(key);
  if (!resolved) {
    toast('无法解析播放地址');
    return;
  }
  // v1.1.31：非 MP4/MOV/M4V 容器 → 原生 FFmpeg 播放器（<video>/AVFoundation 解不动 MKV 等）
  const nameForExt = resolved.localName ?? resolved.smbName ?? resolved.title ?? titleOfKey(key);
  const needsNative = needsNativePlayer(nameForExt);
  writeDebug(`openPlayer key=${key} resolved=${resolved ? 'yes' : 'no'} nameForExt=${nameForExt} needsNative=${needsNative} url=${resolved.url}`);
  if (needsNative) {
    const nativeUrl = key.startsWith('smb2:') ? key : resolved.url; // makeFFSource 认 smb2:<key>
    const subName = findMatchingSubtitle(resolved.localName ?? '');
    const subUrl = subName ? localUrl(subName) : null;
    playNative({
      url: nativeUrl,
      title: titleOfKey(key),
      subs: subUrl ? [{ url: subUrl }] : undefined
    }).catch((e) => toast('打开失败 ' + (e && e.message ? e.message : e)));
    return; // 原生全屏 VC 已呈现，不构建 web 播放层
  }
  const ctx = context && context.length > 0 ? context : [key];
  const index = Math.max(0, ctx.indexOf(key));

  root = document.createElement('div');
  root.className = 'player-root';
  root.innerHTML = `
    <video id="pv" playsinline webkit-playsinline airplay preload="auto"></video>
    <div class="pv-sub" id="pv-sub"></div>
    <div class="pv-top" id="pv-top">
      <button class="pv-btn" id="pv-back" aria-label="返回">‹</button>
      <div class="pv-title" id="pv-title"></div>
    </div>
    <div class="pv-center" id="pv-center">
      <button class="pv-btn pv-big" id="pv-play">▶</button>
    </div>
    <div class="pv-bottom" id="pv-bottom">
      <div class="pv-seek-row">
        <span class="pv-time" id="pv-cur">00:00</span>
        <div class="pv-seek-wrap">
          <input type="range" id="pv-seek" min="0" max="1000" value="0" step="1" />
          <div class="pv-buffer" id="pv-buffer"></div>
        </div>
        <span class="pv-time" id="pv-dur">00:00</span>
      </div>
      <div class="pv-btns">
        <button class="pv-btn" id="pv-rot-l" aria-label="左旋">⟲</button>
        <button class="pv-btn" id="pv-rot-r" aria-label="右旋">⟳</button>
        <button class="pv-btn pv-skip" id="pv-rew">-10s</button>
        <button class="pv-btn pv-skip" id="pv-fwd2">+10s</button>
        <button class="pv-btn" id="pv-speed">1.0x</button>
        <button class="pv-btn pv-cc" id="pv-cc">CC</button>
        <button class="pv-btn" id="pv-list">☰列表</button>
        <button class="pv-btn" id="pv-shot">截图</button>
        <button class="pv-btn" id="pv-airplay">投屏</button>
        <button class="pv-btn" id="pv-more">更多</button>
      </div>
    </div>
    <div class="pv-sheet-mask" id="pv-sheet-mask"></div>
    <div class="pv-sheet" id="pv-sheet"></div>
    <div class="pv-panel-mask" id="pv-panel-mask"></div>
    <div class="pv-panel" id="pv-panel"></div>
  `;
  document.body.appendChild(root);
  document.body.classList.add('player-open');

  const video = root.querySelector<HTMLVideoElement>('#pv')!;
  const s: PlayerSession = {
    key,
    context: ctx,
    index,
    cues: [],
    subtitleOn: true,
    subtitleName: null,
    eq: new EQ(),
    eqOn: false,
    color: { brightness: 1, contrast: 1, saturation: 1, hue: 0 },
    hideTimer: null,
    saveTimer: null,
    raf: 0,
    closed: false,
    orient: 'portrait',
    autoLandscape: false
  };
  session = s;

  const titleEl = root.querySelector('#pv-title')!;
  titleEl.textContent = resolved.title;
  video.src = resolved.url;
  video.playbackRate = state.settings.defaultSpeed;
  root.querySelector('#pv-speed')!.textContent = state.settings.defaultSpeed.toFixed(2).replace(/0$/, '') + 'x';

  // 恢复进度
  const rec = state.records[key];
  if (rec && rec.duration > 0 && rec.time / rec.duration < 0.95) {
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = Math.min(rec.time, Math.max(0, video.duration - 2));
    }, { once: true });
  }

  // v1.1.26：横屏视频自动切横屏（元数据拿到宽高后判断，宽>高即横屏）
  video.addEventListener('loadedmetadata', () => {
    if (video.videoWidth > video.videoHeight) {
      s.orient = 'landscapeLeft';
      s.autoLandscape = true;
      void setOrientation('landscapeLeft');
    }
  }, { once: true });

  // 本地视频自动匹配外挂字幕
  if (resolved.localName) {
    const subName = findMatchingSubtitle(resolved.localName);
    if (subName) {
      void loadSubtitleFile(resolved.localName, subName, s);
    }
  }

  bindPlayerEvents(video, s);
  void video.play().catch(() => {
    /* 自动播放被拦截时等用户点播放键 */
  });
  scheduleHide(s);
}

export function closePlayer(): void {
  if (session) {
    saveProgress(session);
    teardown();
  }
  history.back();
}

function teardown(): void {
  const s = session;
  if (!s) return;
  s.closed = true;
  if (s.hideTimer) window.clearTimeout(s.hideTimer);
  if (s.saveTimer) window.clearInterval(s.saveTimer);
  cancelAnimationFrame(s.raf);
  if (s.eqOn) s.eq.detach();
  // v1.1.26：不再释放 SMB 安全作用域——播放列表重播 / 连播需要会话存活，
  // 旧代码退出即 releaseSMBFile → 列表里再点同一视频 code=4（用户反馈的根因）。
  // 会话在 App 退出时由系统统一回收；用户显式删除时才 release。
  if (s.autoLandscape) void setOrientation('portrait');
  const video = root?.querySelector<HTMLVideoElement>('#pv');
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  root?.remove();
  root = null;
  session = null;
  document.body.classList.remove('player-open');
}

// ---- 事件绑定 ----

function bindPlayerEvents(video: HTMLVideoElement, s: PlayerSession): void {
  const r = root!;
  const seek = r.querySelector<HTMLInputElement>('#pv-seek')!;
  const cur = r.querySelector<HTMLElement>('#pv-cur')!;
  const dur = r.querySelector<HTMLElement>('#pv-dur')!;
  const buffer = r.querySelector<HTMLElement>('#pv-buffer')!;
  const playBtn = r.querySelector<HTMLElement>('#pv-play')!;

  r.querySelector('#pv-back')!.addEventListener('click', () => closePlayer());
  playBtn.addEventListener('click', () => {
    if (video.paused) void video.play();
    else video.pause();
    poke(s);
  });
  r.querySelector('#pv-rew')!.addEventListener('click', () => {
    video.currentTime = Math.max(0, video.currentTime - 10);
    poke(s);
  });
  r.querySelector('#pv-fwd2')!.addEventListener('click', () => {
    video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
    poke(s);
  });

  // v1.1.26：点画面 = 仅切换控制层显隐，不再暂停/播放（旧逻辑点一下就暂停，被用户判为错误）。
  // 播放/暂停只由中间大按钮与底部控制层触发。
  video.addEventListener('click', () => toggleControls(s));

  video.addEventListener('play', () => {
    playBtn.textContent = '❚❚';
    startSaveTimer(s);
    startSubtitleLoop(s);
  });
  video.addEventListener('pause', () => {
    playBtn.textContent = '▶';
    saveProgress(s);
  });
  video.addEventListener('ended', () => {
    saveProgress(s);
    if (state.settings.autoNext && s.index + 1 < s.context.length) {
      loadNext(s);
    }
  });
  video.addEventListener('error', () => {
    // 诊断：错误码 1=中止 2=网络 3=解码 4=源不受支持；currentSrc=媒体引擎实际解析到的 URL
    const code = video.error ? video.error.code : '无error对象';
    const msg = video.error ? video.error.message : '';
    const src = video.currentSrc || video.src || '(空)';
    toast(`播放失败 code=${code} src=${src} ${msg}`.slice(0, 200));
  });

  video.addEventListener('timeupdate', () => {
    if (!isFinite(video.duration) || video.duration <= 0) return;
    seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
    cur.textContent = fmtTime(video.currentTime);
    dur.textContent = fmtTime(video.duration);
    try {
      const b = video.buffered;
      if (b.length > 0) {
        buffer.style.width = ((b.end(b.length - 1) / video.duration) * 100).toFixed(2) + '%';
      }
    } catch {
      // 忽略
    }
  });

  let seeking = false;
  seek.addEventListener('input', () => {
    seeking = true;
    if (isFinite(video.duration) && video.duration > 0) {
      video.currentTime = (seek.valueAsNumber / 1000) * video.duration;
    }
    poke(s);
  });
  seek.addEventListener('change', () => {
    seeking = false;
  });

  // 倍速
  r.querySelector('#pv-speed')!.addEventListener('click', () => {
    const i = SPEEDS.indexOf(video.playbackRate);
    const next = SPEEDS[(i + 1) % SPEEDS.length];
    video.playbackRate = next;
    r.querySelector('#pv-speed')!.textContent = next.toFixed(2).replace(/0$/, '') + 'x';
    toast('倍速 ' + next + 'x');
    poke(s);
  });

  // 字幕开关
  r.querySelector('#pv-cc')!.addEventListener('click', () => {
    s.subtitleOn = !s.subtitleOn;
    r.querySelector('#pv-cc')!.classList.toggle('on', s.subtitleOn);
    updateSubtitle(s);
    poke(s);
  });

  // 截图
  r.querySelector('#pv-shot')!.addEventListener('click', () => {
    void doScreenshot(video, s);
  });

  // v1.1.26：移除画中画按钮——WKWebView 无 PiP JS API，该按钮在真机上一直是死的。

  // 投屏：切换系统控件（WKWebView 的 AirPlay 只在系统控件里可用）
  r.querySelector('#pv-airplay')!.addEventListener('click', () => {
    if (video.controls) {
      video.controls = false;
      toast('已切回自定义控件');
    } else {
      video.controls = true;
      toast('请在系统控件右下角点 AirPlay 图标投屏');
    }
    poke(s);
  });

  // v1.1.26：手动旋转 ⟲ / ⟳
  r.querySelector('#pv-rot-l')!.addEventListener('click', () => rotateScreen(s, 'left'));
  r.querySelector('#pv-rot-r')!.addEventListener('click', () => rotateScreen(s, 'right'));

  // v1.1.26：☰列表 → 播放列表面板
  r.querySelector('#pv-list')!.addEventListener('click', () => {
    renderPanel(s);
    poke(s);
  });
  r.querySelector('#pv-panel-mask')!.addEventListener('click', () => closePanel());

  // 更多面板
  r.querySelector('#pv-more')!.addEventListener('click', () => {
    renderSheet(video, s);
    poke(s);
  });
  r.querySelector('#pv-sheet-mask')!.addEventListener('click', () => closeSheet());

  // 控制层自动隐藏
  for (const id of ['#pv-center', '#pv-bottom', '#pv-top']) {
    r.querySelector(id)!.addEventListener('pointerdown', () => poke(s), { passive: true });
  }
}

function poke(s: PlayerSession): void {
  const r = root;
  if (!r) return;
  r.classList.remove('pv-hidden');
  if (s.hideTimer) window.clearTimeout(s.hideTimer);
  s.hideTimer = window.setTimeout(() => {
    if (!session || session.closed) return;
    const v = r.querySelector<HTMLVideoElement>('#pv');
    if (v && !v.paused) r.classList.add('pv-hidden');
  }, 3500);
}

function scheduleHide(s: PlayerSession): void {
  poke(s);
}

/** v1.1.26：点按切换控制层——隐藏时不启动自动隐藏计时，显示时启动。 */
function toggleControls(s: PlayerSession): void {
  const r = root;
  if (!r) return;
  if (r.classList.contains('pv-hidden')) {
    poke(s); // 显示 + 3.5s 后自动隐藏
  } else {
    r.classList.add('pv-hidden');
    if (s.hideTimer) {
      window.clearTimeout(s.hideTimer);
      s.hideTimer = null;
    }
  }
}

/** v1.1.26：手动旋转 ⟲/⟳，在 portrait→landscapeLeft→landscapeRight 间循环，可反复点。 */
function rotateScreen(s: PlayerSession, dir: 'left' | 'right'): void {
  const cycle: ScreenOrientation[] = ['portrait', 'landscapeLeft', 'landscapeRight'];
  const i = cycle.indexOf(s.orient);
  const next = dir === 'right' ? cycle[(i + 1) % cycle.length] : cycle[(i - 1 + cycle.length) % cycle.length];
  s.orient = next;
  s.autoLandscape = false; // 手动旋转后不再自动恢复
  void setOrientation(next);
  poke(s);
}

// ---- 连播 ----

function loadNext(s: PlayerSession): void {
  const nextKey = s.context[s.index + 1];
  const resolved = resolvePlayback(nextKey);
  if (!resolved) return;
  const video = root!.querySelector<HTMLVideoElement>('#pv')!;
  // v1.1.26：连播不再释放前一个 SMB 会话（释放会导致下一个/重播 code=4）
  s.key = nextKey;
  s.index++;
  s.cues = [];
  s.subtitleName = null;
  root!.querySelector('#pv-title')!.textContent = resolved.title;
  video.src = resolved.url;
  if (resolved.localName) {
    const subName = findMatchingSubtitle(resolved.localName);
    if (subName) void loadSubtitleFile(resolved.localName, subName, s);
  }
  void video.play().catch(() => undefined);
  saveProgress(s);
  toast('下一集：' + resolved.title);
}

// ---- 进度保存 ----

function startSaveTimer(s: PlayerSession): void {
  if (s.saveTimer) window.clearInterval(s.saveTimer);
  s.saveTimer = window.setInterval(() => saveProgress(s), 5000);
}

function saveProgress(s: PlayerSession): void {
  const video = root?.querySelector<HTMLVideoElement>('#pv');
  if (!video || !isFinite(video.duration) || video.duration <= 0) return;
  if (video.currentTime / video.duration >= 0.97) {
    // 播完的不存进度
    return;
  }
  saveRecord(s.key, video.currentTime, video.duration);
}

// ---- 字幕 ----

async function loadSubtitleFile(localVideoName: string, subName: string, s: PlayerSession): Promise<void> {
  const url = localUrl(subName);
  if (!url) return;
  const text = await readTextFile(url);
  if (!text) return;
  const cues = parseSubtitle(text, extOf(subName));
  if (cues.length === 0) return;
  s.cues = cues;
  s.subtitleName = subName;
  updateSubtitle(s);
  toast('已加载字幕：' + subName);
}

function startSubtitleLoop(s: PlayerSession): void {
  cancelAnimationFrame(s.raf);
  const loop = () => {
    if (!session || session.closed) return;
    updateSubtitle(s);
    s.raf = requestAnimationFrame(loop);
  };
  s.raf = requestAnimationFrame(loop);
}

function updateSubtitle(s: PlayerSession): void {
  const el = root?.querySelector<HTMLElement>('#pv-sub');
  const video = root?.querySelector<HTMLVideoElement>('#pv');
  if (!el || !video) return;
  if (!s.subtitleOn || s.cues.length === 0) {
    el.textContent = '';
    return;
  }
  const cue = cueAt(s.cues, video.currentTime);
  el.textContent = cue ? cue.text : '';
  const style = state.settings.subtitleStyle;
  el.style.fontSize = style.size + 'px';
  el.style.color = style.color;
  el.style.bottom = style.position + 'px';
  el.style.textShadow = outlineShadow(style.outline);
  el.style.backgroundColor =
    style.background > 0 ? `rgba(0,0,0,${(style.background / 100).toFixed(2)})` : 'transparent';
  el.style.padding = style.background > 0 ? '2px 8px' : '0';
  el.style.borderRadius = '4px';
}

function outlineShadow(outline: number): string {
  if (outline <= 0) return 'none';
  const o = Math.max(1, Math.round(outline));
  return `${o}px 0 0 #000, 0 ${o}px 0 #000, -${o}px 0 0 #000, 0 -${o}px 0 #000`;
}

/** 手动加载字幕文件（播放器内按钮） */
async function pickSubtitle(s: PlayerSession): Promise<void> {
  const files = await pickMedia(true);
  const sub = files.find((f) => f.kind === 'subtitle');
  if (!sub) return;
  const text = await readTextFile(sub.url);
  if (!text) {
    toast('字幕读取失败');
    return;
  }
  const cues = parseSubtitle(text, extOf(sub.name));
  if (cues.length === 0) {
    toast('字幕解析结果为空');
    return;
  }
  s.cues = cues;
  s.subtitleName = sub.name;
  s.subtitleOn = true;
  root?.querySelector('#pv-cc')!.classList.add('on');
  updateSubtitle(s);
  toast('已加载字幕：' + sub.name);
}

// ---- 截图 ----

async function doScreenshot(video: HTMLVideoElement, s: PlayerSession): Promise<void> {
  let dataUrl: string | null = null;
  if (session && s.key.startsWith('local:')) {
    const name = s.key.slice(6);
    const b64 = await captureFrame(name, video.currentTime);
    if (b64) dataUrl = 'data:image/jpeg;base64,' + b64;
  }
  if (!dataUrl) {
    // 网络源：尝试 canvas 捕获（可能被 CORS 污染）
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no ctx');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    } catch {
      toast('该来源不支持截图（跨域限制）');
      return;
    }
  }
  showShotModal(dataUrl);
}

function showShotModal(dataUrl: string): void {
  const r = root!;
  const old = r.querySelector('.pv-shot-modal');
  old?.remove();
  const modal = document.createElement('div');
  modal.className = 'pv-shot-modal';
  modal.innerHTML = `
    <img src="${dataUrl}" alt="截图" />
    <div class="pv-shot-actions">
      <button class="pv-btn" data-act="save">保存到相册</button>
      <button class="pv-btn" data-act="close">关闭</button>
    </div>
  `;
  r.appendChild(modal);
  modal.querySelector('[data-act="close"]')!.addEventListener('click', () => modal.remove());
  modal.querySelector('[data-act="save"]')!.addEventListener('click', async () => {
    const b64 = dataUrl.split(',')[1];
    const ok = await saveImageToPhotos(b64);
    toast(ok ? '已保存到相册' : '保存失败（未授权相册权限）');
    modal.remove();
  });
}

// ---- 更多面板（倍速/字幕样式/EQ/色彩/播放列表） ----

function renderSheet(video: HTMLVideoElement, s: PlayerSession): void {
  const sheet = root!.querySelector('#pv-sheet')!;
  const style = state.settings.subtitleStyle;
  const speed = video.playbackRate;

  const playlistOptions = state.playlists
    .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
    .join('');

  sheet.innerHTML = `
    <div class="pv-sheet-head">
      <span>播放设置</span>
      <button class="pv-btn" id="pv-sheet-close">完成</button>
    </div>
    <div class="pv-sheet-body">
      <section class="pv-sec">
        <h4>倍速</h4>
        <div class="pv-speed-row">
          ${SPEEDS.map(
            (sp) =>
              `<button class="pv-chip ${sp === speed ? 'on' : ''}" data-speed="${sp}">${sp.toFixed(2).replace(/0$/, '')}x</button>`
          ).join('')}
        </div>
      </section>
      <section class="pv-sec">
        <h4>字幕</h4>
        <div class="pv-row">
          <label>显示字幕</label>
          <input type="checkbox" id="pv-sub-on" ${s.subtitleOn ? 'checked' : ''} />
        </div>
        <div class="pv-row">
          <label>加载字幕文件</label>
          <button class="pv-btn" id="pv-sub-load">${s.subtitleName ? '已加载 ' + escapeHtml(s.subtitleName) : '选择字幕'}</button>
        </div>
        <div class="pv-row"><label>字号 <span id="pv-sub-size-v">${style.size}px</span></label>
          <input type="range" id="pv-sub-size" min="12" max="40" value="${style.size}" /></div>
        <div class="pv-row"><label>描边</label>
          <input type="range" id="pv-sub-outline" min="0" max="4" value="${style.outline}" /></div>
        <div class="pv-row"><label>背景不透明</label>
          <input type="range" id="pv-sub-bg" min="0" max="100" value="${style.background}" /></div>
        <div class="pv-row"><label>底部偏移</label>
          <input type="range" id="pv-sub-pos" min="16" max="160" value="${style.position}" /></div>
        <div class="pv-row"><label>颜色</label>
          <input type="color" id="pv-sub-color" value="${style.color}" /></div>
      </section>
      <section class="pv-sec">
        <h4>均衡器（EQ）</h4>
        <div class="pv-row">
          <label>启用 EQ</label>
          <input type="checkbox" id="pv-eq-on" ${s.eqOn ? 'checked' : ''} />
        </div>
        <div class="pv-eq-grid" id="pv-eq-grid">
          ${EQ_BAND_LABELS.map(
            (label, i) =>
              `<div class="pv-eq-band"><span>${label}</span><input type="range" min="-12" max="12" step="1" value="${s.eq.gains[i] ?? 0}" data-eq="${i}" /><em id="pv-eq-v-${i}">${s.eq.gains[i] ?? 0}</em></div>`
          ).join('')}
        </div>
      </section>
      <section class="pv-sec">
        <h4>画面色彩</h4>
        <div class="pv-row"><label>亮度</label><input type="range" id="pv-c-b" min="50" max="150" value="${Math.round(s.color.brightness * 100)}" /></div>
        <div class="pv-row"><label>对比度</label><input type="range" id="pv-c-c" min="50" max="150" value="${Math.round(s.color.contrast * 100)}" /></div>
        <div class="pv-row"><label>饱和度</label><input type="range" id="pv-c-s" min="0" max="200" value="${Math.round(s.color.saturation * 100)}" /></div>
        <div class="pv-row"><label>色相</label><input type="range" id="pv-c-h" min="-180" max="180" value="${s.color.hue}" /></div>
        <div class="pv-row"><button class="pv-btn" id="pv-c-reset">恢复默认</button></div>
      </section>
      <section class="pv-sec">
        <h4>加入播放列表</h4>
        <div class="pv-row">
          <select id="pv-pl-select">${playlistOptions || '<option value="">（暂无播放列表，去「列表」页创建）</option>'}</select>
          <button class="pv-btn" id="pv-pl-add">添加</button>
        </div>
      </section>
    </div>
  `;
  root!.classList.add('pv-sheet-open');

  sheet.querySelector('#pv-sheet-close')!.addEventListener('click', closeSheet);
  sheet.querySelectorAll('[data-speed]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sp = parseFloat((btn as HTMLElement).dataset.speed || '1');
      video.playbackRate = sp;
      root!.querySelector('#pv-speed')!.textContent = sp.toFixed(2).replace(/0$/, '') + 'x';
      sheet.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('on', b === btn));
      poke(s);
    });
  });

  const subOn = sheet.querySelector<HTMLInputElement>('#pv-sub-on')!;
  subOn.addEventListener('change', () => {
    s.subtitleOn = subOn.checked;
    root!.querySelector('#pv-cc')!.classList.toggle('on', subOn.checked);
    updateSubtitle(s);
  });
  sheet.querySelector('#pv-sub-load')!.addEventListener('click', () => void pickSubtitle(s));

  const applyStyle = () => {
    const patch = {
      size: parseInt(sheet.querySelector<HTMLInputElement>('#pv-sub-size')!.value, 10),
      outline: parseInt(sheet.querySelector<HTMLInputElement>('#pv-sub-outline')!.value, 10),
      background: parseInt(sheet.querySelector<HTMLInputElement>('#pv-sub-bg')!.value, 10),
      position: parseInt(sheet.querySelector<HTMLInputElement>('#pv-sub-pos')!.value, 10),
      color: sheet.querySelector<HTMLInputElement>('#pv-sub-color')!.value
    };
    sheet.querySelector('#pv-sub-size-v')!.textContent = patch.size + 'px';
    setSettings({ subtitleStyle: patch });
    updateSubtitle(s);
  };
  for (const id of ['#pv-sub-size', '#pv-sub-outline', '#pv-sub-bg', '#pv-sub-pos', '#pv-sub-color']) {
    sheet.querySelector(id)!.addEventListener('input', applyStyle);
  }

  const eqOn = sheet.querySelector<HTMLInputElement>('#pv-eq-on')!;
  eqOn.addEventListener('change', () => {
    if (eqOn.checked) {
      if (s.eq.attach(video)) {
        s.eqOn = true;
        toast('EQ 已启用');
      } else {
        eqOn.checked = false;
        toast('EQ 启动失败（浏览器不支持）');
      }
    } else {
      s.eq.detach();
      s.eqOn = false;
      toast('EQ 已关闭');
    }
  });
  sheet.querySelectorAll('[data-eq]').forEach((input) => {
    input.addEventListener('input', () => {
      const i = parseInt((input as HTMLElement).dataset.eq || '0', 10);
      const v = parseInt((input as HTMLInputElement).value, 10);
      s.eq.setGain(i, v);
      sheet.querySelector(`#pv-eq-v-${i}`)!.textContent = String(v);
    });
  });

  const applyColor = () => {
    s.color = {
      brightness: parseInt(sheet.querySelector<HTMLInputElement>('#pv-c-b')!.value, 10) / 100,
      contrast: parseInt(sheet.querySelector<HTMLInputElement>('#pv-c-c')!.value, 10) / 100,
      saturation: parseInt(sheet.querySelector<HTMLInputElement>('#pv-c-s')!.value, 10) / 100,
      hue: parseInt(sheet.querySelector<HTMLInputElement>('#pv-c-h')!.value, 10)
    };
    video.style.filter = `brightness(${s.color.brightness}) contrast(${s.color.contrast}) saturate(${s.color.saturation}) hue-rotate(${s.color.hue}deg)`;
  };
  for (const id of ['#pv-c-b', '#pv-c-c', '#pv-c-s', '#pv-c-h']) {
    sheet.querySelector(id)!.addEventListener('input', applyColor);
  }
  sheet.querySelector('#pv-c-reset')!.addEventListener('click', () => {
    s.color = { brightness: 1, contrast: 1, saturation: 1, hue: 0 };
    sheet.querySelector<HTMLInputElement>('#pv-c-b')!.value = '100';
    sheet.querySelector<HTMLInputElement>('#pv-c-c')!.value = '100';
    sheet.querySelector<HTMLInputElement>('#pv-c-s')!.value = '100';
    sheet.querySelector<HTMLInputElement>('#pv-c-h')!.value = '0';
    video.style.filter = 'none';
  });

  sheet.querySelector('#pv-pl-add')!.addEventListener('click', () => {
    const plId = sheet.querySelector<HTMLSelectElement>('#pv-pl-select')!.value;
    if (!plId) {
      toast('请先创建播放列表');
      return;
    }
    addToPlaylist(plId, s.key);
    toast('已加入播放列表');
  });
}

function closeSheet(): void {
  root?.classList.remove('pv-sheet-open');
}

// ---- v1.1.26：☰列表面板（正在播放高亮；空列表时回退到当前文件所在层级的全部视频） ----

async function renderPanel(s: PlayerSession): Promise<void> {
  const panel = root!.querySelector('#pv-panel')!;
  panel.innerHTML = '<div class="loading">加载中…</div>';
  root!.classList.add('pv-panel-open');

  let title = '当前列表';
  let items: string[] = [];
  if (s.context.length > 1) {
    title = '连播列表';
    items = s.context;
  } else if (s.key.startsWith('local:')) {
    const rest = s.key.slice(6);
    const slash = rest.lastIndexOf('/');
    const folder = slash >= 0 ? rest.slice(0, slash) : '';
    title = folder ? '本文件夹 · ' + folder : '本文件夹 · 根目录';
    items = state.library
      .filter((f) => f.kind === 'video' && (f.folder ?? '') === folder)
      .map((f) => 'local:' + (folder ? folder + '/' : '') + f.name);
  } else if (s.key.startsWith('smb:')) {
    const rel = s.key.slice(4);
    const slash = rel.lastIndexOf('/');
    const parent = slash >= 0 ? rel.slice(0, slash) : '';
    title = '本文件夹 · NAS ' + (parent || '共享根');
    const src = state.sources.find((x) => x.type === 'smb');
    if (src) {
      try {
        const dir = await listSMBDir({ host: src.host, port: src.port, share: src.share ?? '', path: parent });
        items = dir.files.filter((f) => f.kind === 'video').map((f) => 'smb:' + (parent ? parent + '/' : '') + f.name);
      } catch {
        items = [s.key];
      }
    } else {
      items = [s.key];
    }
  } else {
    items = [s.key];
  }

  if (items.length === 0) items = [s.key];
  panel.innerHTML = `
    <div class="pv-panel-head">
      <span>${escapeHtml(title)}</span>
      <button class="pv-btn" id="pv-panel-close">完成</button>
    </div>
    <div class="pv-panel-body">
      ${items
        .map(
          (k, i) => `
        <div class="pv-pl-row ${k === s.key ? 'on' : ''}" data-pk="${escapeHtml(k)}">
          <span class="pv-pl-idx">${i + 1}</span>
          <span class="pv-pl-name">${escapeHtml(titleOfKey(k))}</span>
          ${k === s.key ? '<span class="pv-pl-now">播放中</span>' : ''}
        </div>`
        )
        .join('')}
    </div>
  `;
  panel.querySelector('#pv-panel-close')!.addEventListener('click', closePanel);
  panel.querySelectorAll('.pv-pl-row').forEach((rowEl) => {
    rowEl.addEventListener('click', () => {
      const k = (rowEl as HTMLElement).dataset.pk || '';
      if (!k || k === s.key) return;
      playFromList(s, items, k);
    });
  });
}

function closePanel(): void {
  root?.classList.remove('pv-panel-open');
}

/** 面板里点选某条：以 items 为连播顺序跳到该项 */
function playFromList(s: PlayerSession, items: string[], key: string): void {
  const resolved = resolvePlayback(key);
  if (!resolved) {
    toast('无法解析播放地址');
    return;
  }
  const video = root!.querySelector<HTMLVideoElement>('#pv')!;
  s.context = items;
  s.index = Math.max(0, items.indexOf(key));
  s.key = key;
  s.cues = [];
  s.subtitleName = null;
  root!.querySelector('#pv-title')!.textContent = resolved.title;
  video.src = resolved.url;
  if (resolved.localName) {
    const subName = findMatchingSubtitle(resolved.localName);
    if (subName) void loadSubtitleFile(resolved.localName, subName, s);
  }
  closePanel();
  void video.play().catch(() => undefined);
  toast('已切换：' + resolved.title);
}
