// WebDAV 客户端（PROPFIND 列目录 / MOVE 重命名 / DELETE 删除 / 直链流播）

import type { MediaItem, Source } from '../core/types';
import { isVideoName, isSubtitleName } from '../core/util';

export interface WebDAVEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export class WebDAVClient {
  constructor(
    private host: string,
    private user?: string,
    private pass?: string
  ) {}

  private base(): string {
    let h = this.host.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
    return h;
  }

  private auth(): string | null {
    if (!this.user) return null;
    return 'Basic ' + btoa(this.user + ':' + (this.pass ?? ''));
  }

  private url(path: string): string {
    const p = path.startsWith('/') ? path : '/' + path;
    return this.base() + p.split('/').map(encodeURIComponent).join('/');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    const a = this.auth();
    if (a) h['Authorization'] = a;
    return h;
  }

  /** 列出目录（Depth 1）。path 为空表示根目录。 */
  async list(path: string): Promise<WebDAVEntry[]> {
    const res = await fetch(this.url(path || '/'), {
      method: 'PROPFIND',
      headers: this.headers({
        Depth: '1',
        'Content-Type': 'application/xml'
      }),
      body: '<?xml version="1.0" encoding="UTF-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getcontentlength/><D:getlastmodified/></D:prop></D:propfind>'
    });
    if (!res.ok) throw new Error('PROPFIND ' + res.status);
    const xml = await res.text();
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const ns = 'DAV:';
    const responses = Array.from(doc.getElementsByTagNameNS(ns, 'response'));
    const entries: WebDAVEntry[] = [];
    const selfPath = (path || '/').replace(/\/+$/, '');
    for (const r of responses) {
      const hrefEl = r.getElementsByTagNameNS(ns, 'href')[0];
      if (!hrefEl) continue;
      let href = decodeURIComponent(hrefEl.textContent || '');
      href = href.replace(/^https?:\/\/[^/]+/, '');
      if (href.replace(/\/+$/, '') === selfPath) continue; // 跳过目录自身
      const collection = r.getElementsByTagNameNS(ns, 'collection').length > 0;
      const lenEl = r.getElementsByTagNameNS(ns, 'getcontentlength')[0];
      const modEl = r.getElementsByTagNameNS(ns, 'getlastmodified')[0];
      const name = href.split('/').filter(Boolean).pop() || href;
      entries.push({
        name,
        path: href.replace(/\/+$/, ''),
        isDir: collection,
        size: lenEl ? parseInt(lenEl.textContent || '0', 10) || 0 : 0,
        modified: modEl ? Date.parse(modEl.textContent || '') || 0 : 0
      });
    }
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return entries;
  }

  /** 重命名 / 移动（云端文件重命名） */
  async rename(oldPath: string, newPath: string): Promise<void> {
    const res = await fetch(this.url(oldPath), {
      method: 'MOVE',
      headers: this.headers({ Destination: this.url(newPath), Overwrite: 'T' })
    });
    if (!res.ok && res.status !== 201) throw new Error('MOVE ' + res.status);
  }

  async remove(path: string): Promise<void> {
    const res = await fetch(this.url(path), { method: 'DELETE', headers: this.headers() });
    if (!res.ok) throw new Error('DELETE ' + res.status);
  }

  /** 直接播放地址（浏览器原生 Range 流式） */
  streamUrl(path: string): string {
    return this.url(path);
  }

  /** 供 registry 使用：条目 → MediaItem（path 用服务器返回的绝对路径） */
  items(_source: Source, entries: WebDAVEntry[]): MediaItem[] {
    return entries.map((e) => {
      const p = e.path.startsWith('/') ? e.path : '/' + e.path;
      const item: MediaItem = {
        key: 'webdav:' + _source.id + '/' + p,
        title: e.name,
        isDir: e.isDir,
        path: p,
        size: e.size,
        sourceId: _source.id,
        sourceType: 'webdav'
      };
      if (!e.isDir) item.url = this.streamUrl(p);
      return item;
    });
  }
}
