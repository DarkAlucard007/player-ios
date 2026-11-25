// 播放列表：创建 / 打开（按顺序连播）/ 移除条目 / 删除列表

import { state, createPlaylist, removePlaylist, removeFromPlaylist } from '../core/store';
import { openPlayer } from '../player/player';
import { promptDialog, confirmDialog, toast } from '../components/ui';
import { escapeHtml, titleOfKey, fmtTime } from '../core/util';

let openPlaylistId: string | null = null;

export function renderPlaylists(el: HTMLElement): void {
  el.innerHTML = `
    <div class="page-head">
      <h1>播放列表</h1>
      <div class="page-actions">
        <button class="app-btn" id="pl-new">+ 新建</button>
      </div>
    </div>
    <div id="pl-body"></div>
  `;
  el.querySelector('#pl-new')!.addEventListener('click', async () => {
    const name = await promptDialog('新建播放列表', '例如：周末电影');
    if (!name) return;
    const pl = createPlaylist(name);
    openPlaylistId = pl.id;
    renderBody(el.querySelector('#pl-body')!);
  });
  renderBody(el.querySelector('#pl-body')!);
}

function renderBody(body: HTMLElement): void {
  body.innerHTML = '';
  const open = state.playlists.find((p) => p.id === openPlaylistId);
  if (open) {
    renderPlaylistDetail(body, open);
    return;
  }
  if (state.playlists.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="empty-icon">📃</div>
      <p>还没有播放列表</p>
      <p class="empty-sub">创建列表后，在播放器「更多」里把视频加进来，然后一键连播</p>
    `;
    body.appendChild(empty);
    return;
  }
  for (const pl of state.playlists) {
    const row = document.createElement('div');
    row.className = 'pl-row';
    row.innerHTML = `
      <div class="pl-main">
        <div class="pl-name">${escapeHtml(pl.name)}</div>
        <div class="pl-sub">${pl.items.length} 个视频</div>
      </div>
      <button class="pl-del" aria-label="删除列表">×</button>
    `;
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.pl-del')) return;
      openPlaylistId = pl.id;
      renderBody(body);
    });
    row.querySelector('.pl-del')!.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog(`删除播放列表「${pl.name}」？`);
      if (!ok) return;
      removePlaylist(pl.id);
      toast('已删除');
      renderBody(body);
    });
    body.appendChild(row);
  }
}

function renderPlaylistDetail(body: HTMLElement, pl: import('../core/types').Playlist): void {
  body.innerHTML = `
    <div class="br-toolbar">
      <button class="app-btn" id="pl-back">‹ 列表</button>
      <span class="br-path">${escapeHtml(pl.name)}</span>
    </div>
    <div class="pl-actions">
      <button class="app-btn primary" id="pl-playall">▶ 从头连播</button>
    </div>
    <div id="pl-items"></div>
  `;
  body.querySelector('#pl-back')!.addEventListener('click', () => {
    openPlaylistId = null;
    renderBody(body);
  });
  body.querySelector('#pl-playall')!.addEventListener('click', () => {
    if (pl.items.length === 0) {
      toast('列表是空的');
      return;
    }
    openPlayer(pl.items[0], [...pl.items]);
  });
  const itemsEl = body.querySelector('#pl-items')!;
  if (pl.items.length === 0) {
    itemsEl.innerHTML = '<div class="loading">列表是空的。播放视频时点「更多 → 加入播放列表」。</div>';
    return;
  }
  pl.items.forEach((key, i) => {
    const row = document.createElement('div');
    row.className = 'media-row';
    const rec = state.records[key];
    const pct = rec && rec.duration > 0 ? Math.min(100, Math.round((rec.time / rec.duration) * 100)) : 0;
    row.innerHTML = `
      <div class="pl-idx">${i + 1}</div>
      <span class="donut${pct >= 97 ? ' full' : ''}" style="--p:${pct}"></span>
      <div class="media-row-main">
        <div class="media-row-title">${escapeHtml(titleOfKey(key))}</div>
        <div class="media-row-sub">${rec && rec.duration > 0 ? fmtTime(rec.time) + ' / ' + fmtTime(rec.duration) : '未观看'}</div>
      </div>
      <button class="media-row-del" aria-label="移除">×</button>
    `;
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.media-row-del')) return;
      openPlayer(key, pl.items.slice(i));
    });
    row.querySelector('.media-row-del')!.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromPlaylist(pl.id, key);
      renderBody(body);
    });
    itemsEl.appendChild(row);
  });
}
