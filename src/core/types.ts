// 全局数据类型定义

export type MediaKind = 'video' | 'subtitle';

export type SourceType = 'webdav' | 'emby' | 'jellyfin';

/** 本地缓存中的文件（经 LocalMedia 插件导入） */
export interface LocalFile {
  name: string;
  size: number;
  kind: MediaKind;
  addedAt: number;
  modifiedAt: number;
}

/** 媒体库条目（本地 / WebDAV / Emby 统一模型） */
export interface MediaItem {
  key: string; // local:<name> | webdav:<srcId>/<path> | emby:<srcId>/<itemId>
  title: string;
  url?: string; // 直接播放地址（网络源）
  sourceId?: string;
  sourceType?: SourceType;
  isDir?: boolean;
  path?: string;
  size?: number;
  duration?: number;
  year?: number;
  overview?: string;
  genres?: string[];
  imageTag?: string;
  season?: number;
  episode?: number;
}

export interface Source {
  id: string;
  type: SourceType;
  name: string;
  host: string; // 如 http://192.168.1.10:5005 或 192.168.1.10:8096
  user?: string;
  pass?: string;
  rootPath?: string; // WebDAV 根路径
  apiKey?: string; // Emby / Jellyfin
}

export interface Playlist {
  id: string;
  name: string;
  items: string[]; // media keys（按顺序播放）
  createdAt: number;
}

export interface PlaybackRecord {
  time: number;
  duration: number;
  updatedAt: number;
}

export interface SubtitleStyle {
  size: number; // 字号 px
  color: string;
  outline: number; // 描边 0-4
  background: number; // 背景不透明 0-100
  position: number; // 距底部偏移 px
}

export interface Settings {
  defaultSpeed: number;
  autoNext: boolean;
  subtitleStyle: SubtitleStyle;
}

export interface AppState {
  version: 1;
  library: LocalFile[];
  sources: Source[];
  playlists: Playlist[];
  records: Record<string, PlaybackRecord>;
  settings: Settings;
}
