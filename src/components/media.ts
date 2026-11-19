// 媒体卡片组件：缩略图（本地视频原生截帧）+ 进度条 + 播放入口

import { state, removeLocalFile } from '../core/store';
import { fmtSize, escapeHtml } from '../core/util';
import { captureFrame, deleteLocalFile } from '../native/localMedia';
import { openPlayer } from '../player/player';
import { confirmDialog, toast } from './ui';

const thumbCache = new Map<string, string>();

/** 生成一张卡片（本地视频带缩略图与进度） */
export function mediaCard(key: string, title: string, sub?: string, onPlay?: (key: string) => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'media-card';
  el.dataset.key = key;
  const rec = state.records[key];
  const progress = rec && rec.duration > 0 ? Math.min(100, Math.round((rec.time / rec.duration) * 100)) : 0;
  el.innerHTML = `
    <div class="media-thumb"><span class="media-play">▶</span>
      ${progress > 0 && progress < 97 ? `<div class="media-progress" style="width:${progress}%"></div>` : ''}
    </div>
    <div class="media-name">${escapeHtml(title)}</div>
    ${sub ? `<div class="media-sub">${escapeHtml(sub)}</div>` : ''}
  `;
  el.addEventListener('click', () => {
    if (onPlay) onPlay(key);
    else openPlayer(key);
  });
  if (key.startsWith('local:')) {
    void loadThumb(el, key.slice(6), rec?.time ?? 1);
    el.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const ok = await confirmDialog(`从媒体库删除「${title}」？\n（同时删除已缓存的文件）`);
      if (!ok) return;
      await deleteLocalFile(key.slice(6));
      removeLocalFile(key.slice(6));
      toast('已删除');
      window.dispatchEvent(new Event('app:refresh'));
    });
  }
  return el;
}

async function loadThumb(card: HTMLElement, name: string, atTime: number): Promise<void> {
  const cached = thumbCache.get(name);
  const img = document.createElement('img');
  img.alt = '';
  if (cached) {
    img.src = cached;
  } else {
    const b64 = await captureFrame(name, atTime);
    if (!b64) return;
    const url = 'data:image/jpeg;base64,' + b64;
    thumbCache.set(name, url);
    img.src = url;
  }
  const thumb = card.querySelector('.media-thumb');
  if (thumb) thumb.prepend(img);
}

/** 一行媒体条目（列表视图用） */
export function mediaRow(
  title: string,
  sub: string,
  onPlay: () => void,
  extra?: (el: HTMLElement) => void
): HTMLElement {
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
  if (extra) extra(el);
  return el;
}

export function sizeText(bytes: number): string {
  return fmtSize(bytes);
}
