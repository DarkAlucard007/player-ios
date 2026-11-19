// Emby / Jellyfin 媒体服务器客户端（统一封装，纯 HTTP API）

import type { MediaItem, Source } from '../core/types';

interface ServerItem {
  Name: string;
  Id: string;
  Type: string;
  ProductionYear?: number;
  Overview?: string;
  Genres?: string[];
  RuntimeTicks?: number;
  PrimaryImageTag?: string;
  Path?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  SortName?: string;
}

export class MediaServerClient {
  constructor(
    private host: string,
    private apiKey: string,
    private prefix: string, // 'emby' 或 ''（Jellyfin 用根路径）
    private sourceId: string = 'srv'
  ) {}

  private base(): string {
    let h = this.host.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
    return h;
  }

  private p(): string {
    return this.prefix ? '/' + this.prefix : '';
  }

  private qs(extra: Record<string, string> = {}): string {
    const params: Record<string, string> = { api_key: this.apiKey, ...extra };
    return Object.entries(params)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
  }

  /** 连通性测试 */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(this.base() + this.p() + '/System/Info?' + this.qs());
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 列出视频（可带搜索词）。Emby: /emby/Items；Jellyfin: /Items */
  async listVideos(searchTerm?: string): Promise<MediaItem[]> {
    const extra: Record<string, string> = {
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Episode,Video',
      Limit: '300',
      Fields: 'Overview,Genres,ProductionYear,RuntimeTicks,ParentIndexNumber',
      EnableImageTypes: 'Primary,Backdrop',
      EnableTotalRecordCount: 'false'
    };
    if (searchTerm) extra['SearchTerm'] = searchTerm;
    const res = await fetch(this.base() + this.p() + '/Items?' + this.qs(extra));
    if (!res.ok) throw new Error('Items ' + res.status);
    const data = (await res.json()) as { Items?: ServerItem[] };
    return (data.Items || []).map((it) => this.toItem(it));
  }

  private toItem(it: ServerItem): MediaItem {
    const season = it.ParentIndexNumber && it.ParentIndexNumber > 0 ? it.ParentIndexNumber : undefined;
    const episode = it.IndexNumber && it.IndexNumber > 0 ? it.IndexNumber : undefined;
    return {
      key: 'emby:' + this.sourceId + '/' + it.Id,
      title: it.Name,
      url: this.streamUrl(it.Id),
      year: it.ProductionYear,
      overview: it.Overview,
      genres: it.Genres,
      imageTag: it.PrimaryImageTag,
      duration: it.RuntimeTicks ? it.RuntimeTicks / 10_000_000 : undefined,
      season,
      episode,
      sourceType: this.prefix === 'emby' ? 'emby' : 'jellyfin'
    };
  }

  /** 直接流地址（Static=true 不转码） */
  streamUrl(id: string): string {
    return this.base() + this.p() + `/Videos/${id}/stream.mp4?${this.qs({ Static: 'true' })}`;
  }

  /** 海报图地址 */
  imageUrl(id: string, tag: string): string {
    return this.base() + this.p() + `/Items/${id}/Images/Primary?${this.qs({ tag })}`;
  }
}

export function makeClient(source: Source): MediaServerClient {
  return new MediaServerClient(
    source.host,
    source.apiKey || '',
    source.type === 'emby' ? 'emby' : '',
    source.id
  );
}
