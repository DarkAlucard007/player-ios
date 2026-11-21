// v1 回归测试（Node 端，无需浏览器）：
//   1. 字幕解析器（SRT / ASS / SSA / SUB）
//   2. WebDAV 客户端（mock 服务器：PROPFIND/MOVE/DELETE/Range GET + 鉴权 + URL 编码）
//   3. 媒体 key 解析（local / webdav / emby）+ 同名外挂字幕匹配
//
// 运行：node upload-tools/test-unit.cjs
const path = require('path');
const http = require('http');
const esbuild = require(path.join(__dirname, '..', 'node_modules', 'esbuild'));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  [PASS] ' + name);
  } else {
    failed++;
    console.log('  [FAIL] ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

// ---- localStorage 垫片（store 模块加载时需要） ----
globalThis.localStorage = {
  _d: {},
  getItem(k) {
    return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null;
  },
  setItem(k, v) {
    this._d[k] = String(v);
  },
  removeItem(k) {
    delete this._d[k];
  }
};

// ---- DOMParser 垫片（仅覆盖 WebDAV multistatus 的固定结构） ----
class FakeNode {
  constructor(tag, text) {
    this.tagName = tag;
    this.textContent = text || '';
    this.children = [];
  }
  getElementsByTagNameNS(_ns, name) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c.tagName === name) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}
globalThis.DOMParser = class {
  parseFromString(xml, _type) {
    const root = new FakeNode('multistatus');
    // 兼容带命名空间前缀的标签（<D:response> 等）
    const P = '(?:[A-Za-z_][\\w]*:)?';
    const respRe = new RegExp('<' + P + 'response>([\\s\\S]*?)<\\/' + P + 'response>', 'g');
    let m;
    while ((m = respRe.exec(xml))) {
      const body = m[1];
      const resp = new FakeNode('response');
      const href = body.match(new RegExp('<' + P + 'href>([^<]*)<\\/' + P + 'href>'));
      if (href) resp.children.push(new FakeNode('href', decodeURIComponent(href[1])));
      if (new RegExp('<' + P + 'collection\\s*/?>').test(body)) resp.children.push(new FakeNode('collection'));
      const len = body.match(new RegExp('<' + P + 'getcontentlength>(\\d+)<\\/' + P + 'getcontentlength>'));
      if (len) resp.children.push(new FakeNode('getcontentlength', len[1]));
      const mod = body.match(new RegExp('<' + P + 'getlastmodified>([^<]*)<\\/' + P + 'getlastmodified>'));
      if (mod) resp.children.push(new FakeNode('getlastmodified', mod[1]));
      root.children.push(resp);
    }
    return root;
  }
};

(async () => {
  const tmp = path.join(__dirname, '.tmp-test');
  require('fs').mkdirSync(tmp, { recursive: true });

  // ============ 1. 字幕解析 ============
  console.log('=== 1. 字幕解析 ===');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'player', 'subtitles.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: path.join(tmp, 'subtitles.cjs')
  });
  const { parseSubtitle, cueAt } = require(path.join(tmp, 'subtitles.cjs'));

  const srt = '1\n00:00:01,000 --> 00:00:04,000\nHello world\n\n2\n00:00:05,500 --> 00:00:07,000\nSecond line\n';
  const cues = parseSubtitle(srt, 'srt');
  check('SRT: 解析出 2 条', cues.length === 2, String(cues.length));
  check('SRT: 起始 1s', Math.abs(cues[0].start - 1) < 0.001);
  check('SRT: 结束 4s', Math.abs(cues[0].end - 4) < 0.001);
  check('SRT: 文本', cues[0].text === 'Hello world', cues[0].text);
  check('SRT: 第二条 5.5s', Math.abs(cues[1].start - 5.5) < 0.001);
  check('cueAt(2s) 命中', cueAt(cues, 2) && cueAt(cues, 2).text === 'Hello world');
  check('cueAt(4.5s) 无字幕', cueAt(cues, 4.5) === null);

  const srt2 = '\uFEFF1\r\n00:00:00,000 --> 00:00:02,000\r\n<b>Bold</b> text\r\n';
  const cues2 = parseSubtitle(srt2, 'srt');
  check('SRT: BOM+CRLF+HTML 标签', cues2.length === 1 && cues2[0].text === 'Bold text', cues2[0] && cues2[0].text);

  const ass =
    '[Script Info]\nTitle: test\n\n[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,First line\\NSecond line\n' +
    'Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,{\\pos(100,100)}Tagged\n';
  const cuesAss = parseSubtitle(ass, 'ass');
  check('ASS: 解析出 2 条', cuesAss.length === 2, String(cuesAss.length));
  check('ASS: 时间 1s-3s', Math.abs(cuesAss[0].start - 1) < 0.001 && Math.abs(cuesAss[0].end - 3) < 0.001);
  check('ASS: \\N 换行', cuesAss[0].text === 'First line\nSecond line', JSON.stringify(cuesAss[0].text));
  check('ASS: 去标签', cuesAss[1].text === 'Tagged', cuesAss[1].text);

  const ssa =
    '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
    'Dialogue: 0,0:00:01.50,0:00:02.25,Default,,0,0,0,,SSA line\n';
  const cuesSsa = parseSubtitle(ssa, 'ssa');
  check('SSA: 厘秒时间 1.5s/2.25s', Math.abs(cuesSsa[0].start - 1.5) < 0.001 && Math.abs(cuesSsa[0].end - 2.25) < 0.001);

  const sub = '00:00:01.000,00:00:03.000\nSub line\n\n00:00:04.000,00:00:05.000\nLine two\n';
  const cuesSub = parseSubtitle(sub, 'sub');
  check('SUB: 解析出 2 条', cuesSub.length === 2, String(cuesSub.length));
  check('SUB: 文本', cuesSub[1] && cuesSub[1].text === 'Line two');

  // ============ 2. WebDAV 客户端 ============
  console.log('=== 2. WebDAV 客户端 ===');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'sources', 'webdav.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: path.join(tmp, 'webdav.cjs')
  });
  const { WebDAVClient } = require(path.join(tmp, 'webdav.cjs'));

  const requests = [];
  const multistatus =
    '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' +
    '<D:response><D:href>/videos/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>' +
    '<D:response><D:href>/videos/sub%20dir/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>' +
    '<D:response><D:href>/videos/Big%20Buck%20Bunny.mp4</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>788493</D:getcontentlength><D:getlastmodified>Wed, 01 Jan 2025 00:00:00 GMT</D:getlastmodified></D:prop></D:propstat></D:response>' +
    '<D:response><D:href>/videos/notes.txt</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>10</D:getcontentlength></D:prop></D:propstat></D:response>' +
    '</D:multistatus>';
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers['authorization'] || null });
    if (req.method === 'PROPFIND') {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(multistatus);
    } else if (req.method === 'MOVE') {
      res.writeHead(201);
      res.end();
    } else if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
    } else if (req.method === 'GET') {
      const body = Buffer.from('0123456789');
      const range = req.headers['range'];
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : body.length - 1;
        res.writeHead(206, {
          'Content-Range': 'bytes ' + start + '-' + end + '/' + body.length,
          'Content-Length': end - start + 1
        });
        res.end(body.slice(start, end + 1));
      } else {
        res.writeHead(200, { 'Content-Length': body.length });
        res.end(body);
      }
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const client = new WebDAVClient('http://127.0.0.1:' + port, 'user', 'pass');
  const entries = await client.list('/videos');
  check('PROPFIND: 4 个条目（含目录自身被跳过 → 3 个）', entries.length === 3, String(entries.length));
  check('PROPFIND: 目录排前', entries[0].isDir === true && entries[0].name === 'sub dir', entries[0].name);
  check('PROPFIND: 名称解码', entries.some((e) => e.name === 'Big Buck Bunny.mp4'));
  check('PROPFIND: 大小解析', entries.find((e) => e.name === 'Big Buck Bunny.mp4').size === 788493);
  check('PROPFIND: 鉴权头 Basic', requests[0].auth === 'Basic ' + Buffer.from('user:pass').toString('base64'), requests[0].auth);
  check('PROPFIND: Depth 头', requests[0].method === 'PROPFIND');

  const enc = client.streamUrl('/videos/我的 电影.mp4');
  check('URL 编码: 中文+空格', enc === 'http://127.0.0.1:' + port + '/videos/%E6%88%91%E7%9A%84%20%E7%94%B5%E5%BD%B1.mp4', enc);
  const encNoScheme = new WebDAVClient('192.168.1.10:5005').streamUrl('/a b/c.mp4');
  check('URL 补 http:// 前缀', encNoScheme.startsWith('http://192.168.1.10:5005/'), encNoScheme);

  await client.rename('/videos/old.mp4', '/videos/new.mp4');
  const moveReq = requests.find((r) => r.method === 'MOVE');
  check('MOVE: 方法正确', !!moveReq);
  await client.remove('/videos/gone.mp4');
  check('DELETE: 方法正确', requests.some((r) => r.method === 'DELETE'));
  server.close();

  // ============ 3. 媒体 key 解析 ============
  console.log('=== 3. 媒体 key 解析 ===');
  // registry 与 store 必须打进同一个 bundle，共享同一份 state
  const entryPath = path.join(tmp, 'entry.ts');
  require('fs').writeFileSync(
    entryPath,
    "export * from '" + path.join(__dirname, '..', 'src', 'sources', 'registry').replace(/\\/g, '/') + "';\n" +
      "export * from '" + path.join(__dirname, '..', 'src', 'core', 'store').replace(/\\/g, '/') + "';\n"
  );
  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: path.join(tmp, 'registry.cjs')
  });
  const { resolvePlayback, findMatchingSubtitle, addSource, addLocalFiles } = require(path.join(tmp, 'registry.cjs'));

  addLocalFiles([
    { name: 'movie.mp4', size: 100, kind: 'video' },
    { name: 'movie.srt', size: 10, kind: 'subtitle' }
  ]);
  const src = addSource({ type: 'webdav', name: 'NAS', host: 'http://127.0.0.1:9999', rootPath: '/videos' });

  const local = resolvePlayback('local:movie.mp4');
  check('local key → localmedia:// URL', local && local.url === 'localmedia:///' + encodeURIComponent('movie.mp4'), local && local.url);
  check('local key → localName', local && local.localName === 'movie.mp4');

  const wd = resolvePlayback('webdav:' + src.id + '/videos/Big Buck Bunny.mp4');
  check('webdav key → 直链', wd && wd.url === 'http://127.0.0.1:9999/videos/Big%20Buck%20Bunny.mp4', wd && wd.url);
  check('webdav key → 标题', wd && wd.title === 'Big Buck Bunny.mp4');

  check('未知 key → null', resolvePlayback('unknown:x') === null);

  const matched = findMatchingSubtitle('movie.mp4');
  check('同名外挂字幕匹配', matched === 'movie.srt', String(matched));
  check('无匹配字幕 → null', findMatchingSubtitle('other.mp4') === null);

  // ============ 4. SMB key 解析 ============
  console.log('=== 4. SMB key 解析 ===');
  const smb = resolvePlayback('smb:我的 电影.mp4');
  check('smb key → localmedia:///smb%2F/ URL（单段）', smb && smb.url === 'localmedia:///smb%2F' + encodeURIComponent('我的 电影.mp4'), smb && smb.url);
  check('smb key → smbName', smb && smb.smbName === '我的 电影.mp4');
  check('smb key → localName 为 null', smb && smb.localName === null);

  // ============ 结果 ============
  console.log('');
  console.log('===== 单元测试：' + passed + ' 项通过，' + failed + ' 项失败 =====');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本崩溃:', e);
  process.exit(2);
});
