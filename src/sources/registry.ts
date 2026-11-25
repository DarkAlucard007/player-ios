// 媒体源注册表：按类型分发浏览请求，把 media key 解析成可播放地址

import { state } from '../core/store';
import type { MediaItem, Source } from '../core/types';
import { localUrl, smbUrl } from '../native/localMedia';
import { WebDAVClient } from './webdav';
import { makeClient } from './mediaServer';

export function getSource(id: string): Source | undefined {
  return state.sources.find((s) => s.id === id);
}

export function makeWebDAV(source: Source): WebDAVClient {
  return new WebDAVClient(source.host, source.user, source.pass);
}

/** 浏览某个源的目录（WebDAV 按路径；Emby/Jellyfin 全库列表） */
export async function browseSource(source: Source, path: string, searchTerm?: string): Promise<MediaItem[]> {
  if (source.type === 'webdav') {
    const client = makeWebDAV(source);
    const entries = await client.list(path || (source.rootPath || ''));
    return client.items(source, entries);
  }
  const client = makeClient(source);
  return client.listVideos(searchTerm);
}

/** 测试源连通性 */
export async function testSource(source: Source): Promise<boolean> {
  if (source.type === 'webdav') {
    try {
      await makeWebDAV(source).list(source.rootPath || '');
      return true;
    } catch {
      return false;
    }
  }
  return makeClient(source).ping();
}

export interface ResolvedPlayback {
  url: string;
  title: string;
  /** 本地文件名（用于截帧/字幕匹配），网络源为 null */
  localName: string | null;
  /** SMB 会话文件名（关闭播放器时释放安全作用域访问） */
  smbName?: string | null;
}

/** 把 media key 解析成播放地址。
 *  v1.1.26：local key 可带文件夹，形如 local:<folder>/<name>（folder 可含多级）。 */
export function resolvePlayback(key: string): ResolvedPlayback | null {
  if (key.startsWith('local:')) {
    const rest = key.slice(6);
    const slash = rest.lastIndexOf('/');
    const folder = slash >= 0 ? rest.slice(0, slash) : '';
    const name = slash >= 0 ? rest.slice(slash + 1) : rest;
    const rel = folder ? folder + '/' + name : name;
    const file = state.library.find((f) => f.name === name && (f.folder ?? '') === folder && f.kind === 'video');
    if (!file) return null;
    const url = localUrl(rel);
    if (!url) return null;
    return { url, title: name, localName: rel };
  }
  if (key.startsWith('webdav:')) {
    const rest = key.slice(7);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    const source = getSource(rest.slice(0, slash));
    if (!source || source.type !== 'webdav') return null;
    const path = rest.slice(slash + 1);
    return {
      url: makeWebDAV(source).streamUrl(path),
      title: path.split('/').filter(Boolean).pop() || path,
      localName: null
    };
  }
  if (key.startsWith('smb:')) {
    const name = key.slice(4);
    const url = smbUrl(name);
    if (!url) return null;
    return { url, title: name, localName: null, smbName: name };
  }
  if (key.startsWith('emby:')) {
    const rest = key.slice(5);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    const source = getSource(rest.slice(0, slash));
    if (!source || (source.type !== 'emby' && source.type !== 'jellyfin')) return null;
    const itemId = rest.slice(slash + 1);
    return {
      url: makeClient(source).streamUrl(itemId),
      title: itemId,
      localName: null
    };
  }
  return null;
}

/** 本地媒体自动匹配同名外挂字幕（同文件夹、同名 .srt/.ass/.ssa/.sub）。
 *  v1.1.26：localName 可带文件夹前缀。 */
export function findMatchingSubtitle(localName: string): string | null {
  const slash = localName.lastIndexOf('/');
  const folder = slash >= 0 ? localName.slice(0, slash) : '';
  const name = slash >= 0 ? localName.slice(slash + 1) : localName;
  const base = name.slice(0, name.lastIndexOf('.'));
  const subs = ['srt', 'ass', 'ssa', 'sub'];
  for (const ext of subs) {
    const hit = state.library.find((f) => f.kind === 'subtitle' && (f.folder ?? '') === folder && f.name === `${base}.${ext}`);
    if (hit) return folder ? folder + '/' + hit.name : hit.name;
  }
  return null;
}
