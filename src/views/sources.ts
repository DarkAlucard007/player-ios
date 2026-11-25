// 媒体源添加 / 配置修改页（v1.1.26 设计稿 V4）

import { state, addSource, updateSource, removeSource } from '../core/store';
import type { Source, SourceType } from '../core/types';
import { escapeHtml } from '../core/util';
import { confirmDialog, toast } from '../components/ui';
import { makeWebDAV } from '../sources/registry';

const TYPE_META: Record<SourceType, { ico: string; label: string }> = {
  smb: { ico: '📡', label: 'NAS (SMB)' },
  webdav: { ico: '🗂', label: 'WebDAV' },
  emby: { ico: '🎥', label: 'Emby' },
  jellyfin: { ico: '🎬', label: 'Jellyfin' }
};

function formHtml(s: Source | null, editing: boolean, cur: SourceType): string {
  const typeChips = (['smb', 'webdav', 'emby', 'jellyfin'] as SourceType[])
    .map((k) => `<button type="button" class="pv-chip${k === cur ? ' on' : ''}" data-t="${k}"${editing ? ' disabled' : ''}>${TYPE_META[k].label}</button>`)
    .join('');
  const fields =
    cur === 'smb'
      ? `
    <label>NAS 地址 (IP/域名)</label><input name="host" value="${escapeHtml(s?.host ?? '')}" placeholder="192.168.1.100">
    <label>端口（默认 445，可留空）</label><input name="port" value="${escapeHtml(s?.port ?? '')}" placeholder="445">
    <label>共享名</label><input name="share" value="${escapeHtml(s?.share ?? '')}" placeholder="video">`
      : cur === 'webdav'
        ? `
    <label>服务器地址</label><input name="host" value="${escapeHtml(s?.host ?? '')}" placeholder="https://dav.example.com">
    <label>根路径（可留空 = 根目录）</label><input name="rootPath" value="${escapeHtml(s?.rootPath ?? '')}" placeholder="/media">`
        : `
    <label>服务器地址</label><input name="host" value="${escapeHtml(s?.host ?? '')}" placeholder="http://192.168.1.50:8096">
    <label>API Key</label><input name="apiKey" value="${escapeHtml(s?.apiKey ?? '')}" placeholder="从媒体服务器设置中获取">`;
  return `
  <div class="page">
    <div class="page-head">
      <h1>${editing ? '修改媒体源' : '添加媒体源'}</h1>
      <div class="page-actions"><button class="app-btn" data-act="back">‹ 返回</button></div>
    </div>
    <div class="form">
      <label>名称</label><input name="name" value="${escapeHtml(s?.name ?? '')}" placeholder="我的 NAS">
      <label>类型</label>
      <div class="pv-speed-row" style="flex-wrap:wrap">${typeChips}</div>
      ${fields}
      <label>账号（SMB / WebDAV 可留空）</label><input name="user" value="${escapeHtml(s?.user ?? '')}" placeholder="guest">
      <label>密码</label><input name="pass" type="password" value="${escapeHtml(s?.pass ?? '')}" placeholder="••••••">
      <div class="form-btns">
        <button class="app-btn" data-act="test" ${cur === 'smb' ? 'disabled' : ''}>测试连接</button>
        <button class="app-btn primary" data-act="save">保存</button>
      </div>
      <div class="form-status" data-el="status"></div>
      ${editing ? '<button class="app-btn danger form-del-src" data-act="del-src">删除此媒体源</button>' : ''}
    </div>
  </div>`;
}

async function testConnection(cur: SourceType, get: (n: string) => string): Promise<void> {
  if (cur === 'webdav') {
    const c = makeWebDAV({ id: 'test', type: 'webdav', name: 'test', host: get('host'), rootPath: get('rootPath') || '/', user: get('user'), pass: get('pass') });
    const entries = await c.list(get('rootPath') || '/');
    void entries;
  } else if (cur === 'emby' || cur === 'jellyfin') {
    const base = get('host').replace(/\/+$/, '');
    const r = await fetch(base + '/System/Info', { headers: { 'X-Emby-Token': get('apiKey'), 'X-Media-Token': get('apiKey') } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const sys = (await r.json()) as { Version?: string };
    if (!sys.Version) throw new Error('返回无版本号');
  }
}

export function renderSourceAdd(el: HTMLElement): void {
  let cur: SourceType = 'smb';
  const draw = () => {
    el.innerHTML = formHtml(null, false, cur);
    el.querySelector('[data-act="back"]')!.addEventListener('click', () => (location.hash = '#/browse'));
    el.querySelectorAll<HTMLButtonElement>('[data-t]').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.disabled) return;
        cur = b.dataset.t as SourceType;
        draw();
      });
    });
    el.querySelector('[data-act="test"]')!.addEventListener('click', async () => {
      const st = el.querySelector('[data-el="status"]') as HTMLElement;
      const get = (n: string) => (el.querySelector<HTMLInputElement>(`input[name="${n}"]`)?.value ?? '').trim();
      st.textContent = '测试中…';
      st.className = 'form-status';
      try {
        await testConnection(cur, get);
        st.textContent = '✓ 连接成功';
        st.className = 'form-status ok';
      } catch (e) {
        st.textContent = '✗ ' + (e instanceof Error ? e.message : String(e));
        st.className = 'form-status err';
      }
    });
    el.querySelector('[data-act="save"]')!.addEventListener('click', () => {
      const get = (n: string) => (el.querySelector<HTMLInputElement>(`input[name="${n}"]`)?.value ?? '').trim();
      const name = get('name');
      const host = get('host');
      if (!name) return toast('请填写名称');
      if (!host) return toast('请填写地址');
      if (cur === 'smb' && !get('share')) return toast('请填写共享名');
      addSource({
        type: cur,
        name,
        host,
        port: get('port') || undefined,
        share: get('share') || undefined,
        rootPath: get('rootPath') || undefined,
        user: get('user') || undefined,
        pass: get('pass') || undefined,
        apiKey: get('apiKey') || undefined
      });
      toast('已添加');
      location.hash = '#/browse';
    });
  };
  draw();
}

export function renderSourceEdit(el: HTMLElement, id: string): void {
  const s = state.sources.find((x) => x.id === id);
  if (!s) {
    el.innerHTML = '<div class="page"><div class="empty-state"><div class="empty-icon">🗂</div><p>媒体源不存在</p></div></div>';
    return;
  }
  el.innerHTML = formHtml(s, true, s.type);
  const get = (n: string) => (el.querySelector<HTMLInputElement>(`input[name="${n}"]`)?.value ?? '').trim();
  el.querySelector('[data-act="back"]')!.addEventListener('click', () => (location.hash = '#/browse'));
  el.querySelector('[data-act="test"]')!.addEventListener('click', async () => {
    const st = el.querySelector('[data-el="status"]') as HTMLElement;
    st.textContent = '测试中…';
    st.className = 'form-status';
    try {
      await testConnection(s.type, get);
      st.textContent = '✓ 连接成功';
      st.className = 'form-status ok';
    } catch (e) {
      st.textContent = '✗ ' + (e instanceof Error ? e.message : String(e));
      st.className = 'form-status err';
    }
  });
  el.querySelector('[data-act="save"]')!.addEventListener('click', () => {
    updateSource(s.id, {
      name: get('name') || s.name,
      host: get('host') || s.host,
      port: get('port') || undefined,
      share: get('share') || undefined,
      rootPath: get('rootPath') || undefined,
      user: get('user') || undefined,
      pass: get('pass') || undefined,
      apiKey: get('apiKey') || undefined
    });
    toast('已保存');
    location.hash = '#/browse';
  });
  el.querySelector('[data-act="del-src"]')!.addEventListener('click', async () => {
    if (!(await confirmDialog(`删除媒体源「${s.name}」？其播放列表项和进度也会失效。`, '删除'))) return;
    removeSource(s.id);
    toast('已删除');
    location.hash = '#/browse';
  });
}
