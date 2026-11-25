// 设置：默认倍速 / 自动连播 / 字幕样式 / 清空缓存 / 关于

import { state, setSettings, clearLibrary } from '../core/store';
import { clearLocalCache, isNative, readLog, clearLog, selfTest, localUrl } from '../native/localMedia';
import { confirmDialog, toast, modal } from '../components/ui';
import { fmtSize, escapeHtml } from '../core/util';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

export function renderSettings(el: HTMLElement): void {
  const s = state.settings;
  el.innerHTML = `
    <div class="page-head"><h1>设置</h1></div>
    <div class="set-group">
      <h3>播放</h3>
      <div class="set-row">
        <label>默认倍速</label>
        <select id="set-speed">
          ${SPEEDS.map((sp) => `<option value="${sp}" ${sp === s.defaultSpeed ? 'selected' : ''}>${sp}x</option>`).join('')}
        </select>
      </div>
      <div class="set-row">
        <label>播完自动播放下一集</label>
        <input type="checkbox" id="set-autonext" ${s.autoNext ? 'checked' : ''} />
      </div>
    </div>
    <div class="set-group">
      <h3>字幕默认样式</h3>
      <div class="set-row"><label>字号 <span id="set-sub-size-v">${s.subtitleStyle.size}px</span></label>
        <input type="range" id="set-sub-size" min="12" max="40" value="${s.subtitleStyle.size}" /></div>
      <div class="set-row"><label>描边</label>
        <input type="range" id="set-sub-outline" min="0" max="4" value="${s.subtitleStyle.outline}" /></div>
      <div class="set-row"><label>背景不透明</label>
        <input type="range" id="set-sub-bg" min="0" max="100" value="${s.subtitleStyle.background}" /></div>
      <div class="set-row"><label>底部偏移</label>
        <input type="range" id="set-sub-pos" min="16" max="160" value="${s.subtitleStyle.position}" /></div>
      <div class="set-row"><label>颜色</label>
        <input type="color" id="set-sub-color" value="${s.subtitleStyle.color}" /></div>
    </div>
    <div class="set-group">
      <h3>播放自测（装机验证）</h3>
      <p class="set-about">一键验证原生播放链路：内置样本 → localmedia:// 读取 → 媒体引擎解码。全部通过 = App 本身能播视频，问题只会出在网络源；有失败项 = 点「复制自测结果」或「查看日志」把文字直接发给开发者。</p>
      <div class="pl-actions">
        <button class="app-btn primary" id="set-selftest" ${isNative ? '' : 'disabled'}>🎬 运行播放自测</button>
        <button class="app-btn" id="set-selftest-copy" ${isNative ? '' : 'disabled'}>📋 复制自测结果</button>
      </div>
      <div id="selftest-result" class="selftest-box"></div>
    </div>
    <div class="set-group">
      <h3>存储</h3>
      <div class="set-row">
        <label>本地缓存</label>
        <span id="set-cache-size" class="set-val"></span>
      </div>
      <button class="app-btn danger" id="set-clear">清空本地缓存</button>
    </div>
    <div class="set-group">
      <h3>调试日志（闪退排查用）</h3>
      <p class="set-about">点「查看日志」读取 App 原生层日志。遇到闪退：重启 App 后来这里查看/复制，发给开发者即可定位。</p>
      <div class="pl-actions">
        <button class="app-btn" id="set-log-view">查看日志</button>
        <button class="app-btn danger" id="set-log-clear" style="margin-top:8px">清空日志</button>
      </div>
    </div>
    <div class="set-group">
      <h3>关于</h3>
      <p class="set-about">视频播放器 v${__APP_VERSION__}<br />
      仿 VidHub 功能复刻（本地视频 / WebDAV / SMB / Emby / Jellyfin）。<br />
      基于 Web 技术栈 + Capacitor 构建，仅学习研究使用。</p>
    </div>
  `;

  el.querySelector<HTMLSelectElement>('#set-speed')!.addEventListener('change', (e) => {
    setSettings({ defaultSpeed: parseFloat((e.target as HTMLSelectElement).value) });
    toast('已保存');
  });
  el.querySelector<HTMLInputElement>('#set-autonext')!.addEventListener('change', (e) => {
    setSettings({ autoNext: (e.target as HTMLInputElement).checked });
    toast('已保存');
  });

  const applyStyle = () => {
    setSettings({
      subtitleStyle: {
        size: parseInt(el.querySelector<HTMLInputElement>('#set-sub-size')!.value, 10),
        outline: parseInt(el.querySelector<HTMLInputElement>('#set-sub-outline')!.value, 10),
        background: parseInt(el.querySelector<HTMLInputElement>('#set-sub-bg')!.value, 10),
        position: parseInt(el.querySelector<HTMLInputElement>('#set-sub-pos')!.value, 10),
        color: el.querySelector<HTMLInputElement>('#set-sub-color')!.value
      }
    });
    el.querySelector('#set-sub-size-v')!.textContent =
      el.querySelector<HTMLInputElement>('#set-sub-size')!.value + 'px';
  };
  for (const id of ['#set-sub-size', '#set-sub-outline', '#set-sub-bg', '#set-sub-pos', '#set-sub-color']) {
    el.querySelector(id)!.addEventListener('input', applyStyle);
  }

  el.querySelector('#set-selftest')!.addEventListener('click', () => void runSelfTest(el));
  // v1.1.20：把自测结果序列化成纯文本复制——用户直接粘贴给开发者，不再截屏
  el.querySelector('#set-selftest-copy')!.addEventListener('click', () => {
    const box = el.querySelector<HTMLElement>('#selftest-result')!;
    const lines = Array.from(box.querySelectorAll('.selftest-row, .selftest-sum'))
      .map((n) => n.textContent?.trim() || '');
    const text = lines.length
      ? lines.join('\n')
      : '（还没有自测结果，先点「运行播放自测」）';
    copyText(text).then(
      () => toast('已复制自测结果，直接粘贴发给开发者'),
      () => toast('复制失败，请长按文本手动复制')
    );
  });
  el.querySelector('#set-log-view')!.addEventListener('click', async () => {
    toast('正在读取日志…');
    const log = await readLog();
    showLogModal(log);
  });
  el.querySelector('#set-log-clear')!.addEventListener('click', async () => {
    const ok = await confirmDialog('清空原生调试日志？');
    if (!ok) return;
    await clearLog();
    toast('已清空');
  });

  function showLogModal(log: string): void {
    const wrap = modal('调试日志', `
      <pre class="log-view">${log ? escapeHtml(log) : '（暂无日志）'}</pre>
      <div class="pl-actions">
        <button class="app-btn primary" data-act="copy">复制全部日志</button>
      </div>
    `);
    wrap.querySelector('[data-act="copy"]')!.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(log || '（暂无日志）');
        toast('已复制到剪贴板，直接粘贴发给开发者');
      } catch {
        toast('复制失败，请长按文本手动复制');
      }
    });
  }

  const total = state.library.reduce((a, f) => a + f.size, 0);
  el.querySelector('#set-cache-size')!.textContent = isNative ? fmtSize(total) : '（浏览器模式无缓存）';
  el.querySelector('#set-clear')!.addEventListener('click', async () => {
    if (!isNative) {
      toast('浏览器模式没有本地缓存');
      return;
    }
    const ok = await confirmDialog('清空本地缓存？所有已导入的视频都会删除。', '清空');
    if (!ok) return;
    await clearLocalCache();
    clearLibrary();
    toast('已清空');
    renderSettings(el);
  });
}

/** 播放自测：内置样本 → Range 探测 → 全量读取 → <video> 真实解码播放。
 *  v1.1.19：每步独立 try/catch——中间步骤失败（如 fetch 被 CORS 预检拒绝）不再中止，
 *  必须跑到媒体引擎那一步，那才是真结论。<video> 元素不做 CORS，与 fetch 是两条路。 */
async function runSelfTest(el: HTMLElement): Promise<void> {
  const box = el.querySelector<HTMLElement>('#selftest-result')!;
  box.innerHTML = '<div class="selftest-row">正在自测…</div>';
  const row = (label: string, ok: boolean, detail: string): void => {
    const line = document.createElement('div');
    line.className = 'selftest-row ' + (ok ? 'ok' : 'fail');
    line.textContent = (ok ? '✓ ' : '✗ ') + label + '　' + detail;
    box.appendChild(line);
  };

  // 1. 样本就绪（原生层把内置 sample.mp4 复制进媒体缓存目录）
  let url: string | null = null;
  let size = 0;
  try {
    const st = await selfTest();
    url = localUrl(st.name);
    size = st.size;
    if (!url) throw new Error('localUrl 返回空');
    row('内置样本就绪', true, `${st.name} ${fmtSize(st.size)}`);
  } catch (e) {
    row('内置样本就绪', false, String(e));
  }
  if (!url) {
    finishSummary(box, false, false);
    return;
  }

  // 2. Range 探测（模拟媒体引擎的切片请求）。fetch 走 CORS，若被预检拒绝此步 ✗，
  //    但不影响 <video> 元素——继续后续步骤。
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-99' } });
    const rb = await r.arrayBuffer();
    const cr = r.headers.get('content-range') || '（无）';
    row('Range 请求 206', r.status === 206 && rb.byteLength === 100, `status=${r.status} len=${rb.byteLength} content-range=${cr}`);
  } catch (e) {
    row('Range 请求 206', false, String(e) + '（fetch/CORS 被拒；媒体引擎结论看第 4 步）');
  }

  // 3. 全量读取
  try {
    const f = await fetch(url);
    const fb = await f.arrayBuffer();
    row('全量请求 200', f.status === 200 && fb.byteLength === size, `status=${f.status} len=${fb.byteLength}/${size}`);
  } catch (e) {
    row('全量请求 200', false, String(e));
  }

  // 4/5. 真实播放（媒体引擎解码 + 推进）——最关键的步骤，必定执行
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  v.style.cssText = 'position:fixed;left:-9999px;top:0;width:160px;height:90px;';
  document.body.appendChild(v);
  const playing = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 10000);
    const done = (ok: boolean) => {
      clearTimeout(t);
      resolve(ok);
    };
    v.addEventListener('playing', () => done(true), { once: true });
    v.addEventListener('error', () => done(false), { once: true });
    v.play().catch(() => done(false));
  });
  let advanced = false;
  if (!playing) {
    row('媒体引擎开始播放', false, `error code=${v.error ? v.error.code : '无'}（4=源被拒绝/找不到，1=加载中断，2=网络问题，3=解码失败）`);
  } else {
    row('媒体引擎开始播放', true, `分辨率 ${v.videoWidth}x${v.videoHeight} @ ${v.currentTime.toFixed(2)}s`);
    await new Promise((res) => setTimeout(res, 1500));
    advanced = v.currentTime > 0.5;
    row('播放推进 >0.5s', advanced, `currentTime=${v.currentTime.toFixed(2)}s`);
  }
  v.pause();
  v.removeAttribute('src');
  v.load();
  v.remove();

  finishSummary(box, playing && advanced, false);
}

function finishSummary(box: HTMLElement, videoOK: boolean, _unused: boolean): void {
  const fails = box.querySelectorAll('.selftest-row.fail').length;
  const sum = document.createElement('div');
  if (videoOK) {
    sum.className = 'selftest-sum ok';
    sum.textContent = fails > 0
      ? '结论：✅ 媒体引擎播放正常（fetch 探针失败只是 CORS 语义，不影响视频）。NAS 视频仍播不了请把完整日志发开发者。'
      : '结论：✅ 原生播放链路（scheme handler + 媒体引擎）全部正常。若 NAS 视频仍播不了，问题在网络源/账号，不是 App。';
  } else {
    sum.className = 'selftest-sum fail';
    sum.textContent = `结论：❌ 媒体引擎未播放成功（${fails} 项未通过）—— 点下方「查看日志」把完整原生日志复制给开发者（重点看「scheme 请求」行）。`;
  }
  box.appendChild(sum);
}

/** v1.1.20：通用复制——优先 Clipboard API，WKWebView 自定义 scheme 源上不可用时
 *  退回 textarea + execCommand('copy')（同步用户手势内调用，兼容性最好）。 */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('execCommand copy failed');
}
