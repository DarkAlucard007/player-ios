// 全局搜索：本地媒体库 + WebDAV 递归检索 + Emby/Jellyfin 服务端搜索

import { state } from '../core/store';
import type { MediaItem } from '../core/types';
import { browseSource, makeWebDAV, getSource } from '../sources/registry';
import { openPlayer } from '../player/player';
import { toast } from '../components/ui';
import { escapeHtml, isVideoName, fmtSize } from '../core/util';

export function renderSearch(el: HTMLElement): void {
  el.innerHTML = `
    <div class="page-head"><h1>搜索</h1></div>
    <div class="search-box">
      <input id="search-input" type="search" placeholder="按文件名或影片名搜索" />
    </div>
    <div id="search-results"></div>
  `;
  const input = el.querySelector<HTMLInputElement>('#search-input')!;
  const results = el.querySelector<HTMLElement>('#search-results')!;
  let timer: number | null = null;
  input.addEventListener('input', () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => void doSearch(input.value.trim(), results), 350);
  });
}

async function doSearch(term: string, results: HTMLElement): Promise<void> {
  results.innerHTML = '';
  if (!term) return;
  results.innerHTML = '<div class="loading">搜索中…</div>';

  // 1) 本地媒体库
  const localHits = state.library.filter((f) => f.kind === 'video' && f.name.toLowerCase().includes(term.toLowerCase()));
  if (localHits.length > 0) {
    results.innerHTML = '';
    results.appendChild(sec('本地媒体库'));
    for (const f of localHits.slice(0, 30)) {
      results.appendChild(row(f.name, fmtSize(f.size), () => openPlayer('local:' + f.name)));
    }
  }

  // 2) 各媒体源
  for (const s of state.sources) {
    try {
      let items: MediaItem[] = [];
      if (s.type === 'webdav') {
        items = await walkWebDAV(s, term, 0);
      } else {
        items = await browseSource(s, '', term);
      }
      const hits = items.filter((i) => !i.isDir && isVideoName(i.title)).slice(0, 30);
      if (hits.length > 0) {
        if (results.children.length === 0) results.innerHTML = '';
        results.appendChild(sec(s.name));
        for (const it of hits) {
          results.appendChild(row(it.title, it.size ? fmtSize(it.size) : '', () => openPlayer(it.key)));
        }
      }
    } catch {
      // 单个源失败不影响其他源
    }
  }

  if (results.children.length === 0) {
    results.innerHTML = '<div class="loading">没有搜到结果</div>';
  }
}

/** WebDAV 递归检索（限制条目数，避免大目录卡死） */
async function walkWebDAV(source: import('../core/types').Source, term: string, depth: number): Promise<MediaItem[]> {
  if (depth > 4) return [];
  const client = makeWebDAV(source);
  const out: MediaItem[] = [];
  const root = source.rootPath || '';
  const queue: string[] = [root];
  let visited = 0;
  while (queue.length > 0 && visited < 400) {
    const p = queue.shift()!;
    let entries;
    try {
      entries = await client.list(p);
    } catch {
      continue;
    }
    visited += entries.length;
    for (const e of entries) {
      if (e.isDir) {
        queue.push(e.path);
      } else if (e.name.toLowerCase().includes(term.toLowerCase())) {
        const items = client.items(source, [e]);
        out.push(...items);
      }
    }
  }
  return out;
}

function sec(title: string): HTMLElement {
  const el = document.createElement('h2');
  el.className = 'sec-title';
  el.textContent = title;
  return el;
}

function row(title: string, sub: string, onPlay: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'media-row';
  el.innerHTML = `
    <div class="media-row-main">
      <div class="media-row-title">${escapeHtml(title)}</div>
      <div class="media-row-sub">${escapeHtml(sub)}</div>
    </div>
    <div class="media-row-act">▶</div>
  `;
  el.addEventListener('click', onPlay);
  return el;
}
