// 全局状态：localStorage 持久化 + 订阅通知

import type { AppState, LocalFile, PlaybackRecord, Playlist, Settings, Source } from './types';
import { uid } from './util';

const KEY = 'player.v1';

const DEFAULT_SETTINGS: Settings = {
  defaultSpeed: 1,
  autoNext: true,
  subtitleStyle: {
    size: 20,
    color: '#ffffff',
    outline: 2,
    background: 40,
    position: 48
  }
};

function defaultState(): AppState {
  return {
    version: 1,
    library: [],
    sources: [],
    playlists: [],
    records: {},
    settings: { ...DEFAULT_SETTINGS, subtitleStyle: { ...DEFAULT_SETTINGS.subtitleStyle } }
  };
}

function load(): AppState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as AppState;
    if (!parsed || parsed.version !== 1) return defaultState();
    // 兜底补齐缺省字段
    parsed.settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
    parsed.settings.subtitleStyle = { ...DEFAULT_SETTINGS.subtitleStyle, ...parsed.settings.subtitleStyle };
    return parsed;
  } catch {
    return defaultState();
  }
}

export const state: AppState = load();

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // 存储满时静默失败（不影响播放）
    }
  }, 150);
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): void {
  listeners.add(fn);
}

export function notify(): void {
  persist();
  for (const fn of listeners) fn();
}

// ---- 本地媒体库 ----

export function addLocalFiles(files: Array<{ name: string; size: number; kind: 'video' | 'subtitle'; modifiedAt?: number }>): void {
  const now = Date.now();
  for (const f of files) {
    const exists = state.library.find((x) => x.name === f.name);
    if (exists) {
      exists.size = f.size;
      exists.kind = f.kind;
      exists.modifiedAt = f.modifiedAt ?? now;
    } else {
      state.library.push({
        name: f.name,
        size: f.size,
        kind: f.kind,
        addedAt: now,
        modifiedAt: f.modifiedAt ?? now
      });
    }
  }
  notify();
}

export function removeLocalFile(name: string): void {
  state.library = state.library.filter((f) => f.name !== name);
  delete state.records['local:' + name];
  for (const pl of state.playlists) {
    pl.items = pl.items.filter((k) => k !== 'local:' + name);
  }
  notify();
}

export function clearLibrary(): void {
  state.library = [];
  state.records = {};
  for (const pl of state.playlists) pl.items = pl.items.filter((k) => !k.startsWith('local:'));
  notify();
}

// ---- 媒体源 ----

export function addSource(src: Omit<Source, 'id'>): Source {
  const source: Source = { ...src, id: uid() };
  state.sources.push(source);
  notify();
  return source;
}

export function updateSource(id: string, patch: Partial<Source>): void {
  const src = state.sources.find((s) => s.id === id);
  if (src) Object.assign(src, patch);
  notify();
}

export function removeSource(id: string): void {
  state.sources = state.sources.filter((s) => s.id !== id);
  notify();
}

// ---- 播放列表 ----

export function createPlaylist(name: string): Playlist {
  const pl: Playlist = { id: uid(), name, items: [], createdAt: Date.now() };
  state.playlists.push(pl);
  notify();
  return pl;
}

export function addToPlaylist(plId: string, key: string): void {
  const pl = state.playlists.find((p) => p.id === plId);
  if (pl && !pl.items.includes(key)) {
    pl.items.push(key);
    notify();
  }
}

export function removeFromPlaylist(plId: string, key: string): void {
  const pl = state.playlists.find((p) => p.id === plId);
  if (pl) {
    pl.items = pl.items.filter((k) => k !== key);
    notify();
  }
}

export function removePlaylist(plId: string): void {
  state.playlists = state.playlists.filter((p) => p.id !== plId);
  notify();
}

// ---- 播放进度 ----

export function saveRecord(key: string, time: number, duration: number): void {
  if (!key || !isFinite(time) || time <= 0) return;
  const rec: PlaybackRecord = { time, duration: isFinite(duration) && duration > 0 ? duration : 0, updatedAt: Date.now() };
  state.records[key] = rec;
  notify();
}

export function clearRecord(key: string): void {
  delete state.records[key];
  notify();
}

// ---- 设置 ----

export function setSettings(patch: Partial<Settings>): void {
  Object.assign(state.settings, patch);
  if (patch.subtitleStyle) {
    state.settings.subtitleStyle = { ...state.settings.subtitleStyle, ...patch.subtitleStyle };
  }
  notify();
}
