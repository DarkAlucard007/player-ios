// 媒体库（v1.1.26 设计稿 V4）：文件夹导航 + 3 显示模式 + 详情 + 复制/移动 + 长按多选

import { state, addLocalFiles, removeLocalFile, clearLibrary, isFavorite, setFavoritesMany } from '../core/store';
import { listLocalFiles, pickMedia, createLocalFolder, renameLocalItem, moveLocalItem, copyLocalItem, deleteLocalFile } from '../native/localMedia';
import type { LocalFile } from '../core/types';
import { escapeHtml, fmtSize, fmtTime, titleOfKey } from '../core/util';
import { confirmDialog, promptDialog, modal, toast } from '../components/ui';
import { openPlayer } from '../player/player';

type Mode = 'normal' | 'compact' | 'grid';

let curFolder = '';
let mode: Mode = localStorage.getItem('player.v1.libMode') === 'compact' ? 'compact' : localStorage.getItem('player.v1.libMode') === 'grid' ? 'grid' : 'normal';
let msel = false;
let selected = new Set<string>();
let libraryBodyEl: HTMLElement | null = null;

function fileKey(f: LocalFile): string {
  return (f.folder ?? '') ? 'local:' + f.folder + '/' + f.name : 'local:' + f.name;
}

function foldersIn(fold: string): string[] {
  const out = new Set<string>();
  for (const f of state.library) {
    const fo = f.folder ?? '';
    if (fo.startsWith(fold + '/')) {
      const rest = fo.slice(fold.length + 1);
      const first = rest.split('/')[0];
      if (first) out.add(fold ? fold + '/' + first : first);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b, 'zh'));
}

function filesIn(fold: string): LocalFile[] {
  return state.library.filter((f) => (f.folder ?? '') === fold);
}

function donutPct(key: string): number {
  const r = state.records[key];
  if (!r || !r.duration) return 0;
  return Math.min(100, Math.round((r.time / r.duration) * 100));
}

function starHtml(key: string): string {
  return isFavorite(key) ? '<span class="fav-star">★</span>' : '<span class="fav-star off">☆</span>';
}

function fileRowHtml(f: LocalFile, withChk: boolean): string {
  const key = fileKey(f);
  const p = donutPct(key);
  return `
  <div class="media-row${selected.has(key) ? ' sel' : ''}" data-key="${escapeHtml(key)}" data-name="${escapeHtml(f.name)}" data-folder="${escapeHtml(f.folder ?? '')}">
    ${withChk ? `<span class="chk${selected.has(key) ? ' on' : ''}" data-chk>${selected.has(key) ? '✓' : ''}</span>` : ''}
    ${starHtml(key)}
    ${mode === 'compact' ? `<span class="donut${p >= 97 ? ' full' : ''}" style="--p:${p}"></span>` : ''}
    <div class="media-row-main">
      <div class="media-row-title">${escapeHtml(titleOfKey(key))}</div>
      <div class="media-row-sub">${f.kind === 'subtitle' ? '字幕 · ' : ''}${fmtSize(f.size)} · ${new Date(f.modifiedAt).toLocaleDateString()}</div>
    </div>
    <button class="info-btn" data-act="info" title="详情">ℹ</button>
  </div>`;
}

function folderRowHtml(folder: string, withChk: boolean): string {
  const key = 'localfolder:' + folder;
  const name = folder.split('/').pop() || folder;
  return `
  <div class="media-row folder-row${selected.has(key) ? ' sel' : ''}" data-key="${escapeHtml(key)}" data-folderpath="${escapeHtml(folder)}">
    ${withChk ? `<span class="chk${selected.has(key) ? ' on' : ''}" data-chk>${selected.has(key) ? '✓' : ''}</span>` : ''}
    ${starHtml(key)}
    <span class="folder-ico">📁</span>
    <div class="media-row-main">
      <div class="media-row-title">${escapeHtml(name)}</div>
      <div class="media-row-sub">文件夹 · ${filesIn(folder).length} 个文件</div>
    </div>
    <button class="info-btn" data-act="info-f" title="详情">ℹ</button>
  </div>`;
}

export function renderLibrary(el: HTMLElement): void {
  libraryBodyEl = el;
  el.innerHTML = `
  <div class="page">
    <div class="page-head">
      <h1>媒体库</h1>
      <div class="page-actions">
        <button class="app-btn" data-act="import">导入视频</button>
        <button class="app-btn" data-act="clear">清空</button>
      </div>
    </div>
    <div class="tb">
      ${curFolder ? '<button class="tb-up" data-act="up">↑ 上一级</button><span class="tb-path">' + escapeHtml(curFolder) + '</span>' : '<span class="tb-path">媒体库根目录</span>'}
      <button class="tb-new" data-act="newfolder">+ 新建文件夹</button>
    </div>
    <div class="seg" data-el="seg">
      <button data-mode="normal" class="${mode === 'normal' ? 'on' : ''}">常规</button>
      <button data-mode="compact" class="${mode === 'compact' ? 'on' : ''}">紧凑</button>
      <button data-mode="grid" class="${mode === 'grid' ? 'on' : ''}">预览图</button>
    </div>
    <div data-el="body"></div>
  </div>
  ${msel ? msbarHtml() : ''}`;
  renderBody(el);
  bindEvents(el);
}

function renderBody(el: HTMLElement): void {
  const body = el.querySelector('[data-el="body"]');
  if (!body) return;
  const folders = foldersIn(curFolder);
  const files = filesIn(curFolder);
  if (!folders.length && !files.length) {
    body.innerHTML = `<div class="empty-state"><div class="empty-icon">📁</div><p>此文件夹为空</p><p class="empty-sub">点「导入视频」或「+ 新建文件夹」</p></div>`;
    return;
  }
  if (mode === 'grid') {
    body.innerHTML =
      folders.map((f) => folderRowHtml(f, msel)).join('') +
      (files.length
        ? `<div class="media-grid">${files
            .map(
              (f) => `
      <div class="media-card${selected.has(fileKey(f)) ? ' sel' : ''}" data-key="${escapeHtml(fileKey(f))}" data-name="${escapeHtml(f.name)}" data-folder="${escapeHtml(f.folder ?? '')}">
        ${msel ? `<span class="chk${selected.has(fileKey(f)) ? ' on' : ''}" data-chk>${selected.has(fileKey(f)) ? '✓' : ''}</span>` : ''}
        <div class="media-thumb"><span class="media-play">▶</span></div>
        <div class="media-name">${isFavorite(fileKey(f)) ? '★ ' : ''}${escapeHtml(titleOfKey(fileKey(f)))}</div>
        <div class="media-sub">${fmtSize(f.size)}</div>
      </div>`
            )
            .join('')}</div>`
        : '');
    return;
  }
  body.innerHTML = folders.map((f) => folderRowHtml(f, msel)).join('') + files.map((f) => fileRowHtml(f, msel)).join('');
}

function msbarHtml(): string {
  const keys = [...selected];
  const hasFav = keys.length > 0 && keys.every((k) => isFavorite(k));
  return `
  <div class="msbar">
    <span class="mscount">已选 ${keys.length} 项</span>
    <button class="app-btn ms-fav" data-ms="fav">${hasFav ? '☆ 取消收藏' : '★ 收藏'}</button>
    <button class="app-btn" data-ms="move">⇄ 移动</button>
    <button class="app-btn" data-ms="del">🗑 删除</button>
    <button class="app-btn" data-ms="cancel">取消</button>
  </div>`;
}

function bindEvents(el: HTMLElement): void {
  el.querySelector('[data-act="import"]')!.addEventListener('click', async () => {
    try {
      const files = await pickMedia(false);
      if (!files.length) return;
      addLocalFiles(files.map((f) => ({ ...f, folder: curFolder })));
      toast(`已导入 ${files.length} 个文件`);
      renderLibrary(el);
    } catch (e) {
      toast('导入失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  });
  el.querySelector('[data-act="clear"]')!.addEventListener('click', async () => {
    if (!(await confirmDialog('将删除所有本地视频和字幕文件（不可恢复）。确定？', '清空'))) return;
    await clearLibrary();
    toast('已清空');
    curFolder = '';
    renderLibrary(el);
  });
  const up = el.querySelector('[data-act="up"]');
  if (up) up.addEventListener('click', () => {
    const i = curFolder.lastIndexOf('/');
    curFolder = i > 0 ? curFolder.slice(0, i) : '';
    renderLibrary(el);
  });
  el.querySelector('[data-act="newfolder"]')!.addEventListener('click', async () => {
    const name = await promptDialog('新建文件夹', '文件夹名');
    if (!name) return;
    try {
      await createLocalFolder(curFolder, name);
      toast('已创建');
      renderLibrary(el);
    } catch (e) {
      toast('创建失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  });
  el.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => {
    b.addEventListener('click', () => {
      mode = b.dataset.mode as Mode;
      localStorage.setItem('player.v1.libMode', mode);
      renderLibrary(el);
    });
  });

  const body = el.querySelector('[data-el="body"]')!;
  body.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.media-row,.media-card');
    if (!row) return;
    if ((e.target as HTMLElement).closest('[data-act="info"],[data-act="info-f"]')) {
      e.stopPropagation();
      const folderPath = row.dataset.folderpath;
      if (folderPath !== undefined) showFolderDetail(el, folderPath);
      else showFileDetail(el, row.dataset.name || '', row.dataset.folder || '');
      return;
    }
    const key = row.dataset.key || '';
    if (msel) {
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      renderLibrary(el);
      return;
    }
    if (key.startsWith('localfolder:')) {
      curFolder = key.slice('localfolder:'.length);
      renderLibrary(el);
      return;
    }
    if (key.startsWith('local:')) openPlayer(key);
  });
  body.addEventListener('contextmenu', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.media-row,.media-card');
    if (!row) return;
    e.preventDefault();
    if (!msel) {
      msel = true;
      selected = new Set();
    }
    const key = row.dataset.key || '';
    if (!selected.has(key)) selected.add(key);
    renderLibrary(el);
  });

  const bar = el.querySelector('.msbar');
  if (bar) {
    bar.querySelector('[data-ms="cancel"]')!.addEventListener('click', () => {
      msel = false;
      selected = new Set();
      renderLibrary(el);
    });
    bar.querySelector('[data-ms="fav"]')!.addEventListener('click', () => {
      const keys = [...selected];
      if (!keys.length) return;
      const allFav = keys.every((k) => isFavorite(k));
      setFavoritesMany(keys, !allFav);
      toast(allFav ? `已取消收藏 ${keys.length} 项` : `已收藏 ${keys.length} 项`);
      renderLibrary(el);
    });
    bar.querySelector('[data-ms="move"]')!.addEventListener('click', () => {
      showTargetPicker(el, 'move');
    });
    bar.querySelector('[data-ms="del"]')!.addEventListener('click', async () => {
      const keys = [...selected];
      if (!(await confirmDialog(`删除 ${keys.length} 项（文件与记录）？`, '删除'))) return;
      for (const k of keys) {
        if (k.startsWith('localfolder:')) {
          const inner = filesIn(k.slice('localfolder:'.length));
          for (const f of inner) {
            try {
              await deleteLocalFile(f.name, f.folder ?? '');
            } catch { /* 忽略单个失败 */ }
            removeLocalFile(f.name, f.folder ?? '');
          }
        } else if (k.startsWith('local:')) {
          const rel = k.slice(6);
          const i = rel.lastIndexOf('/');
          const name = i >= 0 ? rel.slice(i + 1) : rel;
          const folder = i >= 0 ? rel.slice(0, i) : '';
          try {
            await deleteLocalFile(name, folder);
          } catch { /* 忽略 */ }
          removeLocalFile(name, folder);
        }
      }
      msel = false;
      selected = new Set();
      toast('已删除');
      renderLibrary(el);
    });
  }
}

/** 文件详情（ℹ）：信息行 + 收藏/改名/复制/移动/删除 */
function showFileDetail(el: HTMLElement, name: string, folder: string): void {
  const f = state.library.find((x) => x.name === name && (x.folder ?? '') === folder);
  if (!f) return;
  const key = fileKey(f);
  const rec = state.records[key];
  const wrap = modal(titleOfKey(key), `
    <div class="detail-box" style="position:static;width:auto;background:none;border:none;box-shadow:none;padding:0;max-height:none">
      <div class="detail-rows">
        <div class="drow"><span>类型</span><span>${f.kind === 'video' ? '视频' : '字幕'}</span></div>
        <div class="drow"><span>大小</span><span>${fmtSize(f.size)}</span></div>
        <div class="drow"><span>位置</span><span>${folder ? '/' + folder : '媒体库根目录'}</span></div>
        <div class="drow"><span>收藏</span><span data-d="favstate">${isFavorite(key) ? '★ 已收藏' : '未收藏'}</span></div>
        ${rec ? `<div class="drow"><span>进度</span><span>${fmtTime(rec.time)} / ${rec.duration ? fmtTime(rec.duration) : '—'}（${donutPct(key)}%）</span></div>` : ''}
      </div>
      <div class="detail-acts">
        <button class="app-btn" data-d="fav">${isFavorite(key) ? '取消收藏' : '★ 收藏'}</button>
        <button class="app-btn" data-d="rename">改名</button>
        <button class="app-btn" data-d="copy">复制</button>
        <button class="app-btn" data-d="move">移动</button>
      </div>
      <button class="app-btn danger" data-d="del" style="width:100%;margin-top:10px">删除</button>
    </div>`);
  const body = wrap.querySelector('.app-modal-body')!;
  body.querySelector('[data-d="fav"]')!.addEventListener('click', () => {
    setFavoritesMany([key], !isFavorite(key));
    wrap.remove();
    renderLibrary(el);
  });
  body.querySelector('[data-d="rename"]')!.addEventListener('click', async () => {
    const nn = await promptDialog('改名', name);
    wrap.remove();
    if (!nn || nn === name) return;
    try {
      await renameLocalItem(name, nn, folder);
      for (const x of state.library) if (x.name === name && (x.folder ?? '') === folder) x.name = nn;
      toast('已改名');
      renderLibrary(el);
    } catch (e) {
      toast('改名失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  });
  body.querySelector('[data-d="copy"]')!.addEventListener('click', () => {
    wrap.remove();
    showTargetPicker(el, 'copy', key);
  });
  body.querySelector('[data-d="move"]')!.addEventListener('click', () => {
    wrap.remove();
    showTargetPicker(el, 'move', key);
  });
  body.querySelector('[data-d="del"]')!.addEventListener('click', async () => {
    wrap.remove();
    if (!(await confirmDialog('删除该文件？', '删除'))) return;
    try {
      await deleteLocalFile(name, folder);
    } catch { /* 忽略 */ }
    removeLocalFile(name, folder);
    toast('已删除');
    renderLibrary(el);
  });
}

/** 文件夹详情（ℹ） */
function showFolderDetail(el: HTMLElement, folder: string): void {
  const key = 'localfolder:' + folder;
  const inner = filesIn(folder);
  const name = folder.split('/').pop() || folder;
  const wrap = modal('📁 ' + name, `
    <div class="detail-box" style="position:static;width:auto;background:none;border:none;box-shadow:none;padding:0;max-height:none">
      <div class="detail-rows">
        <div class="drow"><span>类型</span><span>文件夹</span></div>
        <div class="drow"><span>文件数</span><span>${inner.length}</span></div>
        <div class="drow"><span>位置</span><span>${folder.includes('/') ? '/' + folder.slice(0, folder.lastIndexOf('/')) : '媒体库根目录'}</span></div>
        <div class="drow"><span>收藏</span><span>${isFavorite(key) ? '★ 已收藏' : '未收藏'}</span></div>
      </div>
      <div class="detail-acts">
        <button class="app-btn" data-d="fav">${isFavorite(key) ? '取消收藏' : '★ 收藏'}</button>
        <button class="app-btn" data-d="rename">改名</button>
        <button class="app-btn" data-d="move">移动</button>
        <span></span>
      </div>
      <button class="app-btn danger" data-d="del" style="width:100%;margin-top:10px">删除文件夹（含其中文件）</button>
    </div>`);
  const body = wrap.querySelector('.app-modal-body')!;
  body.querySelector('[data-d="fav"]')!.addEventListener('click', () => {
    setFavoritesMany([key], !isFavorite(key));
    wrap.remove();
    renderLibrary(el);
  });
  body.querySelector('[data-d="rename"]')!.addEventListener('click', async () => {
    const nn = await promptDialog('文件夹改名', name);
    wrap.remove();
    if (!nn || nn === name) return;
    const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
    const newFolder = parent ? parent + '/' + nn : nn;
    try {
      await renameLocalItem(name, nn, parent);
      for (const x of state.library) if ((x.folder ?? '').startsWith(folder + '/')) x.folder = newFolder + (x.folder ?? '').slice(folder.length);
      else if ((x.folder ?? '') === folder) x.folder = newFolder;
      state.favorites = state.favorites.map((kk) => {
        if (kk === 'localfolder:' + folder) return 'localfolder:' + newFolder;
        if (kk.startsWith('localfolder:' + folder + '/')) return 'localfolder:' + newFolder + kk.slice(('localfolder:' + folder).length);
        if (kk.startsWith('local:' + folder + '/')) return 'local:' + newFolder + kk.slice(('local:' + folder).length);
        return kk;
      });
      toast('已改名');
      renderLibrary(el);
    } catch (e) {
      toast('改名失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  });
  body.querySelector('[data-d="move"]')!.addEventListener('click', () => {
    wrap.remove();
    showTargetPicker(el, 'move', key);
  });
  body.querySelector('[data-d="del"]')!.addEventListener('click', async () => {
    wrap.remove();
    if (!(await confirmDialog(`删除文件夹「${name}」及其 ${inner.length} 个文件？`, '删除'))) return;
    for (const f of inner) {
      try {
        await deleteLocalFile(f.name, f.folder ?? '');
      } catch { /* 忽略 */ }
      removeLocalFile(f.name, f.folder ?? '');
    }
    toast('已删除');
    renderLibrary(el);
  });
}

/** 目标文件夹选择器（复制/移动）：只显示文件夹，可进上一级。singleKey 为单项详情触发的 key（可空=多选） */
function showTargetPicker(el: HTMLElement, action: 'copy' | 'move', singleKey?: string): void {
  let pick = curFolder;
  const allFolders = new Set<string>();
  for (const f of state.library) {
    const fo = f.folder ?? '';
    let p = '';
    for (const seg of fo.split('/')) {
      p = p ? p + '/' + seg : seg;
      allFolders.add(p);
    }
  }
  const wrap = modal(action === 'copy' ? '复制到…' : '移动到…', `
    <div class="target-picker">
      <div class="tb">
        <button class="tb-up" data-p="up">↑ 上一级</button>
        <span class="tb-path" data-p="path"></span>
      </div>
      <div data-p="body"></div>
      <button class="app-btn primary" data-p="ok" style="width:100%;margin-top:14px">确定</button>
    </div>`);
  const pathEl = wrap.querySelector('[data-p="path"]') as HTMLElement;
  const bodyEl = wrap.querySelector('[data-p="body"]') as HTMLElement;
  const okEl = wrap.querySelector('[data-p="ok"]') as HTMLElement;
  const upEl = wrap.querySelector('[data-p="up"]') as HTMLElement;

  const draw = () => {
    const here = [...allFolders].filter((f) => f.startsWith(pick + '/') && !f.slice(pick.length + 1).includes('/'));
    pathEl.textContent = pick ? 'media/' + pick : 'media/（根目录）';
    bodyEl.innerHTML = here.length ? here.map((f) => `<div class="target-folder" data-f="${escapeHtml(f)}">📁 ${escapeHtml(f.split('/').pop() || '')}</div>`).join('') : '<div class="loading">此级没有子文件夹</div>';
  };
  draw();
  upEl.addEventListener('click', () => {
    const i = pick.lastIndexOf('/');
    pick = i > 0 ? pick.slice(0, i) : '';
    draw();
  });
  bodyEl.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.target-folder');
    if (t) {
      pick = t.dataset.f!;
      draw();
    }
  });
  okEl.addEventListener('click', async () => {
    wrap.remove();
    const apply = async (k: string) => {
      if (k.startsWith('localfolder:')) {
        const from = k.slice('localfolder:'.length);
        const lastSeg = from.split('/').pop()!;
        const parent = from.slice(0, from.length - lastSeg.length - 1);
        const newFrom = pick ? pick + '/' + lastSeg : lastSeg;
        if (newFrom === from) return;
        await moveLocalItem(lastSeg, parent, pick);
        for (const x of state.library) {
          const xf = x.folder ?? '';
          if (xf.startsWith(from + '/')) x.folder = newFrom + xf.slice(from.length);
          else if (xf === from) x.folder = newFrom;
        }
        state.favorites = state.favorites.map((kk) => {
          if (kk === 'localfolder:' + from) return 'localfolder:' + newFrom;
          if (kk.startsWith('localfolder:' + from + '/')) return 'localfolder:' + newFrom + kk.slice(('localfolder:' + from).length);
          if (kk.startsWith('local:' + from + '/')) return 'local:' + newFrom + kk.slice(('local:' + from).length);
          return kk;
        });
      } else if (k.startsWith('local:')) {
        const rel = k.slice(6);
        const i = rel.lastIndexOf('/');
        const fname = i >= 0 ? rel.slice(i + 1) : rel;
        const ffolder = i >= 0 ? rel.slice(0, i) : '';
        if (action === 'copy') await copyLocalItem(fname, ffolder, pick);
        else await moveLocalItem(fname, ffolder, pick);
      }
    };
    try {
      if (singleKey) {
        await apply(singleKey);
      } else {
        const keys = [...selected];
        if (!keys.length) return toast('请先选择要操作的文件');
        for (const k of keys) await apply(k);
        msel = false;
        selected = new Set();
      }
      toast(action === 'copy' ? '已复制' : '已移动');
      renderLibrary(el);
    } catch (e) {
      toast('操作失败: ' + (e instanceof Error ? e.message : String(e)));
      renderLibrary(el);
    }
  });
}
