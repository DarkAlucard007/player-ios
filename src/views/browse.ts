// 浏览（v1.1.26 设计稿 V4）：媒体源列表（浏览/配置按钮）+ NAS 目录树 + WebDAV / Emby / Jellyfin 浏览

import { state, addLocalFiles, toggleFavorite } from '../core/store';
import type { MediaItem, Source } from '../core/types';
import { browseSource, makeWebDAV, getSource } from '../sources/registry';
import { openPlayer } from '../player/player';
import { nav } from '../router';
import { confirmDialog, modal, promptDialog, toast } from '../components/ui';
import { fmtSize, escapeHtml, isVideoName, titleOfKey } from '../core/util';
import {
  browseSMB,
  listSMBDir,
  openSMBFile,
  createSMBFolder,
  renameSMBItem,
  moveSMBItem,
  copySMBItem,
  deleteSMBItem,
  pickMedia,
  type SMBDirOpts
} from '../native/localMedia';

export function renderBrowse(el: HTMLElement, hash: string): void {
  const query = new URLSearchParams(hash.split('?')[1] || '');
  const srcId = query.get('src');
  el.innerHTML = `
    <div class="page">
      <div class="page-head">
        <h1>浏览</h1>
        <div class="page-actions">
          <button class="app-btn primary" id="br-add">+ 添加</button>
        </div>
      </div>
      <div id="br-body"></div>
    </div>
  `;
  el.querySelector('#br-add')!.addEventListener('click', () => nav('#/source-add'));

  const body = el.querySelector<HTMLElement>('#br-body')!;
  if (srcId) {
    const source = getSource(srcId);
    if (source) {
      if (source.type === 'smb') renderSMBTree(body, source);
      else void renderSourceBrowser(body, source, source.type === 'webdav' ? source.rootPath || '' : '');
      return;
    }
  }
  renderSourceList(body);
}

// ---- 源列表 ----

function renderSourceList(body: HTMLElement): void {
  body.innerHTML = '';
  if (state.sources.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📡</div>
        <p>还没有媒体源</p>
        <p class="empty-sub">支持 NAS (SMB)、WebDAV（群晖）和 Emby / Jellyfin</p>
        <button class="app-btn primary" id="empty-add">+ 添加媒体源</button>
      </div>`;
    body.querySelector('#empty-add')!.addEventListener('click', () => nav('#/source-add'));
    return;
  }
  const list = document.createElement('div');
  list.className = 'src-list';
  for (const s of state.sources) {
    const icon = s.type === 'webdav' ? '🗂' : s.type === 'smb' ? '📡' : '🎬';
    const sub =
      s.type === 'smb'
        ? escapeHtml(s.host + (s.port && s.port !== '445' ? ':' + s.port : '') + '/' + (s.share || ''))
        : escapeHtml(s.host + (s.rootPath && s.rootPath !== '/' ? s.rootPath : ''));
    const row = document.createElement('div');
    row.className = 'src-row';
    row.innerHTML = `
      <span class="src-icon">${icon}</span>
      <div class="src-main">
        <div class="src-name">${escapeHtml(s.name)}</div>
        <div class="src-host">${sub}</div>
      </div>
      <div class="src-acts">
        <button class="src-act browse">浏览</button>
        <button class="src-act">配置</button>
      </div>
    `;
    row.querySelector('.src-act.browse')!.addEventListener('click', (e) => {
      e.stopPropagation();
      nav('#/browse?src=' + s.id);
    });
    row.querySelectorAll<HTMLElement>('.src-act')[1].addEventListener('click', (e) => {
      e.stopPropagation();
      nav('#/source-edit?id=' + s.id);
    });
    row.addEventListener('click', () => nav('#/browse?src=' + s.id));
    list.appendChild(row);
  }
  body.appendChild(list);
}

// ---- 源内浏览（WebDAV / Emby / Jellyfin，保留原逻辑） ----

async function renderSourceBrowser(body: HTMLElement, source: Source, path: string): Promise<void> {
  body.innerHTML = `
    <div class="br-toolbar">
      <button class="app-btn" id="br-back">‹ 源列表</button>
      <span class="br-path" id="br-path"></span>
    </div>
    <div id="br-items" class="br-items"><div class="loading">加载中…</div></div>
  `;
  body.querySelector('#br-back')!.addEventListener('click', () => nav('#/browse'));
  const pathEl = body.querySelector<HTMLElement>('#br-path')!;
  pathEl.textContent = source.name + (path ? ' / ' + path.replace(/^\/+/, '') : '');

  const itemsEl = body.querySelector<HTMLElement>('#br-items')!;
  try {
    const items = await browseSource(source, path);
    itemsEl.innerHTML = '';
    if (items.length === 0) {
      itemsEl.innerHTML = '<div class="loading">（空目录）</div>';
      return;
    }
    for (const item of items) itemsEl.appendChild(renderItem(source, item, path));
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
    if (playable) row.addEventListener('click', () => openPlayer(item.key));
    else row.querySelector('.br-more')!.addEventListener('click', (e) => {
      e.stopPropagation();
      void showFileMenu(source, item);
    });
    return row;
  }
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

// ---- NAS (SMB) 目录树浏览（v1.1.26：原生 smb:// 直连，无需系统「文件」App） ----

function smbOpts(source: Source, path: string): SMBDirOpts {
  return { host: source.host, port: source.port || undefined, share: source.share || '', path };
}

function renderSMBTree(body: HTMLElement, source: Source, path = ''): void {
  body.innerHTML = `
    <div class="tb">
      <button class="tb-up" data-s="up">↑ 上一级</button>
      <span class="tb-path" data-s="path"></span>
      <button class="tb-new" data-s="new">+ 新建文件夹</button>
    </div>
    <div data-s="body"><div class="loading">连接 NAS…</div></div>
    <div class="smb-setup" style="margin-top:14px">
      <p class="smb-note">点视频直接流式播放；ℹ 可收藏/改名/移动/复制/删除；长按进入多选。
      若列表为空或连接失败，可退回系统选择器：<button class="app-btn" data-s="picker" style="margin-top:8px">📂 系统选择器选视频</button></p>
    </div>
  `;
  const pathEl = body.querySelector<HTMLElement>('[data-s="path"]')!;
  const boxEl = body.querySelector<HTMLElement>('[data-s="body"]')!;
  pathEl.textContent = '//' + source.host + (source.port && source.port !== '445' ? ':' + source.port : '') + '/' + (source.share || '') + (path ? '/' + path : '');
  body.querySelector('[data-s="up"]')!.addEventListener('click', () => {
    const i = path.lastIndexOf('/');
    renderSMBTree(body, source, i >= 0 ? path.slice(0, i) : '');
  });
  body.querySelector('[data-s="new"]')!.addEventListener('click', async () => {
    const name = await promptDialog('新建文件夹', '文件夹名');
    if (!name) return;
    try {
      await createSMBFolder(smbOpts(source, path), name);
      toast('已创建');
      renderSMBTree(body, source, path);
    } catch (e) {
      toast('创建失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  });
  body.querySelector('[data-s="picker"]')!.addEventListener('click', () => void doBrowseSMB(body, source));
  void listDir(body, source, path);
}

async function listDir(body: HTMLElement, source: Source, path: string): Promise<void> {
  const boxEl = body.querySelector<HTMLElement>('[data-s="body"]')!;
  let res;
  try {
    res = await listSMBDir(smbOpts(source, path));
  } catch (e) {
    boxEl.innerHTML = `<div class="loading error">连接失败：${escapeHtml(e instanceof Error ? e.message : String(e))}<br>（确认 NAS 可达、共享名正确；或在系统「文件」App 注册过该 SMB 服务器）</div>`;
    return;
  }
  boxEl.innerHTML = '';
  if (!res.folders.length && !res.files.length) {
    boxEl.innerHTML = '<div class="loading">（空文件夹）</div>';
    return;
  }
  for (const f of res.folders) {
    const row = document.createElement('div');
    row.className = 'br-item dir';
    row.innerHTML = `
      <span class="br-ico">📁</span>
      <div class="br-main"><div class="br-name">${escapeHtml(f)}</div><div class="br-sub">文件夹</div></div>
      <button class="info-btn" data-a="info">ℹ</button>
      <span class="br-go">›</span>
    `;
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-a="info"]')) return;
      renderSMBTree(body, source, path ? path + '/' + f : f);
    });
    row.querySelector('[data-a="info"]')!.addEventListener('click', (e) => {
      e.stopPropagation();
      smbFolderMenu(body, source, path, f);
    });
    boxEl.appendChild(row);
  }
  for (const f of res.files) {
    const key = 'smb:' + (path ? path + '/' : '') + f.name;
    const row = document.createElement('div');
    row.className = 'br-item video';
    row.innerHTML = `
      <span class="br-ico">🎬</span>
      <div class="br-main"><div class="br-name">${escapeHtml(f.name)}</div><div class="br-sub">${fmtSize(f.size)} · NAS 流式</div></div>
      <button class="info-btn" data-a="info">ℹ</button>
      <span class="br-go">▶</span>
    `;
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-a="info"]')) return;
      void playSMB(body, source, path, f.name);
    });
    row.querySelector('[data-a="info"]')!.addEventListener('click', (e) => {
      e.stopPropagation();
      smbFileMenu(body, source, path, f.name, f.size);
    });
    boxEl.appendChild(row);
  }
}

/** 点开 NAS 视频：openSMBFile 登记安全作用域后播放；失败则退回系统选择器 */
async function playSMB(body: HTMLElement, source: Source, path: string, name: string): Promise<void> {
  try {
    const r = await openSMBFile(smbOpts(source, path), name);
    openPlayer('smb:' + r.name);
  } catch (e) {
    toast('直接打开失败（' + (e instanceof Error ? e.message : String(e)) + '），改用系统选择器…');
    await doBrowseSMB(body, source);
  }
}

function smbFolderMenu(body: HTMLElement, source: Source, path: string, folder: string): void {
  const wrap = modal('📁 ' + (folder.split('/').pop() || ''), `
    <div class="form">
      <p class="form-file">${escapeHtml(folder)}</p>
      <div class="form-btns">
        <button class="app-btn" data-a="rename">改名</button>
        <button class="app-btn danger" data-a="del">删除</button>
      </div>
    </div>`);
  wrap.querySelector('[data-a="rename"]')!.addEventListener('click', async () => {
    const nn = await promptDialog('文件夹改名', folder.split('/').pop() || '');
    wrap.remove();
    if (!nn) return;
    try {
      await renameSMBItem(smbOpts(source, path), folder, nn);
      toast('已改名');
      renderSMBTree(body, source, path);
    } catch (e) {
      toast('改名失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  });
  wrap.querySelector('[data-a="del"]')!.addEventListener('click', async () => {
    wrap.remove();
    if (!(await confirmDialog(`删除 NAS 文件夹「${folder}」及其内容？`, '删除'))) return;
    try {
      await deleteSMBItem(smbOpts(source, path), folder);
      toast('已删除');
      renderSMBTree(body, source, path);
    } catch (e) {
      toast('删除失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  });
}

function smbFileMenu(body: HTMLElement, source: Source, path: string, name: string, size: number): void {
  const wrap = modal(titleOfKey(name), `
    <div class="detail-box" style="position:static;width:auto;background:none;border:none;box-shadow:none;padding:0;max-height:none">
      <div class="detail-rows">
        <div class="drow"><span>类型</span><span>视频</span></div>
        <div class="drow"><span>大小</span><span>${fmtSize(size)}</span></div>
        <div class="drow"><span>位置</span><span>//${escapeHtml(source.host)}/${escapeHtml(source.share || '')}${path ? '/' + escapeHtml(path) : ''}</span></div>
      </div>
      <div class="detail-acts">
        <button class="app-btn" data-a="fav">★ 收藏</button>
        <button class="app-btn" data-a="rename">改名</button>
        <button class="app-btn" data-a="copy">复制</button>
        <button class="app-btn" data-a="move">移动</button>
      </div>
      <button class="app-btn danger" data-a="del" style="width:100%;margin-top:10px">删除</button>
    </div>`);
  const key = 'smb:' + (path ? path + '/' : '') + name;
  wrap.querySelector('[data-a="fav"]')!.addEventListener('click', () => {
    toggleFavorite(key);
    wrap.remove();
  });
  wrap.querySelector('[data-a="rename"]')!.addEventListener('click', async () => {
    const nn = await promptDialog('改名', name);
    wrap.remove();
    if (!nn || nn === name) return;
    try {
      await renameSMBItem(smbOpts(source, path), name, nn);
      toast('已改名');
      renderSMBTree(body, source, path);
    } catch (e) {
      toast('改名失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  });
  wrap.querySelector('[data-a="copy"]')!.addEventListener('click', () => {
    wrap.remove();
    void showSMBMove(body, source, path, name, 'copy');
  });
  wrap.querySelector('[data-a="move"]')!.addEventListener('click', () => {
    wrap.remove();
    showSMBMove(body, source, path, name);
  });
  wrap.querySelector('[data-a="del"]')!.addEventListener('click', async () => {
    wrap.remove();
    if (!(await confirmDialog(`删除 NAS 文件「${name}」？`, '删除'))) return;
    try {
      await deleteSMBItem(smbOpts(source, path), name);
      toast('已删除');
      renderSMBTree(body, source, path);
    } catch (e) {
      toast('删除失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  });
}

/** NAS 文件移动/复制：目标文件夹选择（只列文件夹；复制=同名放入目标目录） */
async function showSMBMove(body: HTMLElement, source: Source, fromPath: string, name: string, mode: 'move' | 'copy' = 'move'): Promise<void> {
  let dest = fromPath;
  const wrap = modal(mode === 'copy' ? '复制 NAS 视频到…' : '移动到…', `<div class="target-picker"><div class="tb"><button class="tb-up" data-m="up">↑ 上一级</button><span class="tb-path" data-m="path"></span></div><div data-m="body"></div><button class="app-btn primary" data-m="ok" style="width:100%;margin-top:14px">${mode === 'copy' ? '确定复制' : '确定移动'}</button></div>`);
  const pathEl = wrap.querySelector<HTMLElement>('[data-m="path"]')!;
  const boxEl = wrap.querySelector<HTMLElement>('[data-m="body"]')!;
  const draw = async () => {
    try {
      const r = await listSMBDir(smbOpts(source, dest));
      pathEl.textContent = '//' + source.host + '/' + (source.share || '') + (dest ? '/' + dest : '');
      boxEl.innerHTML = r.folders.length
        ? r.folders.map((f) => `<div class="target-folder" data-f="${escapeHtml(f)}">📁 ${escapeHtml(f)}</div>`).join('')
        : '<div class="loading">此级没有子文件夹</div>';
      boxEl.querySelectorAll<HTMLElement>('.target-folder').forEach((t) => {
        t.addEventListener('click', () => {
          dest = dest ? dest + '/' + t.dataset.f! : t.dataset.f!;
          void draw();
        });
      });
    } catch (e) {
      boxEl.innerHTML = `<div class="loading error">${escapeHtml(e instanceof Error ? e.message : String(e))}</div>`;
    }
  };
  void draw();
  wrap.querySelector('[data-m="up"]')!.addEventListener('click', () => {
    const i = dest.lastIndexOf('/');
    dest = i >= 0 ? dest.slice(0, i) : '';
    void draw();
  });
  wrap.querySelector('[data-m="ok"]')!.addEventListener('click', async () => {
    wrap.remove();
    try {
      if (dest === fromPath && mode === 'copy') {
        toast('目标与当前目录相同（复制为同名文件会冲突），请选择其他文件夹');
        return;
      }
      if (mode === 'copy') await copySMBItem(smbOpts(source, fromPath), name, dest);
      else await moveSMBItem(smbOpts(source, fromPath), name, dest);
      toast(mode === 'copy' ? '已复制' : '已移动');
      renderSMBTree(body, source, fromPath);
    } catch (e) {
      toast((mode === 'copy' ? '复制失败: ' : '移动失败: ') + (e instanceof Error ? e.message : String(e)));
    }
  });
}

// ---- 系统选择器回退路线 ----

async function doBrowseSMB(body: HTMLElement, source: Source): Promise<void> {
  toast('在选择器里：点进 NAS 服务器 → 共享文件夹 → 选视频 → 右上角「选取」');
  const res = await browseSMB(smbOpts(source, ''));
  if (res.files.length === 0) {
    toast(res.error ? '进入 NAS 失败：' + res.error : '未选择视频');
    return;
  }
  const video = res.files.find((f) => f.kind === 'video');
  if (video) openPlayer('smb:' + video.name);
  else if (res.files.some((f) => f.kind === 'subtitle')) toast('选中的是字幕文件，请用下载按钮导入');
  else toast('选中的文件不是可播放视频');
}

/** 用系统文件选择器（asCopy:true）从 NAS 下载到本地媒体库（离线播放备选路线） */
async function doPickFromNAS(subtitles: boolean): Promise<void> {
  toast(subtitles ? '选到 NAS 里的字幕文件后点右上角「选取」' : '进入 NAS 文件夹选视频（可多选），点「选取」后自动下载并播放');
  const files = await pickMedia(subtitles);
  if (files.length === 0) return;
  addLocalFiles(files.map((f) => ({ name: f.name, size: f.size, kind: f.kind })));
  const vids = files.filter((f) => f.kind === 'video');
  if (vids.length > 0) openPlayer('local:' + vids[0].name, vids.map((v) => 'local:' + v.name));
  else toast(`已下载 ${files.length} 个字幕`);
}

/** WebDAV 文件菜单：重命名 / 删除 */
async function showFileMenu(source: Source, item: MediaItem): Promise<void> {
  const path = item.path || '';
  const wrap = modal('文件操作', `
    <div class="form">
      <p class="form-file">${escapeHtml(item.title)}</p>
      <div class="form-btns">
        <button class="app-btn" id="fm-rename">重命名</button>
        <button class="app-btn danger" id="fm-del">删除</button>
      </div>
    </div>`);
  wrap.querySelector('#fm-rename')!.addEventListener('click', async () => {
    const newName = await promptDialog('重命名', item.title);
    wrap.remove();
    if (!newName || newName === item.title) return;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const newPath = (dir ? dir + '/' : '') + newName;
    try {
      await makeWebDAV(source).rename(path, newPath);
      toast('已重命名');
      const body = document.querySelector('.page')!.querySelector<HTMLElement>('#br-body')!;
      void renderSourceBrowser(body, source, source.rootPath || '');
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
