// 首页：继续观看 + 最近添加 + 快捷操作 + 媒体源列表

import { state } from '../core/store';
import { mediaCard } from '../components/media';
import { openPlayer } from '../player/player';
import { nav } from '../router';

export function renderHome(el: HTMLElement): void {
  el.innerHTML = `
    <div class="page-head">
      <h1>视频播放器<span class="app-ver">v${__APP_VERSION__}</span></h1>
      <div class="page-actions">
        <button class="app-btn" id="home-add-src">+ 媒体源</button>
      </div>
    </div>
    <div id="home-body"></div>
  `;
  el.querySelector('#home-add-src')!.addEventListener('click', () => nav('#/browse?add=1'));
  renderBody(el.querySelector('#home-body')!);
}

export function renderBody(body: HTMLElement): void {
  body.innerHTML = '';

  // 继续观看
  const records = Object.entries(state.records)
    .filter(([key, rec]) => rec.duration > 0 && rec.time / rec.duration > 0.01 && rec.time / rec.duration < 0.97)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, 12);
  if (records.length > 0) {
    body.appendChild(section('继续观看'));
    const grid = document.createElement('div');
    grid.className = 'media-grid';
    for (const [key] of records) {
      grid.appendChild(mediaCard(key, titleFor(key), progressText(key)));
    }
    body.appendChild(grid);
  }

  // 最近添加（本地）
  const recent = [...state.library]
    .filter((f) => f.kind === 'video')
    .sort((a, b) => b.addedAt - a.addedAt)
    .slice(0, 12);
  if (recent.length > 0) {
    body.appendChild(section('最近添加'));
    const grid = document.createElement('div');
    grid.className = 'media-grid';
    for (const f of recent) grid.appendChild(mediaCard('local:' + f.name, f.name, sizeOf(f.size)));
    body.appendChild(grid);
  }

  // 媒体源
  if (state.sources.length > 0) {
    body.appendChild(section('媒体源'));
    const list = document.createElement('div');
    list.className = 'src-list';
    for (const s of state.sources) {
      const row = document.createElement('div');
      row.className = 'src-row';
      row.innerHTML = `
        <span class="src-icon">${s.type === 'webdav' ? '🗂' : '📡'}</span>
        <div class="src-main">
          <div class="src-name">${s.name}</div>
          <div class="src-host">${s.host}</div>
        </div>
        <span class="src-go">›</span>
      `;
      row.addEventListener('click', () => nav('#/browse?src=' + s.id));
      list.appendChild(row);
    }
    body.appendChild(list);
  }

  // 空状态
  if (records.length === 0 && recent.length === 0 && state.sources.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="empty-icon">▶</div>
      <p>还没有视频</p>
      <p class="empty-sub">去「媒体库」导入本地视频，或添加 WebDAV / Emby 媒体源</p>
      <button class="app-btn primary" id="empty-go-lib">去媒体库</button>
    `;
    empty.querySelector('#empty-go-lib')!.addEventListener('click', () => nav('#/library'));
    body.appendChild(empty);
  }
}

function section(title: string): HTMLElement {
  const el = document.createElement('h2');
  el.className = 'sec-title';
  el.textContent = title;
  return el;
}

function titleFor(key: string): string {
  if (key.startsWith('local:')) return key.slice(6);
  if (key.startsWith('webdav:')) {
    const p = key.slice(7).split('/').slice(1).join('/');
    const parts = p.split('/').filter(Boolean);
    return parts[parts.length - 1] || p;
  }
  return key;
}

function progressText(key: string): string {
  const rec = state.records[key];
  if (!rec || rec.duration <= 0) return '';
  const m1 = Math.floor(rec.time / 60);
  const m2 = Math.floor(rec.duration / 60);
  return `${m1}/${m2} 分钟`;
}

function sizeOf(bytes: number): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}
