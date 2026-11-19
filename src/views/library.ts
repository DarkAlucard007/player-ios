// 媒体库：本地视频管理（导入 / 缩略图 / 进度 / 删除 / 字幕文件）

import { state, addLocalFiles, clearLibrary } from '../core/store';
import { mediaCard } from '../components/media';
import { pickMedia, clearLocalCache, isNative } from '../native/localMedia';
import { confirmDialog, toast } from '../components/ui';
import { fmtSize } from '../core/util';

export function renderLibrary(el: HTMLElement): void {
  el.innerHTML = `
    <div class="page-head">
      <h1>媒体库</h1>
      <div class="page-actions">
        <button class="app-btn" id="lib-add">+ 导入视频</button>
      </div>
    </div>
    <div id="lib-body"></div>
  `;
  el.querySelector('#lib-add')!.addEventListener('click', () => void doImport());
  renderBody(el.querySelector('#lib-body')!);
  window.addEventListener('app:refresh', onRefresh);
  function onRefresh(): void {
    renderBody(el.querySelector('#lib-body')!);
  }
}

async function doImport(): Promise<void> {
  toast('正在打开文件选择器…');
  const files = await pickMedia(true);
  if (files.length === 0) return;
  addLocalFiles(
    files.map((f) => ({ name: f.name, size: f.size, kind: f.kind }))
  );
  const n = files.filter((f) => f.kind === 'video').length;
  const s = files.filter((f) => f.kind === 'subtitle').length;
  toast(`已导入 ${n} 个视频${s ? '，' + s + ' 个字幕' : ''}`);
  window.dispatchEvent(new Event('app:refresh'));
}

function renderBody(body: HTMLElement): void {
  body.innerHTML = '';
  const videos = state.library.filter((f) => f.kind === 'video').sort((a, b) => b.addedAt - a.addedAt);
  const subs = state.library.filter((f) => f.kind === 'subtitle');

  if (videos.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="empty-icon">🎬</div>
      <p>媒体库是空的</p>
      <p class="empty-sub">点右上角「导入视频」，从 iPhone 文件里选择视频</p>
    `;
    body.appendChild(empty);
  } else {
    const grid = document.createElement('div');
    grid.className = 'media-grid';
    for (const f of videos) grid.appendChild(mediaCard('local:' + f.name, f.name, fmtSize(f.size)));
    body.appendChild(grid);

    if (isNative) {
      const total = videos.reduce((a, f) => a + f.size, 0);
      const clearBtn = document.createElement('button');
      clearBtn.className = 'app-btn danger lib-clear';
      clearBtn.textContent = `清空媒体库（${fmtSize(total)}）`;
      clearBtn.addEventListener('click', async () => {
        const ok = await confirmDialog('清空媒体库？所有已导入的视频和字幕都会删除。', '清空');
        if (!ok) return;
        await clearLocalCache();
        clearLibrary();
        toast('已清空');
        window.dispatchEvent(new Event('app:refresh'));
      });
      body.appendChild(clearBtn);
    }
  }

  if (subs.length > 0) {
    const h = document.createElement('h2');
    h.className = 'sec-title';
    h.textContent = '字幕文件（与视频同名时自动加载）';
    body.appendChild(h);
    const list = document.createElement('div');
    list.className = 'plain-list';
    for (const f of subs) {
      const row = document.createElement('div');
      row.className = 'plain-row';
      row.innerHTML = `<span class="plain-name">💬 ${f.name}</span><span class="plain-sub">${fmtSize(f.size)}</span>`;
      list.appendChild(row);
    }
    body.appendChild(list);
  }
}
