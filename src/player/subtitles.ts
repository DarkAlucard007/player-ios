// 外挂字幕解析：SRT / ASS / SSA / SUB → 统一 Cue 时间轴

export interface Cue {
  start: number; // 秒
  end: number;
  text: string;
}

export function parseSubtitle(raw: string, ext: string): Cue[] {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  switch (ext.toLowerCase()) {
    case 'srt':
      return parseSRT(text);
    case 'ass':
    case 'ssa':
      return parseASS(text);
    case 'sub':
      return parseSUB(text);
    default:
      return parseSRT(text);
  }
}

/** 找 t 时刻生效的字幕（start <= t < end） */
export function cueAt(cues: Cue[], t: number): Cue | null {
  for (const c of cues) {
    if (c.start <= t && t < c.end) return c;
  }
  return null;
}

// ---- SRT ----

function parseSRT(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    if (lines.length < 2) continue;
    let ti = 0;
    if (!lines[0].includes('-->')) {
      if (lines[1].includes('-->')) ti = 1;
      else continue;
    }
    const m = lines[ti].match(
      /(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/
    );
    if (!m) continue;
    const start = ts(m[1], m[2], m[3], m[4]);
    const end = ts(m[5], m[6], m[7], m[8]);
    const body = lines
      .slice(ti + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (body && end > start) cues.push({ start, end, text: body });
  }
  return cues;
}

function ts(h: string, m: string, s: string, ms: string): number {
  const frac = ms.padEnd(3, '0').slice(0, 3);
  return (+h) * 3600 + (+m) * 60 + (+s) + (+frac) / 1000;
}

// ---- ASS / SSA ----

function parseASS(text: string): Cue[] {
  const cues: Cue[] = [];
  let inEvents = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (/^\[.*\]$/.test(line)) {
      inEvents = /^\[events\]$/i.test(line);
      continue;
    }
    if (!inEvents || !/^Dialogue:/i.test(line)) continue;
    const parts = line.slice(line.indexOf(':') + 1).split(',');
    if (parts.length < 10) continue;
    const start = assTime(parts[1]);
    const end = assTime(parts[2]);
    const body = parts
      .slice(9)
      .join(',')
      .replace(/\{[^}]*\}/g, '') // 去 ASS 标签
      .replace(/\\N/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\[[^\]]*\]/g, '') // 去 KARA 标记
      .trim();
    if (body && end > start) cues.push({ start, end, text: body });
  }
  return cues;
}

/** ASS 时间 h:mm:ss.cc（厘秒） */
function assTime(t: string): number {
  const m = t.trim().match(/(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,2})/);
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
}

// ---- SUB（MicroDVF 风格：时间戳行 + 文本行） ----

function parseSUB(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    if (lines.length < 2) continue;
    const m = lines[0].match(
      /(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*,\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/
    );
    if (!m) continue;
    const start = ts(m[1], m[2], m[3], m[4]);
    const end = ts(m[5], m[6], m[7], m[8]);
    const body = lines.slice(1).join('\n').trim();
    if (body && end > start) cues.push({ start, end, text: body });
  }
  return cues;
}
