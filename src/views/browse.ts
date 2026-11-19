// 浏览：媒体源管理（添加/测试/删除）+ WebDAV 目录浏览 + Emby/Jellyfin 媒体库浏览 + 云端重命名/删除

import { state, addSource, removeSource } from '../core/store';
import type { MediaItem, Source, SourceType } from '../core/types';
import { browseSource, testSource, makeWebDAV, getSource } from '../sources/registry';
import { openPlayer } from '../player/player';
import { nav } from '../router';
import { confirmDialog, modal, promptDialog, toast } from '../components/ui';
import { fmtSize, escapeHtml, isVideoName } from '../core/util';

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
    row.innerHTML = `
      <span class="src-icon">${s.type === 'webdav' ? '🗂' : '📡'}</span>
      <div class="src-main">
        <div class="src-name">${escapeHtml(s.name)}</div>
        <div class="src-host">${escapeHtml(s.host)}${s.type === 'webdav' && s.rootPath ? ' ' + escapeHtml(s.rootPath) : ''}</div>
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
        <option value="emby">Emby 服务器</option>
        <option value="jellyfin">Jellyfin 服务器</option>
      </select>
      <label>名称</label>
      <input id="f-name" type="text" placeholder="例如：客厅 NAS" />
      <label>地址</label>
      <input id="f-host" type="text" placeholder="http://192.168.1.10:5005 或 192.168.1.10:8096" />
      <div id="f-wdav">
        <label>用户名（可选）</label>
        <input id="f-user" type="text" placeholder="留空则匿名" />
        <label>密码（可选）</label>
        <input id="f-pass" type="password" placeholder="留空则匿名" />
        <label>根路径（可选）</label>
        <input id="f-root" type="text" placeholder="例如 /video" />
      </div>
      <div id="f-ms" style="display:none">
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
    wrap.querySelector<HTMLElement>('#f-wdav')!.style.display = typeSel.value === 'webdav' ? '' : 'none';
    wrap.querySelector<HTMLElement>('#f-ms')!.style.display = typeSel.value === 'webdav' ? 'none' : '';
  };
  typeSel.addEventListener('change', toggle);
  toggle();

  const readForm = (): Omit<Source, 'id'> => {
    const type = typeSel.value as SourceType;
    return {
      type,
      name: wrap.querySelector<HTMLInputElement>('#f-name')!.value.trim() || '未命名源',
      host: wrap.querySelector<HTMLInputElement>('#f-host')!.value.trim(),
      user: type === 'webdav' ? wrap.querySelector<HTMLInputElement>('#f-user')!.value.trim() || undefined : undefined,
      pass: type === 'webdav' ? wrap.querySelector<HTMLInputElement>('#f-pass')!.value || undefined : undefined,
      rootPath: type === 'webdav' ? wrap.querySelector<HTMLInputElement>('#f-root')!.value.trim() || undefined : undefined,
      apiKey: type !== 'webdav' ? wrap.querySelector<HTMLInputElement>('#f-key')!.value.trim() || undefined : undefined
    };
  };

  wrap.querySelector('#f-test')!.addEventListener('click', async () => {
    const status = wrap.querySelector('#f-status')!;
    const src = readForm();
    if (!src.host) {
      status.textContent = '请先填写地址';
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
    addSource(src);
    wrap.remove();
    window.dispatchEvent(new Event('app:src-refresh'));
    toast('已添加，点进去浏览');
  });
}

// ---- 源内浏览 ----

async function renderSourceBrowser(body: HTMLElement, source: Source, path: string): Promise<void> {
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
