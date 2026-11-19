// 通用工具函数

export const VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'mkv', 'avi', 'webm', 'rmvb', 'rm', 'wmv', 'ts', 'flv', '3gp', 'mpg', 'mpeg'];
export const SUBTITLE_EXTS = ['srt', 'ass', 'ssa', 'sub'];

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function isVideoName(name: string): boolean {
  return VIDEO_EXTS.includes(extOf(name));
}

export function isSubtitleName(name: string): boolean {
  return SUBTITLE_EXTS.includes(extOf(name));
}

export function baseName(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/** 秒 → hh:mm:ss 或 mm:ss */
export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 把媒体 key 解析成展示标题 */
export function titleOfKey(key: string): string {
  if (key.startsWith('local:')) return key.slice(6);
  if (key.startsWith('webdav:')) {
    const rest = key.slice(7);
    const slash = rest.lastIndexOf('/');
    return slash >= 0 ? rest.slice(slash + 1) : rest;
  }
  return key;
}
