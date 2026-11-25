// 首页（v1.1.26 设计稿 V4）：媒体源（+添加/浏览/配置）→ 最近添加 → 继续观看 → 收藏

import { state, isFavorite } from '../core/store';
import { openPlayer } from '../player/player';
import { nav } from '../router';
import { escapeHtml, titleOfKey, fmtTime, fmtSize } from '../core/util';

export function renderHome(el: HTMLElement): void {
  el.innerHTML = `
    <div class="page">
      <div class="page-head">
        <h1>视频播放器<span class="app-ver">v${__APP_VERSION__}</span></h1>
      </div>
      <div id="home-body"></div>
    </div>
  `;
  renderBody(el.querySelector('#home-body')!);
}

export function renderBody(body: HTMLElement): void {
  body.innerHTML = '';

  // 1. 媒体源（+ 添加，每个源：浏览 / 配置）
  body.appendChild(section('媒体源', () => nav('#/source-add')));
  if (state.sources.length === 0) {
    const tip = document.createElement('div');
    tip.className = 'loading';
    tip.textContent = '还没有媒体源，点上方「+ 添加」';
    body.appendChild(tip);
  }
  const srcList = document.createElement('div');
  srcList.className = 'src-list';
  for (const s of state.sources) {
    const icon = s.type === 'webdav' ? '🗂' : s.type === 'smb' ? '📡' : '🎬';
    const sub =
      s.type === 'smb'
        ? escapeHtml(s.host + (s.port && s.port !== '445' ? ':' + s.port : '') + '/' + (s.share || ''))
        : escapeHtml(s.host);
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
    srcList.appendChild(row);
  }
  body.appendChild(srcList);

  // 2. 最近添加（2x4 宫格）
  const recent = [...state.library]
    .filter((f) => f.kind === 'video')
    .sort((a, b) => b.addedAt - a.addedAt)
    .slice(0, 8);
  if (recent.length > 0) {
    body.appendChild(section('最近添加', () => nav('#/library')));
    const grid = document.createElement('div');
    grid.className = 'media-grid cols4';
    for (const f of recent) {
      const key = (f.folder ?? '') ? 'local:' + f.folder + '/' + f.name : 'local:' + f.name;
      const card = document.createElement('div');
      card.className = 'media-card';
      card.innerHTML = `
        <div class="media-thumb"><span class="media-play">▶</span></div>
        <div class="media-name">${isFavorite(key) ? '★ ' : ''}${escapeHtml(f.name)}</div>
        <div class="media-sub">${fmtSize(f.size)}</div>
      `;
      card.addEventListener('click', () => openPlayer(key));
      grid.appendChild(card);
    }
    body.appendChild(grid);
  }

  // 3. 继续观看（最近 10 个，常规行 + 进度）
  const records = Object.entries(state.records)
    .filter(([key, rec]) => rec.duration > 0 && rec.time / rec.duration > 0.01 && rec.time / rec.duration < 0.97)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, 10);
  if (records.length > 0) {
    body.appendChild(section('继续观看'));
    for (const [key, rec] of records) {
      const pct = Math.min(100, Math.round((rec.time / rec.duration) * 100));
      const row = document.createElement('div');
      row.className = 'media-row';
      row.innerHTML = `
        ${isFavorite(key) ? '<span class="fav-star">★</span>' : ''}
        <span class="donut" style="--p:${pct}"></span>
        <div class="media-row-main">
          <div class="media-row-title">${escapeHtml(titleOfKey(key))}</div>
          <div class="media-row-sub">${fmtTime(rec.time)} / ${fmtTime(rec.duration)}</div>
        </div>
        <span class="media-row-act">▶</span>
      `;
      row.addEventListener('click', () => openPlayer(key));
      body.appendChild(row);
    }
  }

  // 4. 收藏（全部，常规行）
  if (state.favorites.length > 0) {
    body.appendChild(section('收藏'));
    for (const key of state.favorites) {
      const row = document.createElement('div');
      row.className = 'media-row';
      row.innerHTML = `
        <span class="fav-star">★</span>
        <div class="media-row-main">
          <div class="media-row-title">${escapeHtml(titleOfKey(key))}</div>
          <div class="media-row-sub">${key.startsWith('smb:') ? 'NAS' : key.startsWith('local:') ? '本地' : '媒体源'}</div>
        </div>
        <span class="media-row-act">▶</span>
      `;
      row.addEventListener('click', () => openPlayer(key));
      body.appendChild(row);
    }
  }
}

function section(title: string, onAct?: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sec-title';
  el.innerHTML = escapeHtml(title) + (onAct ? '<button class="sec-act">+ 添加</button>' : '');
  if (onAct) el.querySelector('.sec-act')!.addEventListener('click', onAct);
  return el;
}
