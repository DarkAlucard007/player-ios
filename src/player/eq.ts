// 10 段均衡器：Web Audio 滤波链（MediaElementSource → 10×BiquadFilter → destination）

const BANDS = [
  { label: '31', freq: 31, type: 'lowshelf' },
  { label: '62', freq: 62, type: 'peaking' },
  { label: '125', freq: 125, type: 'peaking' },
  { label: '250', freq: 250, type: 'peaking' },
  { label: '500', freq: 500, type: 'peaking' },
  { label: '1k', freq: 1000, type: 'peaking' },
  { label: '2k', freq: 2000, type: 'peaking' },
  { label: '4k', freq: 4000, type: 'peaking' },
  { label: '8k', freq: 8000, type: 'peaking' },
  { label: '16k', freq: 16000, type: 'highshelf' }
] as const;

export const EQ_BAND_LABELS: string[] = BANDS.map((b) => b.label);

export class EQ {
  private ctx: AudioContext | null = null;
  private filters: BiquadFilterNode[] = [];
  private source: MediaElementAudioSourceNode | null = null;
  private video: HTMLVideoElement | null = null;
  private _enabled = false;
  gains: number[] = new Array(BANDS.length).fill(0); // dB

  get enabled(): boolean {
    return this._enabled;
  }

  /** 把视频音频接入 EQ 链。必须在用户手势中调用（iOS AudioContext 要求）。 */
  attach(video: HTMLVideoElement): boolean {
    if (this._enabled) return true;
    try {
      const AC: typeof AudioContext =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.source = this.ctx.createMediaElementSource(video);
      this.video = video;
      let node: AudioNode = this.source;
      this.filters = BANDS.map((b) => {
        const f = this.ctx!.createBiquadFilter();
        f.type = b.type as BiquadFilterType;
        f.frequency.value = b.freq;
        f.Q.value = b.type === 'peaking' ? 1.2 : 1;
        f.gain.value = this.gains[BANDS.indexOf(b)] ?? 0;
        node.connect(f);
        node = f;
        return f;
      });
      node.connect(this.ctx.destination);
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      this._enabled = true;
      return true;
    } catch {
      this._enabled = false;
      this.cleanup();
      return false;
    }
  }

  detach(): void {
    this.cleanup();
    this._enabled = false;
  }

  private cleanup(): void {
    try {
      this.source?.disconnect();
      for (const f of this.filters) f.disconnect();
      void this.ctx?.close();
    } catch {
      // 忽略
    }
    this.source = null;
    this.filters = [];
    this.ctx = null;
    this.video = null;
  }

  setGain(index: number, db: number): void {
    if (index < 0 || index >= BANDS.length) return;
    this.gains[index] = db;
    const f = this.filters[index];
    if (f) f.gain.value = db;
  }

  reset(): void {
    this.gains = new Array(BANDS.length).fill(0);
    this.filters.forEach((f, i) => (f.gain.value = 0));
  }
}
