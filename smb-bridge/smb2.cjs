// smb2.cjs — SMB2/3 客户端（Node.js，供 bridge.cjs 使用）
// 实现：MD4(纯 JS) + NTLMv2 认证 + SMB2 分帧 + 协商/会话/树连接/创建/列目录/读 + SMB3 签名
// 所有缓冲区偏移均相对“SMB2 消息起点”（64 字节头之前），符合 MS-SMB2 规范。
'use strict';
const crypto = require('crypto');

// ---------- MD4（Node crypto 无 MD4，纯 JS 实现） ----------
function md4(input) {
  const msg = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const bitLen = msg.length * 8;
  let padLen = (56 - (msg.length + 1) % 64 + 64) % 64;
  const total = msg.length + 1 + padLen + 8;
  const buf = Buffer.alloc(total);
  msg.copy(buf, 0);
  buf[msg.length] = 0x80;
  buf.writeUInt32LE(bitLen >>> 0, total - 8);
  buf.writeUInt32LE(Math.floor(bitLen / 0x100000000) >>> 0, total - 4);

  let A = 0x67452301, B = 0xefcdab89, C = 0x98badcfe, D = 0x10325476;
  const X = new Array(16);
  const rotl = (x, s) => { x = x >>> 0; return ((x << s) | (x >>> (32 - s))) >>> 0; };
  const F = (x, y, z) => (x & y) | (~x & z);
  const G = (x, y, z) => (x & y) | (x & z) | (y & z);
  const H = (x, y, z) => x ^ y ^ z;

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) X[i] = buf.readUInt32LE(off + i * 4);
    let a = A, b = B, c = C, d = D;
    const r1s = [3, 7, 11, 19];
    for (let i = 0; i < 16; i++) { a = rotl(a + F(b, c, d) + X[i], r1s[i % 4]); [a, b, c, d] = [d, a, b, c]; }
    const r2o = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
    const r2s = [3, 5, 9, 13];
    for (let i = 0; i < 16; i++) { a = rotl(a + G(b, c, d) + X[r2o[i]] + 0x5a827999, r2s[i % 4]); [a, b, c, d] = [d, a, b, c]; }
    const r3o = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    const r3s = [3, 9, 11, 15];
    for (let i = 0; i < 16; i++) { a = rotl(a + H(b, c, d) + X[r3o[i]] + 0x6d9d6122, r3s[i % 4]); [a, b, c, d] = [d, a, b, c]; }
    A = (A + a) >>> 0; B = (B + b) >>> 0; C = (C + c) >>> 0; D = (D + d) >>> 0;
  }
  const out = Buffer.alloc(16);
  out.writeUInt32LE(A, 0); out.writeUInt32LE(B, 4); out.writeUInt32LE(C, 8); out.writeUInt32LE(D, 12);
  return out;
}

// ---------- 常量 ----------
const CMD = {
  NEGOTIATE: 0x0000, SESSION_SETUP: 0x0001, TREE_CONNECT: 0x0002, TREE_DISCONNECT: 0x0003,
  CLOSE: 0x0004, CREATE: 0x0005, CANCEL: 0x0006, READ: 0x0007, WRITE: 0x0008,
  FLUSH: 0x0009, QUERY_DIRECTORY: 0x000a, QUERY_INFO: 0x000b, SET_INFO: 0x000c, OPLOCK_BREAK: 0x000d
};
const ST_OK = 0x00000000;
const ST_MORE = 0xc0000016;        // STATUS_MORE_PROCESSING_REQUIRED
const ST_NO_MORE = 0x80000006;     // STATUS_NO_MORE_FILES
const ST_ACCESS_DENIED = 0xc0000022;
const ST_NOT_FOUND = 0xc0000135;   // STATUS_OBJECT_NAME_NOT_FOUND
const ST_NOT_FOUND_SHARE = 0xc0000035; // STATUS_BAD_NETWORK_NAME
const FLAG_SIGNED = 0x00000008;
const DIA = { SMB210: 0x0210, SMB300: 0x0300, SMB302: 0x0302, SMB311: 0x0311 };

function utf16le(str) {
  const b = Buffer.alloc(str.length * 2);
  for (let i = 0; i < str.length; i++) b.writeUInt16LE(str.charCodeAt(i), i * 2);
  return b;
}
function statusText(st) {
  return { [ST_OK]: 'OK', [ST_MORE]: 'MORE', [ST_NO_MORE]: 'NO_MORE_FILES', [ST_ACCESS_DENIED]: 'ACCESS_DENIED', [ST_NOT_FOUND]: 'NAME_NOT_FOUND', [ST_NOT_FOUND_SHARE]: 'BAD_NETWORK_NAME' }[st] || ('0x' + st.toString(16));
}

// ---------- SMB2 连接 ----------
class Smb2Connection {
  constructor(socket, { user, pass, share, onLog } = {}) {
    this.socket = socket;
    this.user = user || '';
    this.pass = pass || '';
    this.share = share || '';
    this.log = onLog || (() => {});
    this.buf = Buffer.alloc(0);
    this.nextMsgId = 1;
    this.pending = new Map();
    this.sessionId = Buffer.alloc(8);
    this.treeId = 0;
    this.dialect = 0;
    this.serverSigning = false;
    this.signingKey = null;
    this.signNonce = 0;
    this.fileHandles = new Map();
    this.nextLocalId = 1;
    this.preauth = Buffer.alloc(16); // 预认证哈希（16 零起步）
    this.negotiateReq = null;
    this.negotiateResp = null;
    this.sessionKey = null;
    socket.on('data', (d) => this._onData(d));
    socket.on('error', (e) => { this.log('socket error: ' + e.message); this._rejectAll(e); });
    socket.on('close', () => { this.log('socket closed'); this._rejectAll(new Error('SMB 连接已断开')); });
  }

  _rejectAll(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (true) {
      if (this.buf.length < 64) return;
      const size = this._messageSize(this.buf);
      if (size <= 0 || this.buf.length < size) return;
      const msg = this.buf.subarray(0, size);
      this.buf = this.buf.subarray(size);
      this._dispatch(msg);
    }
  }

  // 计算一条完整 SMB2 消息的总字节数；不足返回 -1
  _messageSize(buf) {
    const cmd = buf.readUInt16LE(4);
    const b = 64;
    switch (cmd) {
      case CMD.NEGOTIATE: {
        if (buf.length < b + 65) return -1;
        const secOff = buf.readUInt16LE(b + 57);
        const secLen = buf.readUInt16LE(b + 59);
        const ctxOff = buf.readUInt16LE(b + 53);
        const ctxCount = buf.readUInt16LE(b + 55);
        let end = secOff + secLen;
        if (ctxCount > 0 && ctxOff > 0) {
          let off = ctxOff;
          for (let i = 0; i < ctxCount; i++) {
            if (buf.length < off + 8) return -1;
            const dataLen = buf.readUInt32LE(off);
            off += 8 + dataLen;
            off = (off + 7) & ~7;
          }
          end = Math.max(end, off);
        }
        return buf.length >= end ? end : -1;
      }
      case CMD.SESSION_SETUP: {
        if (buf.length < b + 9) return -1;
        const secOff = buf.readUInt16LE(b + 5);
        const secLen = buf.readUInt16LE(b + 7);
        const end = (secOff > 0 && secLen > 0) ? (secOff + secLen) : (b + 9);
        return buf.length >= end ? end : -1;
      }
      case CMD.TREE_CONNECT:
        return b + 10; // StructureSize=10
      case CMD.CREATE: {
        if (buf.length < b + 89) return -1;
        const ctxOff = buf.readUInt16LE(b + 83);
        const ctxLen = buf.readUInt16LE(b + 85);
        const end = (ctxOff > 0 && ctxLen > 0) ? (ctxOff + ctxLen) : (b + 89);
        return buf.length >= end ? end : -1;
      }
      case CMD.QUERY_DIRECTORY: {
        if (buf.length < b + 9) return -1;
        const outOff = buf.readUInt16LE(b + 5);
        const outLen = buf.readUInt32LE(b + 7);
        const end = (outOff > 0 && outLen > 0) ? (outOff + outLen) : (b + 9);
        return buf.length >= end ? end : -1;
      }
      case CMD.READ: {
        if (buf.length < b + 43) return -1;
        const dataOff = buf.readUInt16LE(b + 33);
        const dataLen = buf.readUInt32LE(b + 35);
        const end = (dataOff > 0 && dataLen > 0) ? (dataOff + dataLen) : (b + 43);
        return buf.length >= end ? end : -1;
      }
      case CMD.CLOSE:
        return b + 24;
      case CMD.TREE_DISCONNECT:
        return b + 4;
      default:
        return -1;
    }
  }

  _dispatch(msg) {
    const id = msg.readBigUInt64LE(24).toString();
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.resolve(msg);
  }

  // 发送请求并等待响应。offsets 均相对消息起点。
  _request(cmd, body, { sign = true } = {}) {
    const msgId = this.nextMsgId++;
    const header = Buffer.alloc(64);
    header.writeUInt32LE(0xfe534d42, 0);
    header.writeUInt16LE(64, 4);
    header.writeUInt16LE(1, 6);
    header.writeUInt16LE(cmd, 12);
    header.writeUInt16LE(1, 14);
    let flags = 0;
    if (sign && this.serverSigning && this.dialect >= DIA.SMB300 && this.signingKey) flags |= FLAG_SIGNED;
    header.writeUInt32LE(flags, 16);
    header.writeBigUInt64LE(BigInt(msgId), 24);
    header.writeUInt32LE(this.treeId, 36);
    this.sessionId.copy(header, 40);
    let full = Buffer.concat([header, body]);
    if (flags & FLAG_SIGNED) full = this._sign(full);
    return new Promise((resolve, reject) => {
      this.pending.set(String(msgId), { resolve, reject });
      this.socket.write(full);
    });
  }

  // SMB3 签名：3.1.1 用 AES-GMAC，3.0/3.0.2/2.1 用 AES-CMAC
  _sign(msg) {
    const nonce = Buffer.alloc(8);
    nonce.writeBigUInt64LE(BigInt(this.signNonce++), 0);
    let sig;
    if (this.dialect >= DIA.SMB311) {
      const c = crypto.createCipheriv('aes-128-gcm', this.signingKey, nonce, { authTagLength: 16 });
      c.setAAD(Buffer.alloc(0));
      c.update(Buffer.alloc(0));
      c.final();
      sig = c.getAuthTag();
    } else {
      const toSign = Buffer.concat([nonce, msg.subarray(0, 48), msg.subarray(64)]);
      sig = this._aesCmac(this.signingKey, toSign);
    }
    msg = Buffer.from(msg);
    sig.copy(msg, 48);
    return msg;
  }

  _aesCmac(key, data) {
    const block = 16;
    const dbl = (k) => {
      const out = Buffer.alloc(block);
      let overflow = 0;
      for (let i = 0; i < block; i++) {
        const v = k[i];
        out[i] = ((v << 1) | overflow) & 0xff;
        overflow = (v & 0x80) ? 1 : 0;
      }
      if (overflow) out[block - 1] ^= 0x87;
      return out;
    };
    const enc = (k, blk) => {
      const c = crypto.createCipheriv('aes-128-ecb', k, null);
      c.setAutoPadding(false);
      return Buffer.concat([c.update(blk), c.final()]);
    };
    const K1 = dbl(key), K2 = dbl(K1);
    const n = Math.max(1, Math.ceil(data.length / block));
    let x = Buffer.alloc(block);
    for (let i = 0; i < n - 1; i++) {
      const blk = data.subarray(i * block, (i + 1) * block);
      for (let j = 0; j < block; j++) x[j] ^= blk[j];
      x = enc(key, x);
    }
    const last = data.subarray((n - 1) * block);
    let lastBlk;
    if (last.length === block) { lastBlk = last; }
    else { lastBlk = Buffer.alloc(block); last.copy(lastBlk, 0); lastBlk[last.length] = 0x80; }
    const lastKey = (last.length === block) ? K1 : K2;
    for (let j = 0; j < block; j++) x[j] ^= lastBlk[j];
    // 注意：最后一块需先异或 lastKey 再异或数据？CMAC 规范：X_n = M_n ⊕ K_n，然后 E(K, X_n)
    // 上面已把 lastBlk 异或进 x，但还需异或 lastKey。修正：
    for (let j = 0; j < block; j++) x[j] ^= lastKey[j];
    x = enc(key, x);
    return x;
  }

  // ---------- 高层操作 ----------
  async connect() {
    await this._negotiate();
    await this._sessionSetup();
    await this._treeConnect();
    return true;
  }

  async _negotiate() {
    const dialects = [DIA.SMB311, DIA.SMB302, DIA.SMB300, DIA.SMB210];
    const body = Buffer.alloc(36 + dialects.length * 2);
    body.writeUInt16LE(36, 0);
    body.writeUInt16LE(dialects.length, 2);
    body.writeUInt16LE(0x0001, 4); // SecurityMode = SIGNING_ENABLED
    body.writeUInt32LE(0, 8);
    body.writeUInt32LE(0, 12); // Capabilities
    crypto.randomBytes(16).copy(body, 16); // ClientGuid
    for (let i = 0; i < dialects.length; i++) body.writeUInt16LE(dialects[i], 36 + i * 2);
    this.negotiateReq = Buffer.concat([this._header(CMD.NEGOTIATE, 0), body]);
    const resp = await this._request(CMD.NEGOTIATE, body, { sign: false });
    this.negotiateResp = resp;
    const status = resp.readUInt32LE(8);
    if (status !== ST_OK) throw new Error('NEGOTIATE 失败: ' + statusText(status));
    this.dialect = resp.readUInt16LE(66);
    const secMode = resp.readUInt16LE(68);
    this.serverSigning = !!(secMode & 0x0001) || !!(secMode & 0x0002);
    // 累积预认证哈希：H = SHA512(H_prev || req || resp)，取前 16 字节
    this.preauth = crypto.createHash('sha512').update(Buffer.concat([this.preauth, this.negotiateReq, resp])).digest().subarray(0, 16);
    // 派生签名密钥
    this.signingKey = this._kdf(this.preauth, this.dialect);
    this.log('协商 dialect=0x' + this.dialect.toString(16) + ' serverSigning=' + this.serverSigning);
  }

  _header(cmd, flags) {
    const h = Buffer.alloc(64);
    h.writeUInt32LE(0xfe534d42, 0);
    h.writeUInt16LE(64, 4);
    h.writeUInt16LE(1, 6);
    h.writeUInt16LE(cmd, 12);
    h.writeUInt16LE(1, 14);
    h.writeUInt32LE(flags, 16);
    return h;
  }

  _kdf(secret, dialect) {
    const iv = Buffer.alloc(16);
    let seed;
    if (dialect >= DIA.SMB311) {
      seed = Buffer.from([0x53, 0x4d, 0x42, 0x20, 0x33, 0x2e, 0x31, 0x2e, 0x31, 0x00, 0, 0, 0, 0, 0, 0]); // "SMB 3.1.1\0"
    } else {
      seed = Buffer.alloc(16); seed[0] = 0x52; // 'R'
    }
    const enc = (data) => {
      const c = crypto.createCipheriv('aes-128-cbc', secret, iv);
      return Buffer.concat([c.update(data), c.final()]);
    };
    let k = enc(seed);
    k = enc(k);
    return k.subarray(0, 16);
  }

  async _sessionSetup() {
    // 第一步：空安全缓冲区 → 获取 NTLM challenge
    let body = Buffer.alloc(25);
    body.writeUInt16LE(25, 0);
    body.writeUInt16LE(0x0001, 2); // SessionFlags = BINDING
    body.writeUInt16LE(0, 4); // SecurityBufferOffset = 0
    body.writeUInt16LE(0, 6); // SecurityBufferLength = 0
    body.writeUInt32LE(0, 8); // Capabilities
    let resp = await this._request(CMD.SESSION_SETUP, body, { sign: true });
    let status = resp.readUInt32LE(8);
    if (status !== ST_MORE) throw new Error('SESSION_SETUP(1) ' + statusText(status));
    const secOff = resp.readUInt16LE(64 + 5);
    const secLen = resp.readUInt16LE(64 + 7);
    const secBuf = resp.subarray(secOff, secOff + secLen);
    const challenge = this._parseNtlmChallenge(secBuf);
    const { lm, nt } = this._ntlmv2(challenge);
    // 第二步：发送 Authenticate
    const ntlm = this._buildNtlmAuth(lm, nt, '', this.user, '');
    const header2 = Buffer.alloc(25);
    header2.writeUInt16LE(25, 0);
    header2.writeUInt16LE(0x0001, 2);
    header2.writeUInt16LE(64 + 25, 4); // SecurityBufferOffset（消息相对）
    header2.writeUInt16LE(ntlm.length, 6);
    header2.writeUInt32LE(0, 8);
    body = Buffer.concat([header2, ntlm]);
    resp = await this._request(CMD.SESSION_SETUP, body, { sign: true });
    status = resp.readUInt32LE(8);
    if (status !== ST_OK) throw new Error('SESSION_SETUP(2) 认证失败: ' + statusText(status) + (status === 0xc000006d ? '（用户名或密码错误）' : ''));
    this.sessionId = Buffer.from(resp.subarray(40, 48));
    // 会话密钥在安全缓冲区
    const secOff3 = resp.readUInt16LE(64 + 5);
    const secLen3 = resp.readUInt16LE(64 + 7);
    if (secLen3 >= 16) {
      this.sessionKey = Buffer.from(resp.subarray(secOff3, secOff3 + 16));
      this.signingKey = this._kdf(this.sessionKey, this.dialect);
    }
    this.log('会话建立 dialect=0x' + this.dialect.toString(16));
  }

  _parseNtlmChallenge(secBuf) {
    if (secBuf.length < 28 || secBuf.toString('latin1', 0, 8) !== 'NTLMSSP\0') {
      throw new Error('非 NTLM 挑战（可能是 Kerberos），暂不支持');
    }
    const targetInfoLen = secBuf.readUInt16LE(22);
    const targetInfoOff = secBuf.readUInt16LE(24);
    const challenge = Buffer.from(secBuf.subarray(12, 20));
    return { challenge, targetInfo: secBuf.subarray(targetInfoOff, targetInfoOff + targetInfoLen) };
  }

  _ntlmv2(challengeInfo) {
    const challenge = challengeInfo.challenge;
    const ntowf = md4(utf16le(this.pass));
    const temp = crypto.createHash('md5').update(Buffer.concat([ntowf, utf16le(this.user)])).digest();
    const clientChallenge = crypto.randomBytes(8);
    const timestamp = Buffer.alloc(8);
    const ft = (Date.now() + 11644473600000) * 10000;
    timestamp.writeUInt32LE(ft >>> 0, 0);
    timestamp.writeUInt32LE(Math.floor(ft / 0x100000000) >>> 0, 4);
    const blob = Buffer.concat([
      Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]), timestamp, clientChallenge,
      Buffer.alloc(4), challengeInfo.targetInfo, Buffer.alloc(4), temp, Buffer.alloc(4)
    ]);
    const ntProof = crypto.createHmac('md5', ntowf).update(Buffer.concat([challenge, temp])).digest();
    const nt = Buffer.concat([ntProof, blob]);
    const lm = Buffer.concat([crypto.createHmac('md5', ntowf).update(Buffer.concat([challenge, clientChallenge])).digest(), clientChallenge]);
    return { lm, nt };
  }

  _buildNtlmAuth(lm, nt, domain, user, workstation) {
    const sig = Buffer.from('NTLMSSP\0', 'latin1');
    const type = Buffer.alloc(4); type.writeUInt32LE(3, 0);
    const descs = [lm, nt, utf16le(domain), utf16le(user), utf16le(workstation), Buffer.alloc(0)];
    const descBufs = descs.map((d) => { const o = Buffer.alloc(8); o.writeUInt16LE(d.length, 4); o.writeUInt16LE(d.length, 6); return o; });
    const dataStart = 64;
    let off = dataStart;
    descs.forEach((d, i) => { descBufs[i].writeUInt16LE(off, 0); off += d.length; });
    const flags = Buffer.alloc(4); flags.writeUInt32LE(0x00000001 | 0x00000002 | 0x00000200 | 0x00008000, 0);
    return Buffer.concat([sig, type, ...descBufs, flags, ...descs]);
  }

  async _treeConnect() {
    const pathBuf = utf16le('\\\\?\\' + this.share);
    const head = Buffer.alloc(10);
    head.writeUInt16LE(10, 0);
    head.writeUInt16LE(0x0001, 2); // Flags = 0（无加密请求）
    head.writeUInt16LE(64 + 10, 4); // PathOffset（消息相对）
    head.writeUInt16LE(pathBuf.length, 6);
    const full = Buffer.concat([head, pathBuf]);
    const resp = await this._request(CMD.TREE_CONNECT, full, { sign: true });
    const status = resp.readUInt32LE(8);
    if (status !== ST_OK) throw new Error('TREE_CONNECT 失败: ' + statusText(status) + (status === ST_NOT_FOUND_SHARE ? '（共享不存在或无权限）' : ''));
    this.treeId = resp.readUInt32LE(36);
    this.log('树连接 share=' + this.share + ' treeId=' + this.treeId);
  }

  // 打开目录或文件，返回 { localId, size }
  async _create(path, isDir) {
    const name = utf16le(path);
    const c = Buffer.alloc(57);
    c.writeUInt16LE(57, 0);
    c.writeUInt16LE(0x0001, 2); // SecurityFlags = EFFECTIVE_MAXIMUM
    c.writeUInt32LE(0, 4); // RequestedOplockLevel = NONE
    c.writeUInt32LE(2, 8); // ImpersonationLevel = IMPERSONATE
    c.writeBigUInt64LE(0n, 12); // Flags
    c.writeBigUInt64LE(0x0000000700000007n, 20); // ShareAccess = READ|WRITE|DELETE
    c.writeUInt32LE(isDir ? 0x00010001 : 0x00010000, 28); // DesiredAccess = FILE_READ_DATA(|FILE_LIST_DIRECTORY)
    c.writeBigUInt64LE(0n, 36); // AllocationSize
    c.writeUInt32LE(0, 44); // FileAttributes
    c.writeUInt16LE(0, 48); // CreateContextsOffset
    c.writeUInt16LE(0, 50); // CreateContextsLength
    c.writeUInt16LE(64 + 57, 52); // PathOffset（消息相对）
    c.writeUInt16LE(name.length, 54); // PathLength
    const full = Buffer.concat([c, name]);
    const resp = await this._request(CMD.CREATE, full, { sign: true });
    const status = resp.readUInt32LE(8);
    if (status !== ST_OK) throw new Error('CREATE 失败: ' + statusText(status) + ' path=' + path);
    const fileId = Buffer.from(resp.subarray(64 + 8, 64 + 24));
    const localId = this.nextLocalId++;
    this.fileHandles.set(localId, fileId);
    const size = Number(resp.readBigUInt64LE(64 + 48)); // EndingOffset
    return { localId, fileId, size, isDir };
  }

  async list(path) {
    const dir = await this._create(path || '\\', true);
    const entries = [];
    let index = 0;
    while (true) {
      const body = this._queryDirBody(dir.localId, index);
      const resp = await this._request(CMD.QUERY_DIRECTORY, body, { sign: true });
      const status = resp.readUInt32LE(8);
      if (status === ST_NO_MORE) break;
      if (status !== ST_OK) throw new Error('QUERY_DIRECTORY 失败: ' + statusText(status));
      const outOff = resp.readUInt16LE(64 + 5);
      const outLen = resp.readUInt32LE(64 + 7);
      const out = resp.subarray(outOff, outOff + outLen);
      let p = 0;
      while (p + 48 <= out.length) {
        const nextOff = out.readUInt32LE(p);
        const fileNameLen = out.readUInt16LE(p + 40);
        if (fileNameLen === 0) break;
        const name = out.toString('utf16le', p + 48, p + 48 + fileNameLen);
        const size = Number(out.readBigUInt64LE(p + 24));
        const isDir = !!(out.readUInt32LE(p + 44) & 0x10);
        entries.push({ name, isDir, size });
        if (nextOff === 0) break;
        p = nextOff;
      }
      const total = resp.readUInt32LE(64 + 13);
      if (entries.length >= total) break;
      index++;
      if (outLen === 0) break;
    }
    await this._closeHandle(dir.localId);
    return entries;
  }

  _queryDirBody(localId, index) {
    const fileId = this.fileHandles.get(localId);
    // QueryDirectory body: StructureSize(2)=9, FileInformationClass(1), OutputBufferOffset(2), Flags(4), FileIndex(4), FileId(16), FileName
    const head = Buffer.alloc(9);
    head.writeUInt16LE(9, 0);
    head.writeUInt8(1, 2); // FileDirectoryInformation
    head.writeUInt16LE(0, 3); // OutputBufferOffset = 0
    head.writeUInt32LE(0, 5); // Flags
    const idx = Buffer.alloc(4); idx.writeUInt32LE(index, 0);
    return Buffer.concat([head, idx, fileId, Buffer.alloc(2)]);
  }

  async openFile(path) {
    return this._create(path, false);
  }

  async read(localId, offset, length) {
    const fileId = this.fileHandles.get(localId);
    if (!fileId) throw new Error('无效句柄');
    const b = Buffer.alloc(49);
    b.writeUInt16LE(49, 0);
    b.writeUInt16LE(0, 2);
    b.writeUInt32LE(0, 4);
    b.writeBigUInt64LE(BigInt(offset), 8);
    b.writeBigUInt64LE(BigInt(length), 16);
    b.writeBigUInt64LE(0n, 24);
    b.writeUInt32LE(0, 32);
    b.writeUInt32LE(0, 36);
    b.writeBigUInt64LE(0n, 40);
    const resp = await this._request(CMD.READ, b, { sign: true });
    const status = resp.readUInt32LE(8);
    if (status !== ST_OK) throw new Error('READ 失败: ' + statusText(status));
    const dataOff = resp.readUInt16LE(64 + 33);
    const dataLen = resp.readUInt32LE(64 + 35);
    return Buffer.from(resp.subarray(dataOff, dataOff + dataLen));
  }

  async _closeHandle(localId) {
    const fileId = this.fileHandles.get(localId);
    if (!fileId) return;
    this.fileHandles.delete(localId);
    const b = Buffer.alloc(24);
    b.writeUInt16LE(24, 0);
    b.writeUInt16LE(0, 2);
    b.writeUInt32LE(0, 4);
    fileId.copy(b, 8);
    try { await this._request(CMD.CLOSE, b, { sign: true }); } catch { /* 忽略 */ }
  }

  async close() {
    for (const id of [...this.fileHandles.keys()]) await this._closeHandle(id);
    try {
      const b = Buffer.alloc(4); b.writeUInt16LE(4, 0);
      await this._request(CMD.TREE_DISCONNECT, b, { sign: true });
    } catch { /* 忽略 */ }
    try { this.socket.end(); } catch { /* 忽略 */ }
  }
}

module.exports = { Smb2Connection, md4 };

if (require.main === module) {
  const hex = (b) => b.toString('hex');
  console.log('MD4("")   =', hex(md4(Buffer.alloc(0))), 'expect 31d6cfe0d16ae931b73c59d7e0c089c0');
  console.log('MD4("abc")=', hex(md4(Buffer.from('abc'))), 'expect a448017aaf21d8525fc10ae87aa6729d');
}
