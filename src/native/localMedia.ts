// LocalMedia 原生插件桥接 + Web 回退（开发/测试环境用 <input type="file">）

import { Capacitor, registerPlugin } from '@capacitor/core';

export interface PickedFile {
  name: string;
  size: number;
  kind: 'video' | 'subtitle';
  url: string; // localmedia:///<name>
}

export interface LocalFileInfo {
  name: string;
  size: number;
  kind: string;
  modifiedAt: number;
}

interface LocalMediaPluginInterface {
  pickMedia(options: { subtitles: boolean }): Promise<{ files: PickedFile[] }>;
  listFiles(): Promise<{ files: LocalFileInfo[] }>;
  deleteFile(options: { name: string }): Promise<{ ok: boolean }>;
  clearCache(): Promise<{ ok: boolean }>;
  captureFrame(options: { name: string; time: number }): Promise<{ image?: string; error?: string }>;
  saveImageToPhotos(options: { image: string }): Promise<{ ok: boolean }>;
  browseSMB(options: { host: string; port: string; share: string }): Promise<{ files: PickedFile[]; error?: string }>;
  listSMBFiles(): Promise<{ files: LocalFileInfo[] }>;
  releaseSMBFile(options: { name: string }): Promise<{ ok: boolean }>;
  readLog(): Promise<{ log: string }>;
  clearLog(): Promise<{ ok: boolean }>;
}

export const LocalMedia = registerPlugin<LocalMediaPluginInterface>('LocalMedia');

export const isNative = Capacitor.isNativePlatform();

/** Web 回退模式：文件名 → objectURL 的内存映射（会话内有效） */
const webFileUrls = new Map<string, string>();
const hasDom = typeof window !== 'undefined' && !!window.document;

/** 解析本地文件的播放/读取 URL。真机或无 DOM 环境（Node 测试）→ localmedia:// ；浏览器 → objectURL。找不到返回 null。 */
export function localUrl(name: string): string | null {
  if (isNative || !hasDom) return 'localmedia:///' + encodeURIComponent(name);
  return webFileUrls.get(name) ?? null;
}

/** SMB 会话文件的播放 URL（真机：localmedia:///smb%2F<name>，单段路径——WKWebView 媒体引擎对自定义 scheme 多段路径会在抓取前判 code=4 源不受支持；%2F 会被 url.path 解码回 /smb/<name>，handler 的 hasPrefix("smb/") 照常命中）；浏览器模式无 SMB */
export function smbUrl(name: string): string | null {
  if (isNative || !hasDom) return 'localmedia:///smb%2F' + encodeURIComponent(name);
  return null;
}

export interface SMBBrowseResult {
  files: PickedFile[];
  /** 直连失败时的错误信息（smb:// 不被识别 / 认证失败 / 网络不通） */
  error?: string;
}

/** 打开系统文档浏览器直连 smb://host/share 进入 NAS 目录树。
 *  用户在浏览器里点中视频并确认后返回该文件；取消返回空。浏览器模式返回空。 */
export async function browseSMB(opts: { host: string; port?: string; share?: string }): Promise<SMBBrowseResult> {
  if (!isNative) return { files: [] };
  try {
    const res = await LocalMedia.browseSMB({
      host: opts.host,
      port: opts.port ?? '',
      share: opts.share ?? ''
    });
    return { files: res.files, error: res.error };
  } catch (e) {
    return { files: [], error: String(e) };
  }
}

export async function listSMBFiles(): Promise<LocalFileInfo[]> {
  if (!isNative) return [];
  try {
    const res = await LocalMedia.listSMBFiles();
    return res.files;
  } catch {
    return [];
  }
}

export async function releaseSMBFile(name: string): Promise<void> {
  if (!isNative) return;
  try {
    await LocalMedia.releaseSMBFile({ name });
  } catch {
    // 忽略
  }
}

/** 选择本地视频 / 字幕文件（真机走系统文件选择器，浏览器走 file input） */
export async function pickMedia(subtitles: boolean): Promise<PickedFile[]> {
  if (isNative) {
    const res = await LocalMedia.pickMedia({ subtitles });
    return res.files;
  }
  return pickMediaWeb(subtitles);
}

function pickMediaWeb(subtitles: boolean): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    const accept = subtitles
      ? 'video/*,.mp4,.mov,.mkv,.avi,.webm,.srt,.ass,.ssa,.sub'
      : 'video/*,.mp4,.mov,.mkv,.avi,.webm';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    const cleanup = () => input.remove();
    input.onchange = () => {
      const files: PickedFile[] = [];
      for (const f of Array.from(input.files ?? [])) {
        const dot = f.name.lastIndexOf('.');
        const ext = dot >= 0 ? f.name.slice(dot + 1).toLowerCase() : '';
        const kind = ['srt', 'ass', 'ssa', 'sub'].includes(ext) ? 'subtitle' : 'video';
        const url = URL.createObjectURL(f);
        webFileUrls.set(f.name, url);
        files.push({ name: f.name, size: f.size, kind, url });
      }
      cleanup();
      resolve(files);
    };
    // 取消选择时 input.files 为空且 onchange 不触发 → 用 focus 兜底
    const onFocus = () => {
      setTimeout(() => {
        if (!input.files || input.files.length === 0) {
          cleanup();
          resolve([]);
        }
        window.removeEventListener('focus', onFocus);
      }, 1500);
    };
    window.addEventListener('focus', onFocus);
    input.click();
  });
}

/** 列出本地缓存文件 */
export async function listLocalFiles(): Promise<LocalFileInfo[]> {
  if (isNative) {
    const res = await LocalMedia.listFiles();
    return res.files;
  }
  return [];
}

export async function deleteLocalFile(name: string): Promise<void> {
  if (isNative) await LocalMedia.deleteFile({ name });
}

export async function clearLocalCache(): Promise<void> {
  if (isNative) await LocalMedia.clearCache();
}

/** 原生截帧（base64 JPEG）；失败返回 null */
export async function captureFrame(name: string, time: number): Promise<string | null> {
  if (!isNative) return null;
  try {
    const res = await LocalMedia.captureFrame({ name, time });
    return res.image ?? null;
  } catch {
    return null;
  }
}

/** 保存 base64 图片到相册 */
export async function saveImageToPhotos(base64: string): Promise<boolean> {
  if (!isNative) return false;
  try {
    await LocalMedia.saveImageToPhotos({ image: base64 });
    return true;
  } catch {
    return false;
  }
}

/** 读取原生调试日志（最后 400 行；闪退后重启 App 日志依然存活） */
export async function readLog(): Promise<string> {
  if (!isNative) return '';
  try {
    const res = await LocalMedia.readLog();
    return res.log || '';
  } catch {
    return '';
  }
}

export async function clearLog(): Promise<void> {
  if (isNative) await LocalMedia.clearLog();
}

/** 读取本地字幕/文本文件内容（localmedia:// URL 或 object URL） */
export async function readTextFile(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
