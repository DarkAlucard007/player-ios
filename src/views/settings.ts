// 设置：默认倍速 / 自动连播 / 字幕样式 / 清空缓存 / 关于

import { state, setSettings, clearLibrary } from '../core/store';
import { clearLocalCache, isNative, readLog, clearLog } from '../native/localMedia';
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
      <p class="set-about">视频播放器 v1.1.2<br />
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
