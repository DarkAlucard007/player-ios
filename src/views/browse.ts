// 浏览：媒体源管理（添加/测试/删除）+ WebDAV 目录浏览 + Emby/Jellyfin 媒体库浏览 + 云端重命名/删除

import { state, addSource, removeSource } from '../core/store';
import type { MediaItem, Source, SourceType } from '../core/types';
import { browseSource, testSource, makeWebDAV, getSource } from '../sources/registry';
import { openPlayer } from '../player/player';
import { nav } from '../router';
import { confirmDialog, modal, promptDialog, toast } from '../components/ui';
import { fmtSize, escapeHtml, isVideoName } from '../core/util';
import { browseSMB, listSMBFiles, pickMedia } from '../native/localMedia';
import { addLocalFiles } from '../core/store';

export function renderBrowse(el: HTMLElement, hash: string): void {
  const query = new URLSearchParams(hash.split('?')[1] || '');
  const srcId = query.get('src');
  const wantAdd = query.get('add') === '1';

  el.innerHTML = `
    <div class="page-head">
      <h1>浏览</h1>
      <div class="page-actions">
        <button class="app-btn" id="br-add">+ 添加源</button>
      </div>
    </div>
    <div id="br-body"></div>
  `;
  el.querySelector('#br-add')!.addEventListener('click', () => showAddSource());

  const body = el.querySelector<HTMLElement>('#br-body')!;
  if (srcId) {
    const source = getSource(srcId);
    if (source) {
      void renderSourceBrowser(body, source, source.type === 'webdav' ? source.rootPath || '' : '');
      return;
    }
  }
  renderSourceList(body);
  // 添加/删除源后刷新列表（不重渲染源内浏览，避免丢失目录状态）
  const onSrcRefresh = () => {
    if (!el.isConnected) return;
    if (!el.querySelector('.br-toolbar')) renderSourceList(body);
  };
  window.addEventListener('app:src-refresh', onSrcRefresh);
  if (wantAdd) showAddSource();
}

// ---- 源列表 ----

function renderSourceList(body: HTMLElement): void {
  body.innerHTML = '';
  if (state.sources.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="empty-icon">📡</div>
      <p>还没有媒体源</p>
      <p class="empty-sub">支持 WebDAV（群晖/NAS）和 Emby / Jellyfin 媒体服务器</p>
      <button class="app-btn primary" id="empty-add">添加媒体源</button>
    `;
    empty.querySelector('#empty-add')!.addEventListener('click', showAddSource);
    body.appendChild(empty);
    return;
  }
  for (const s of state.sources) {
    const row = document.createElement('div');
    row.className = 'src-row';
    const icon = s.type === 'webdav' ? '🗂' : s.type === 'smb' ? '🖥' : '📡';
    const sub =
      s.type === 'webdav' && s.rootPath
        ? ' ' + escapeHtml(s.rootPath)
        : s.type === 'smb'
          ? (s.share ? ' / ' + escapeHtml(s.share) : '')
          : '';
    row.innerHTML = `
      <span class="src-icon">${icon}</span>
      <div class="src-main">
        <div class="src-name">${escapeHtml(s.name)}</div>
        <div class="src-host">${escapeHtml(s.host)}${sub}</div>
      </div>
      <button class="src-del" aria-label="删除源">×</button>
    `;
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.src-del')) return;
      nav('#/browse?src=' + s.id);
    });
    row.querySelector('.src-del')!.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog(`删除媒体源「${s.name}」？`);
      if (!ok) return;
      removeSource(s.id);
      toast('已删除');
      renderSourceList(body);
    });
    body.appendChild(row);
  }
}

// ---- 添加源 ----

function showAddSource(): void {
  const wrap = modal('添加媒体源', `
    <div class="form">
      <label>类型</label>
      <select id="f-type">
        <option value="webdav">WebDAV（群晖 / NAS / 自建）</option>
        <option value="smb">SMB（Windows 共享 / 群晖 \\\\IP\\共享）</option>
        <option value="emby">Emby 服务器</option>
        <option value="jellyfin">Jellyfin 服务器</option>
      </select>
      <label>名称</label>
      <input id="f-name" type="text" placeholder="例如：客厅 NAS" />
      <div id="f-wdav">
        <label>地址</label>
        <input id="f-host" type="text" placeholder="http://192.168.1.10:5005/webdav/video" />
        <label>用户名（可选）</label>
        <input id="f-user" type="text" placeholder="留空则匿名" />
        <label>密码（可选）</label>
        <input id="f-pass" type="password" placeholder="留空则匿名" />
        <label>根路径（可选）</label>
        <input id="f-root" type="text" placeholder="例如 /video" />
      </div>
      <div id="f-smb" style="display:none">
        <label>NAS 地址（IP）</label>
        <input id="f-smb-host" type="text" placeholder="例如 10.168.3.218" />
        <label>端口（默认 445）</label>
        <input id="f-smb-port" type="text" placeholder="445" />
        <label>用户名</label>
        <input id="f-smb-user" type="text" placeholder="例如 Alucard" />
        <label>密码</label>
        <input id="f-smb-pass" type="password" placeholder="NAS 账号密码" />
        <label>共享文件夹名（必填）</label>
        <input id="f-smb-share" type="text" placeholder="例如 video（\\\\IP\\video 里的 video）" />
      </div>
      <div id="f-ms" style="display:none">
        <label>地址</label>
        <input id="f-ms-host" type="text" placeholder="http://192.168.1.10:8096" />
        <label>API Key</label>
        <input id="f-key" type="text" placeholder="服务器设置 → 高级 → API 密钥" />
      </div>
      <div class="form-btns">
        <button class="app-btn" id="f-test">测试连接</button>
        <button class="app-btn primary" id="f-save">保存</button>
      </div>
      <div id="f-status" class="form-status"></div>
    </div>
  `);

  const typeSel = wrap.querySelector<HTMLSelectElement>('#f-type')!;
  const toggle = () => {
    const t = typeSel.value;
    wrap.querySelector<HTMLElement>('#f-wdav')!.style.display = t === 'webdav' ? '' : 'none';
    wrap.querySelector<HTMLElement>('#f-smb')!.style.display = t === 'smb' ? '' : 'none';
    wrap.querySelector<HTMLElement>('#f-ms')!.style.display = t === 'emby' || t === 'jellyfin' ? '' : 'none';
  };
  typeSel.addEventListener('change', toggle);
  toggle();

  const readForm = (): Omit<Source, 'id'> => {
    const type = typeSel.value as SourceType;
    const base = {
      type,
      name: wrap.querySelector<HTMLInputElement>('#f-name')!.value.trim() || '未命名源'
    };
    if (type === 'webdav') {
      return {
        ...base,
        host: wrap.querySelector<HTMLInputElement>('#f-host')!.value.trim(),
        user: wrap.querySelector<HTMLInputElement>('#f-user')!.value.trim() || undefined,
        pass: wrap.querySelector<HTMLInputElement>('#f-pass')!.value || undefined,
        rootPath: wrap.querySelector<HTMLInputElement>('#f-root')!.value.trim() || undefined
      };
    }
    if (type === 'smb') {
      return {
        ...base,
        host: wrap.querySelector<HTMLInputElement>('#f-smb-host')!.value.trim(),
        port: wrap.querySelector<HTMLInputElement>('#f-smb-port')!.value.trim() || '445',
        user: wrap.querySelector<HTMLInputElement>('#f-smb-user')!.value.trim() || undefined,
        pass: wrap.querySelector<HTMLInputElement>('#f-smb-pass')!.value || undefined,
        share: wrap.querySelector<HTMLInputElement>('#f-smb-share')!.value.trim() || undefined
      };
    }
    return {
      ...base,
      host: wrap.querySelector<HTMLInputElement>('#f-ms-host')!.value.trim(),
      apiKey: wrap.querySelector<HTMLInputElement>('#f-key')!.value.trim() || undefined
    };
  };

  wrap.querySelector('#f-test')!.addEventListener('click', async () => {
    const status = wrap.querySelector('#f-status')!;
    const src = readForm();
    if (!src.host) {
      status.textContent = '请先填写地址';
      return;
    }
    if (src.type === 'smb') {
      status.textContent = 'SMB 走系统「文件」App，点「保存」后按页面指引操作即可';
      return;
    }
    status.textContent = '连接中…';
    const ok = await testSource({ ...src, id: 'test' });
    status.textContent = ok ? '✓ 连接成功' : '✗ 连接失败（检查地址/账号/网络）';
  });

  wrap.querySelector('#f-save')!.addEventListener('click', () => {
    const src = readForm();
    if (!src.host) {
      wrap.querySelector('#f-status')!.textContent = '请先填写地址';
      return;
    }
    if (src.type === 'smb' && !src.share) {
      wrap.querySelector('#f-status')!.textContent = '请填写共享文件夹名（你的情况是 video）';
      return;
    }
    addSource(src);
    wrap.remove();
    window.dispatchEvent(new Event('app:src-refresh'));
    toast(src.type === 'smb' ? '已添加，点进去按指引连接' : '已添加，点进去浏览');
  });
}

// ---- 源内浏览 ----

async function renderSourceBrowser(body: HTMLElement, source: Source, path: string): Promise<void> {
  if (source.type === 'smb') {
    renderSMBBrowser(body, source);
    return;
  }
  body.innerHTML = `
    <div class="br-toolbar">
      <button class="app-btn" id="br-back">‹ 源列表</button>
      <span class="br-path" id="br-path"></span>
    </div>
    <div id="br-items" class="br-items"><div class="loading">加载中…</div></div>
  `;
  body.querySelector('#br-back')!.addEventListener('click', () => nav('#/browse'));
  const pathEl = body.querySelector('#br-path')!;
  pathEl.textContent = source.name + (path ? ' / ' + path.replace(/^\/+/, '') : '');

  const itemsEl = body.querySelector('#br-items')!;
  try {
    const items = await browseSource(source, path);
    itemsEl.innerHTML = '';
    if (items.length === 0) {
      itemsEl.innerHTML = '<div class="loading">（空目录）</div>';
      return;
    }
    for (const item of items) {
      itemsEl.appendChild(renderItem(source, item, path));
    }
  } catch (e) {
    itemsEl.innerHTML = `<div class="loading error">加载失败：${escapeHtml(String(e))}</div>`;
  }
}

function renderItem(source: Source, item: MediaItem, curPath: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'br-item' + (item.isDir ? ' dir' : '') + (item.url && isVideoName(item.title) ? ' video' : '');
  if (item.isDir) {
    row.innerHTML = `<span class="br-ico">📁</span><div class="br-main"><div class="br-name">${escapeHtml(item.title)}</div></div><span class="br-go">›</span>`;
    row.addEventListener('click', () => {
      const next = joinPath(curPath, item.title);
      void renderSourceBrowser(bodyOf(row), source, next);
    });
    return row;
  }
  if (source.type === 'webdav') {
    const playable = isVideoName(item.title);
    row.innerHTML = `
      <span class="br-ico">${playable ? '🎬' : '📄'}</span>
      <div class="br-main">
        <div class="br-name">${escapeHtml(item.title)}</div>
        <div class="br-sub">${item.size ? fmtSize(item.size) : ''}</div>
      </div>
      ${playable ? '<span class="br-go">▶</span>' : '<button class="br-more" aria-label="更多">⋯</button>'}
    `;
    if (playable) {
      row.addEventListener('click', () => openPlayer(item.key));
    } else {
      row.querySelector('.br-more')!.addEventListener('click', (e) => {
        e.stopPropagation();
        showFileMenu(source, item);
      });
    }
    return row;
  }
  // Emby / Jellyfin
  row.innerHTML = `
    <span class="br-ico">🎬</span>
    <div class="br-main">
      <div class="br-name">${escapeHtml(item.title)}${item.year ? '（' + item.year + '）' : ''}</div>
      <div class="br-sub">${escapeHtml((item.genres || []).join(' · '))}${item.duration ? ' · ' + fmtDur(item.duration) : ''}</div>
    </div>
    <span class="br-go">▶</span>
  `;
  row.addEventListener('click', () => openPlayer(item.key));
  return row;
}

function bodyOf(el: HTMLElement): HTMLElement {
  return el.closest('.page')!.querySelector('#br-body')!;
}

function joinPath(cur: string, name: string): string {
  const base = cur.replace(/\/+$/, '');
  return (base ? base + '/' : '/') + name;
}

function fmtDur(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return m + ' 分钟';
  return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
}

// ---- SMB 浏览（iOS 系统「文件」App 的 SMB 支持：文档浏览器流式 + 拷贝下载） ----
// v1.1.12：SMB 改回系统文件选择器（picker，asCopy:false 流式、不下载）。
// 文档浏览器（UIDocumentBrowserViewController）的 delegate 回调在本 iOS 26 环境全部从不触发，
// 点文件永远走系统 QuickLook、播不了 smb:// 流。picker 的导航界面就是「文件」App 的：
// 进 NAS → 进共享文件夹 → 选视频（可多选）→ 点右上角「选取」即流式播放。
// 下载路线（asCopy:true）保留为备选。

function renderSMBBrowser(body: HTMLElement, source: Source): void {
  body.innerHTML = `
    <div class="br-toolbar">
      <button class="app-btn" id="smb-back">‹ 源列表</button>
      <span class="br-path">${escapeHtml(source.name)}</span>
    </div>
    <div class="smb-setup">
      <h3>首次使用：在系统「文件」App 注册这台 NAS</h3>
      <ol>
        <li>打开 iPhone 自带的「文件」App</li>
        <li>底部切到「浏览」→ 右上角「⋯」→「添加 SMB 服务器」</li>
        <li>按下面填写并连接（只需做一次，之后系统会记住）</li>
      </ol>
      <div class="smb-cred">
        <div>地址：<b>${escapeHtml(source.host)}</b>${source.port && source.port !== '445' ? ' : ' + escapeHtml(source.port) : ''}</div>
        <div>用户名：<b>${escapeHtml(source.user || '—')}</b></div>
        <div>密码：<b>${escapeHtml(source.pass || '—')}</b></div>
        <div>共享：<b>${escapeHtml(source.share || '—')}</b></div>
      </div>
      <p class="smb-note">对应 Windows 路径 \\\\${escapeHtml(source.host)}\\${escapeHtml(source.share || 'video')} 。
      点「从 NAS 选视频」后在弹出的系统选择器里<b>点进你的 NAS 服务器 → 共享文件夹「${escapeHtml(source.share || 'video')}」→ 选视频（可多选）→ 右上角「选取」</b>，即流式播放（不占手机存储）。</p>
    </div>
    <button class="app-btn primary smb-pick">📂 从 NAS 选视频（流式播放，不下载）</button>
    <button class="app-btn smb-dl" style="margin-top:8px;width:100%">📥 下载 NAS 视频到手机（离线播放）</button>
    <button class="app-btn smb-subs" style="margin-top:8px;width:100%">💬 下载 NAS 字幕（与视频同名自动加载）</button>
    <div id="smb-files" class="br-items"></div>
  `;
  body.querySelector('#smb-back')!.addEventListener('click', () => nav('#/browse'));
  body.querySelector('.smb-pick')!.addEventListener('click', () => void doBrowseSMB(body, source));
  body.querySelector('.smb-dl')!.addEventListener('click', () => void doPickFromNAS(false));
  body.querySelector('.smb-subs')!.addEventListener('click', () => void doPickFromNAS(true));
  void refreshSMBFiles(body);
}

/** 系统文件选择器进 NAS 目录树，选中视频即流式播放（可多选） */
async function doBrowseSMB(body: HTMLElement, source: Source): Promise<void> {
  toast('在选择器里：点进 NAS 服务器 → 共享文件夹 → 选视频 → 右上角「选取」');
  const res = await browseSMB({ host: source.host, port: source.port, share: source.share });
  if (res.files.length === 0) {
    if (res.error) {
      toast('进入 NAS 失败：' + res.error + '。请确认「文件」App 里已注册这台 SMB 服务器且能打开');
    } else {
      toast('未选择视频');
    }
    return;
  }
  await refreshSMBFiles(body);
  // 选中即播：打开第一个视频类型的文件（.item 下可能混入字幕/其他，按 kind 过滤）
  const video = res.files.find((f) => f.kind === 'video');
  if (video) {
    openPlayer('smb:' + video.name);
  } else if (res.files.some((f) => f.kind === 'subtitle')) {
    toast('选中的是字幕文件，请用「下载 NAS 字幕」按钮导入');
  } else {
    toast('选中的文件不是可播放视频');
  }
}

/** 列出本次会话已打开的 NAS 视频（流式播放，可重播） */
async function refreshSMBFiles(body: HTMLElement): Promise<void> {
  const box = body.querySelector<HTMLElement>('#smb-files');
  if (!box) return;
  const files = await listSMBFiles();
  box.innerHTML = '';
  if (files.length === 0) {
    box.innerHTML = '<div class="loading">还没播放过 NAS 视频。点上面按钮进入 NAS，浏览文件夹，点视频即播。</div>';
    return;
  }
  for (const f of files) {
    const isSub = f.kind === 'subtitle';
    const item = document.createElement('div');
    item.className = 'br-item video';
    item.innerHTML = `
      <span class="br-ico">${isSub ? '💬' : '🎬'}</span>
      <div class="br-main">
        <div class="br-name">${escapeHtml(f.name)}</div>
        <div class="br-sub">${f.size ? fmtSize(f.size) : ''} · NAS ${isSub ? '字幕（播放时可在播放器内加载）' : '流式'}</div>
      </div>
      ${isSub ? '' : '<span class="br-go">▶</span>'}
    `;
    if (!isSub) item.addEventListener('click', () => openPlayer('smb:' + f.name));
    box.appendChild(item);
  }
}

/** 用系统文件选择器（asCopy:true）从 NAS 下载视频/字幕到本地媒体库（离线播放备选路线） */
async function doPickFromNAS(subtitles: boolean): Promise<void> {
  toast(subtitles ? '选到 NAS 里的字幕文件后点右上角「选取」' : '进入 NAS 文件夹选视频（可多选），点「选取」后自动下载并播放');
  const files = await pickMedia(subtitles);
  if (files.length === 0) return;
  addLocalFiles(files.map((f) => ({ name: f.name, size: f.size, kind: f.kind })));
  const vids = files.filter((f) => f.kind === 'video');
  if (vids.length > 0) {
    openPlayer('local:' + vids[0].name, vids.map((v) => 'local:' + v.name));
  } else {
    toast(`已下载 ${files.length} 个字幕`);
  }
}

/** WebDAV 文件菜单：重命名 / 删除（VidHub 的云端文件重命名） */
async function showFileMenu(source: Source, item: MediaItem): Promise<void> {
  const path = item.path || '';
  const wrap = modal('文件操作', `
    <div class="form">
      <p class="form-file">${escapeHtml(item.title)}</p>
      <div class="form-btns">
        <button class="app-btn" id="fm-rename">重命名</button>
        <button class="app-btn danger" id="fm-del">删除</button>
      </div>
    </div>
  `);
  wrap.querySelector('#fm-rename')!.addEventListener('click', async () => {
    const newName = await promptDialog('重命名', item.title);
    wrap.remove();
    if (!newName || newName === item.title) return;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const newPath = (dir ? dir + '/' : '') + newName;
    try {
      await makeWebDAV(source).rename(path, newPath);
      toast('已重命名');
      window.dispatchEvent(new Event('app:refresh'));
      const itemsEl = document.querySelector('#br-items');
      if (itemsEl) {
        const curPath = source.rootPath || '';
        void renderSourceBrowser(document.querySelector('.page')!.querySelector<HTMLElement>('#br-body')!, source, curPath);
      }
    } catch (e) {
      toast('重命名失败：' + String(e));
    }
  });
  wrap.querySelector('#fm-del')!.addEventListener('click', async () => {
    const ok = await confirmDialog(`删除「${item.title}」？`, '删除');
    wrap.remove();
    if (!ok) return;
    try {
      await makeWebDAV(source).remove(path);
      toast('已删除');
      const body = document.querySelector('.page')!.querySelector<HTMLElement>('#br-body')!;
      void renderSourceBrowser(body, source, source.rootPath || '');
    } catch (e) {
      toast('删除失败：' + String(e));
    }
  });
}
