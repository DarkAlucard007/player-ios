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
  deleteFile(options: { name: string; folder?: string }): Promise<{ ok: boolean }>;
  clearCache(): Promise<{ ok: boolean }>;
  captureFrame(options: { name: string; time: number }): Promise<{ image?: string; error?: string }>;
  saveImageToPhotos(options: { image: string }): Promise<{ ok: boolean }>;
  browseSMB(options: { host: string; port: string; share: string }): Promise<{ files: PickedFile[]; error?: string }>;
  listSMBFiles(): Promise<{ files: LocalFileInfo[] }>;
  releaseSMBFile(options: { name: string }): Promise<{ ok: boolean }>;
  readLog(): Promise<{ log: string }>;
  clearLog(): Promise<{ ok: boolean }>;
  selfTest(): Promise<{ name: string; size: number }>;
  // v1.1.26
  setOrientation(options: { orientation: 'portrait' | 'landscapeLeft' | 'landscapeRight' }): Promise<{ ok: boolean }>;
  listFiles(options?: { folder?: string }): Promise<{ folders: string[]; files: LocalFileInfo[] }>;
  createFolder(options: { folder: string; name: string }): Promise<{ ok: boolean }>;
  renameItem(options: { name: string; newName: string; folder: string }): Promise<{ ok: boolean }>;
  moveItem(options: { name: string; folder: string; destFolder: string }): Promise<{ ok: boolean }>;
  copyItem(options: { name: string; folder: string; destFolder: string }): Promise<{ ok: boolean }>;
  listSMBDir(options: { host: string; port: string; share: string; path: string; user?: string; pass?: string }): Promise<{ folders: string[]; files: LocalFileInfo[] }>;
  createSMBFolder(options: { host: string; port: string; share: string; path: string; user?: string; pass?: string; name: string }): Promise<{ ok: boolean }>;
  renameSMBItem(options: { host: string; port: string; share: string; path: string; user?: string; pass?: string; name: string; newName: string }): Promise<{ ok: boolean }>;
  moveSMBItem(options: { host: string; port: string; share: string; path: string; user?: string; pass?: string; name: string; destPath: string }): Promise<{ ok: boolean }>;
  copySMBItem(options: { host: string; port: string; share: string; path: string; user?: string; pass?: string; name: string; destPath: string }): Promise<{ ok: boolean }>;
  deleteSMBItem(options: { host: string; port: string; share: string; path: string; user?: string; pass?: string; name: string }): Promise<{ ok: boolean }>;
  openSMBFile(options: { host: string; port: string; share: string; path: string; user?: string; pass?: string; name: string }): Promise<PickedFile>;
  // v1.1.27
  connectSMB(options: { host: string; port: string; share: string }): Promise<{ ok: boolean; name?: string }>;
  // v1.1.31：FFmpeg 原生播放（url 可为 smb2:<key> / localmedia:///<name> / http(s)://…）
  playNative(options: { url: string; title?: string; subs?: { url: string }[]; nextUrl?: string; nextTitle?: string }): Promise<{ ok: boolean }>;
  // v1.1.33：前端写调试日志
  writeDebug(options: { msg: string }): Promise<void>;
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

/** SMB 会话文件的播放 URL（真机：localmedia:///smb%2F<name>，单段路径——WKWebView 媒体引擎对自定义 scheme 多段路径会在抓取前判 code=4 源不受支持；%2F 由原生 handler 显式解码回 /smb/<name> 再路由，v1.1.17 修复）；浏览器模式无 SMB */
export function smbUrl(name: string): string | null {
  if (isNative || !hasDom) return 'localmedia:///smb%2F' + encodeURIComponent(name);
  return null;
}

// v1.1.31：iOS <video>（AVFoundation）只稳支持 MP4/MOV/M4V（H.264/HEVC+AAC）。
// 其余容器（MKV/AVI/FLV/RMVB/TS/WebM/OGG/WMV/VOB/MPG…）走原生 FFmpeg 播放。
const NATIVE_EXTS = ['mkv', 'avi', 'flv', 'rmvb', 'rm', 'ts', 'm2ts', 'webm', 'ogv', 'ogg', 'wmv', 'asf', 'vob', 'mpg', 'mpeg'];
export function needsNativePlayer(name: string): boolean {
  if (!isNative) return false; // 浏览器模式无 FFmpeg，退回 <video>
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  return NATIVE_EXTS.includes(ext);
}

/** v1.1.31：用原生 FFmpeg 播放器全屏播放。url 可为 smb2:<key> / localmedia:///<name> / http(s)://… */
export async function playNative(opts: { url: string; title?: string; subs?: { url: string }[]; nextUrl?: string; nextTitle?: string }): Promise<void> {
  if (!isNative) throw new Error('浏览器模式无原生 FFmpeg 播放器');
  try {
    await LocalMedia.playNative(opts);
  } catch (e) {
    console.warn('playNative 失败', e);
    throw e;
  }
}

/** v1.1.33：把一行调试信息写入原生 app-debug.log（排查播放路由/FFmpeg 链路）。浏览器模式静默跳过。 */
export async function writeDebug(msg: string): Promise<void> {
  if (!isNative) return;
  try {
    await LocalMedia.writeDebug({ msg });
  } catch { /* 日志失败不影响播放 */ }
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

/** 列出本地缓存文件（v1.1.26：folder 参数，""=根目录；返回该层级的文件夹与文件） */
export async function listLocalFiles(folder = ''): Promise<{ folders: string[]; files: LocalFileInfo[] }> {
  if (isNative) {
    return LocalMedia.listFiles({ folder });
  }
  return { folders: [], files: [] };
}

export async function deleteLocalFile(name: string, folder = ''): Promise<void> {
  if (isNative) await LocalMedia.deleteFile({ name, folder });
}

export async function createLocalFolder(folder: string, name: string): Promise<void> {
  if (isNative) await LocalMedia.createFolder({ folder, name });
}

export async function renameLocalItem(name: string, newName: string, folder = ''): Promise<void> {
  if (isNative) await LocalMedia.renameItem({ name, newName, folder });
}

export async function moveLocalItem(name: string, folder: string, destFolder: string): Promise<void> {
  if (isNative) await LocalMedia.moveItem({ name, folder, destFolder });
}

export async function copyLocalItem(name: string, folder: string, destFolder: string): Promise<void> {
  if (isNative) await LocalMedia.copyItem({ name, folder, destFolder });
}

export type ScreenOrientation = 'portrait' | 'landscapeLeft' | 'landscapeRight';

/** 屏幕旋转（原生）；浏览器模式静默忽略 */
export async function setOrientation(o: ScreenOrientation): Promise<void> {
  if (!isNative) return;
  try {
    await LocalMedia.setOrientation({ orientation: o });
  } catch {
    // 忽略（某些系统版本不支持）
  }
}

// ---- v1.1.26：NAS 目录操作（FileManager 对 smb:// 的原生支持） ----

export interface SMBDirOpts {
  host: string;
  port?: string;
  share: string;
  path?: string;
  user?: string;
  pass?: string;
}

export async function listSMBDir(opts: SMBDirOpts): Promise<{ folders: string[]; files: LocalFileInfo[] }> {
  if (!isNative) return { folders: [], files: [] };
  const res = await LocalMedia.listSMBDir({
    host: opts.host,
    port: opts.port ?? '',
    share: opts.share ?? '',
    path: opts.path ?? '',
    user: opts.user ?? '',
    pass: opts.pass ?? ''
  });
  return { folders: res.folders, files: res.files };
}

export async function createSMBFolder(opts: SMBDirOpts, name: string): Promise<void> {
  if (!isNative) return;
  await LocalMedia.createSMBFolder({ host: opts.host, port: opts.port ?? '', share: opts.share ?? '', path: opts.path ?? '', user: opts.user ?? '', pass: opts.pass ?? '', name });
}

export async function renameSMBItem(opts: SMBDirOpts, name: string, newName: string): Promise<void> {
  if (!isNative) return;
  await LocalMedia.renameSMBItem({ host: opts.host, port: opts.port ?? '', share: opts.share ?? '', path: opts.path ?? '', user: opts.user ?? '', pass: opts.pass ?? '', name, newName });
}

export async function moveSMBItem(opts: SMBDirOpts, name: string, destPath: string): Promise<void> {
  if (!isNative) return;
  await LocalMedia.moveSMBItem({ host: opts.host, port: opts.port ?? '', share: opts.share ?? '', path: opts.path ?? '', user: opts.user ?? '', pass: opts.pass ?? '', name, destPath });
}

export async function copySMBItem(opts: SMBDirOpts, name: string, destPath: string): Promise<void> {
  if (!isNative) return;
  await LocalMedia.copySMBItem({ host: opts.host, port: opts.port ?? '', share: opts.share ?? '', path: opts.path ?? '', user: opts.user ?? '', pass: opts.pass ?? '', name, destPath });
}

export async function deleteSMBItem(opts: SMBDirOpts, name: string): Promise<void> {
  if (!isNative) return;
  await LocalMedia.deleteSMBItem({ host: opts.host, port: opts.port ?? '', share: opts.share ?? '', path: opts.path ?? '', user: opts.user ?? '', pass: opts.pass ?? '', name });
}

/** v1.1.28：内置 SMB2 客户端直连打开 NAS 视频，无需系统选择器授权 */
export async function openSMBFile(opts: SMBDirOpts, name: string): Promise<PickedFile> {
  if (!isNative) throw new Error('浏览器模式无 SMB');
  return LocalMedia.openSMBFile({ host: opts.host, port: opts.port ?? '', share: opts.share ?? '', path: opts.path ?? '', user: opts.user ?? '', pass: opts.pass ?? '', name });
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

/** 播放自测：让原生层把内置 sample.mp4 复制进媒体缓存目录，返回文件名与大小。
 *  仅原生端可用；浏览器端 reject（自测没有意义）。 */
export async function selfTest(): Promise<{ name: string; size: number }> {
  if (!isNative) throw new Error('播放自测仅原生端可用');
  return LocalMedia.selfTest();
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
