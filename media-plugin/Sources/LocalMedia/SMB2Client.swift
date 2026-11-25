import Foundation
import Darwin
import CommonCrypto

// MARK: - 瀛楄妭搴忓伐鍏凤紙SMB2 鍏ㄥ皬绔級
enum B {
    static func le16(_ v: UInt16) -> [UInt8] { [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF)] }
    static func le32(_ v: UInt32) -> [UInt8] {
        [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8((v >> 24) & 0xFF)]
    }
    static func le64(_ v: UInt64) -> [UInt8] { (0..<8).map { UInt8((v >> (8 * $0)) & 0xFF) } }
    static func u16(_ a: [UInt8], _ i: Int) -> UInt16 { UInt16(a[i]) | UInt16(a[i + 1]) << 8 }
    static func u32(_ a: [UInt8], _ i: Int) -> UInt32 {
        UInt32(a[i]) | UInt32(a[i + 1]) << 8 | UInt32(a[i + 2]) << 16 | UInt32(a[i + 3]) << 24
    }
    static func u64(_ a: [UInt8], _ i: Int) -> UInt64 {
        var v: UInt64 = 0
        for k in 0..<8 { v |= UInt64(a[i + k]) << (8 * k) }
        return v
    }
    static func utf16le(_ s: String) -> [UInt8] {
        var out: [UInt8] = []
        for u in s.utf16 { out.append(UInt8(u & 0xFF)); out.append(UInt8((u >> 8) & 0xFF)) }
        return out
    }
    static func str16(_ a: [UInt8], _ i: Int, _ len: Int) -> String {
        var us: [UInt16] = []
        var k = i
        let end = min(i + len, a.count)
        while k + 1 < end {
            us.append(UInt16(a[k]) | UInt16(a[k + 1]) << 8)
            k += 2
        }
        return String(utf16CodeUnits: us, count: us.count)
    }
}

// MARK: - NTLM 瀵嗙爜瀛︼紙MD4/MD5/HMAC 璧?CommonCrypto锛?enum NTLM {
    static func md4(_ d: Data) -> Data {
        var out = Data(count: 16)
        d.withUnsafeBytes { p in _ = CC_MD4(p.baseAddress, CC_LONG(d.count), &out) }
        return out
    }
    static func md5(_ d: Data) -> Data {
        var out = Data(count: 16)
        d.withUnsafeBytes { p in _ = CC_MD5(p.baseAddress, CC_LONG(d.count), &out) }
        return out
    }
    static func hmacMD5(_ key: Data, _ msg: Data) -> Data {
        var out = Data(count: 16)
        var keyB = [UInt8](key)
        if keyB.count > 64 { keyB = [UInt8](md5(Data(keyB))) }
        while keyB.count < 64 { keyB.append(0) }
        let oPad = Data(keyB.map { $0 ^ 0x5C })
        let iP = Data(keyB.map { $0 ^ 0x36 })
        msg.withUnsafeBytes { mp in oPad.withUnsafeBytes { op in iP.withUnsafeBytes { ip in
            _ = CCHmac(CC_ALGORITHM(kCCHmacAlgMD5), ip.baseAddress, ip.count, mp.baseAddress, mp.count, &out)
        }}}
        return out
    }
    static func hmacSHA256(_ key: Data, _ msg: Data) -> Data {
        var out = Data(count: 32)
        key.withUnsafeBytes { kp in msg.withUnsafeBytes { mp in
            _ = CCHmac(CC_ALGORITHM(kCCHmacAlgSHA256), kp.baseAddress, kp.count, mp.baseAddress, mp.count, &out)
        }}
        return out
    }
    static func fileTimeNow() -> UInt64 {
        UInt64((Date().timeIntervalSince1970 + 11644473600) * 10_000_000)
    }
    static func ntlmV2Response(pass: String, serverChallenge: [UInt8], targetInfo: [UInt8]) -> Data {
        let ntowf = md4(Data(B.utf16le(pass)))
        var cc = [UInt8](repeating: 0, count: 8)
        for i in 0..<8 { cc[i] = UInt8.random(in: 0...255) }
        var blob: Data = Data([0x01, 0x01, 0x00, 0x00])
        blob.append(Data(B.le64(fileTimeNow())))
        blob.append(Data(cc))
        blob.append(Data([0,0,0,0]))
        blob.append(Data(targetInfo))
        blob.append(Data([0,0,0,0]))
        return hmacMD5(ntowf, Data(serverChallenge) + blob) + blob
    }
    static func authenticateMessage(resp: Data, targetName: String, targetInfo: [UInt8], serverChallenge: [UInt8]) -> Data {
        let tn = B.utf16le(targetName)
        var v = resp
        if v.count % 2 != 0 { v.append(0) }
        let tnOff = 104 + v.count
        v += tn
        if v.count % 2 != 0 { v.append(0) }
        let tiOff = 104 + v.count
        v += targetInfo
        var m: Data = Data(B.utf16le("NTLMSSP")) + [0x00]
        m.append(Data(B.le32(3)))
        m.append(Data([UInt8](repeating: 0, count: 16)))
        m.append(Data(B.le16(0) + B.le16(0) + B.le32(0)))
        m.append(Data(B.le16(UInt16(resp.count)) + B.le16(UInt16(resp.count)) + B.le32(104)))
        m.append(Data(B.le16(0) + B.le16(0) + B.le32(0)))
        m.append(Data(B.le16(UInt16(tn.count)) + B.le16(UInt16(tn.count)) + B.le32(UInt32(tnOff))))
        m.append(Data(B.le32(0x02028001)))
        m.append(Data(serverChallenge))
        m.append(Data(B.le64(fileTimeNow())))
        m.append(Data([UInt8](repeating: 0, count: 8)))
        m.append(Data(B.le32(0)))
        m.append(Data(B.le16(UInt16(targetInfo.count)) + B.le16(UInt16(targetInfo.count)) + B.le32(UInt32(tiOff))))
        m.append(Data(B.le32(0)))
        m.append(Data(v))
        return m
    }
    static func negotiateMessage(targetName: String?) -> Data {
        var m: Data = Data(B.utf16le("NTLMSSP")) + [0x00]
        m.append(Data(B.le32(1)))
        var flags: UInt32 = 0x00020201
        if targetName != nil { flags |= 0x00080000 }
        m.append(Data(B.le32(flags)))
        if let tn = targetName {
            let t = B.utf16le(tn)
            m.append(Data(B.le16(UInt16(t.count)) + B.le16(UInt16(t.count)) + B.le32(64)))
        } else {
            m.append(Data(B.le16(0) + B.le16(0) + B.le32(0)))
        }
        m.append(Data(B.le16(0) + B.le32(0)))
        m.append(Data(B.le16(0) + B.le32(0)))
        m.append(Data([UInt8](repeating: 0, count: 64)))
        return m
    }
    static func parseChallenge(_ buf: [UInt8]) -> (challenge: [UInt8], targetName: String, targetInfo: [UInt8])? {
        guard buf.count >= 64, B.str16(buf, 0, 8) == "NTLMSSP", B.u32(buf, 8) == 2 else { return nil }
        let tnOff = Int(B.u32(buf, 24)), tnLen = Int(B.u16(buf, 20))
        let tiOff = Int(B.u32(buf, 44)), tiLen = Int(B.u16(buf, 40))
        let challenge = Array(buf[28..<36])
        let targetName = tnLen > 0 ? B.str16(buf, tnOff, tnLen) : ""
        let targetInfo = tiLen > 0 ? Array(buf[tiOff..<min(tiOff + tiLen, buf.count)]) : [UInt8]()
        return (challenge, targetName, targetInfo)
    }
}

// MARK: - AES-128锛堢函 Swift锛屼粎鍔犲瘑鏂瑰悜锛屼緵 CMAC锛?enum AES {
    static let sbox: [UInt8] = [
        0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
        0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
        0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
        0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
        0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
        0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
        0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
        0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
        0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
        0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
        0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
        0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
        0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
        0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
        0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
        0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16]
    static let rcon: [UInt8] = [0x00,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36]
    static func gmul(_ a: UInt8, _ b: UInt8) -> UInt8 {
        var p: UInt8 = 0; var aa = a; var bb = b
        for _ in 0..<8 {
            if bb & 1 != 0 { p ^= aa }
            let hi = aa & 0x80
            aa = UInt8(aa << 1)
            if hi != 0 { aa ^= 0x1b }
            bb >>= 1
        }
        return p
    }
    static func expandKey(_ key: [UInt8]) -> [[UInt8]] {
        var w = [[UInt8]](repeating: [0,0,0,0], count: 44)
        for i in 0..<4 { w[i] = [key[i*4], key[i*4+1], key[i*4+2], key[i*4+3]] }
        for i in 4..<44 {
            var temp = w[i-1]
            if i % 4 == 0 {
                temp = [temp[1], temp[2], temp[3], temp[0]]
                temp = temp.map { sbox[$0] }
                temp[0] ^= rcon[i/4]
            }
            w[i] = [UInt8(w[i-4][0] ^ temp[0]), UInt8(w[i-4][1] ^ temp[1]),
                    UInt8(w[i-4][2] ^ temp[2]), UInt8(w[i-4][3] ^ temp[3])]
        }
        var rk = [[UInt8]](repeating: [0,0,0,0], count: 11)
        for r in 0..<11 { for c in 0..<4 { rk[r][c] = w[r*4+c] } }
        return rk
    }
    static func encryptBlock(_ block: [UInt8], rk: [[UInt8]]) -> [UInt8] {
        var st = [[UInt8]](repeating: [0,0,0,0], count: 4)
        for c in 0..<4 { for r in 0..<4 { st[r][c] = block[r + 4*c] } }
        func addRoundKey(_ round: Int) { for c in 0..<4 { for r in 0..<4 { st[r][c] ^= rk[round][c][r] } } }
        func subBytes() { for c in 0..<4 { for r in 0..<4 { st[r][c] = sbox[st[r][c]] } } }
        func shiftRows() { for r in 1..<4 { st[r] = Array(st[r][r...]) + Array(st[r][..<r]) } }
        func mixColumns() {
            for c in 0..<4 {
                let a0 = st[0][c], a1 = st[1][c], a2 = st[2][c], a3 = st[3][c]
                st[0][c] = gmul(a0,2) ^ gmul(a1,3) ^ a2 ^ a3
                st[1][c] = a0 ^ gmul(a1,2) ^ gmul(a2,3) ^ a3
                st[2][c] = a0 ^ a1 ^ gmul(a2,2) ^ gmul(a3,3)
                st[3][c] = gmul(a0,3) ^ a1 ^ a2 ^ gmul(a3,2)
            }
        }
        addRoundKey(0)
        for round in 1..<10 { subBytes(); shiftRows(); mixColumns(); addRoundKey(round) }
        subBytes(); shiftRows(); addRoundKey(10)
        var out = [UInt8](repeating: 0, count: 16)
        for c in 0..<4 { for r in 0..<4 { out[r + 4*c] = st[r][c] } }
        return out
    }
    static func cmac(key: [UInt8], msg: [UInt8]) -> [UInt8] {
        let rk = expandKey(key)
        let zero = [UInt8](repeating: 0, count: 16)
        let l = encryptBlock(zero, rk: rk)
        func dbl(_ x: [UInt8]) -> [UInt8] {
            var out = [UInt8](repeating: 0, count: 16)
            let carry = x[0] >> 7
            for i in 0..<16 { out[i] = UInt8((x[i] << 1) | (i > 0 ? x[i-1] >> 7 : 0)) }
            if carry != 0 { out[15] ^= 0x87 }
            return out
        }
        let k1 = dbl(l), k2 = dbl(k1)
        let n = max(1, Int(ceil(Double(msg.count) / 16.0)))
        var lastBlock: [UInt8]
        if msg.count > 0 && msg.count % 16 == 0 {
            lastBlock = zip(Array(msg.suffix(16)), k1).map { $0 ^ $1 }
        } else {
            var padded = Array(msg); padded.append(0x80)
            while padded.count < 16 { padded.append(0) }
            lastBlock = zip(padded, k2).map { $0 ^ $1 }
        }
        var x = zero
        for i in 0..<n-1 {
            let blk = Array(msg[i*16..<((i+1)*16)])
            x = encryptBlock(zip(x, blk).map { $0 ^ $1 }, rk: rk)
        }
        return encryptBlock(zip(x, lastBlock).map { $0 ^ $1 }, rk: rk)
    }
}

// MARK: - SMB2 杩炴帴
final class SMB2Connection {
    struct Config {
        var host: String
        var port: Int = 445
        var user: String = ""
        var pass: String = ""
        var domain: String = ""
    }
    private(set) var fd: Int32 = -1
    let cfg: Config
    let share: String
    private var sessionId: UInt64 = 0
    private var treeId: UInt32 = 0
    private var msgId: UInt64 = 0
    private(set) var dialect: UInt16 = 0
    private(set) var requireSigning = false
    private var signingKey = [UInt8]()
    private var sessionKey = Data()
    private var maxReadSize = 64 * 1024
    private var lastTreeId: UInt32 = 0
    private var lastSessionId: UInt64 = 0

    static let opNegotiate: UInt8 = 0x00
    static let opSessionSetup: UInt8 = 0x01
    static let opTreeConnect: UInt8 = 0x03
    static let opCreate: UInt8 = 0x05
    static let opClose: UInt8 = 0x06
    static let opRead: UInt8 = 0x08
    static let opWrite: UInt8 = 0x09
    static let opIoctl: UInt8 = 0x0B
    static let opQueryDir: UInt8 = 0x0E
    private static let fsctlSetName: UInt32 = 0x00050004

    init(cfg: Config, share: String) throws {
        self.cfg = cfg
        self.share = share
        try connect()
        try negotiate()
        try sessionSetup()
        try treeConnect()
    }
    func close() { if fd >= 0 { Darwin.close(fd); fd = -1 } }
    deinit { close() }
    private func smbErr(_ code: Int, _ msg: String) -> NSError {
        NSError(domain: "smb2", code: code, userInfo: [NSLocalizedDescriptionKey: msg])
    }
    private func connect() throws {
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(cfg.port).bigEndian)
        guard inet_pton(AF_INET, cfg.host, &addr.sin_addr) == 1 else { throw smbErr(-1, "bad host: \(cfg.host)") }
        let f = socket(AF_INET, SOCK_STREAM, 0)
        guard f >= 0 else { throw smbErr(-2, "socket() failed") }
        var tv = timeval(tv_sec: 10, tv_usec: 0)
        setsockopt(f, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(f, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        let r = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sp in
                Darwin.connect(f, sp, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard r == 0 else { Darwin.close(f); throw smbErr(-3, "connect \(cfg.host):\(cfg.port) failed errno=\(errno)") }
        fd = f
    }
    private func sendRaw(_ data: [UInt8]) throws {
        var sent = 0
        while sent < data.count {
            let n = data.withUnsafeBytes { p in Darwin.send(fd, p.baseAddress!.advanced(by: sent), data.count - sent, 0) }
            if n <= 0 { throw smbErr(-4, "send failed errno=\(errno)") }
            sent += n
        }
    }
    private func readExactly(_ count: Int) throws -> [UInt8] {
        var buf = [UInt8](repeating: 0, count: count); var got = 0
        while got < count {
            let n = buf.withUnsafeMutableBytes { p in Darwin.recv(fd, p.baseAddress!.advanced(by: got), count - got, 0) }
            if n <= 0 { throw smbErr(-5, "recv failed errno=\(errno)") }
            got += n
        }
        return buf
    }
    private func header(_ cmd: UInt8, id: UInt64, sign: Bool) -> [UInt8] {
        var h = [UInt8](repeating: 0, count: 64)
        h[0...3] = B.le32(0xFE534D42)
        h[4...5] = B.le16(64)
        h[6...7] = B.le16(0)
        h[8...11] = B.le32(0)
        h[12] = cmd
        h[13] = 1
        h[14...17] = sign ? B.le32(0x00000008) : B.le32(0)
        h[18...21] = B.le32(0)
        h[22...29] = B.le64(id)
        h[30...33] = B.le32(0)
        h[34...37] = B.le32(treeId)
        h[38...45] = B.le64(sessionId)
        return h
    }
    private func signMsg(_ data: [UInt8]) -> [UInt8] {
        var d = data
        for i in 46..<62 { d[i] = 0 }
        if dialect == 0x0210 || dialect == 0x0202 || dialect == 0x0203 {
            return Array(NTLM.hmacSHA256(sessionKey, Data(d)).prefix(16))
        }
        return AES.cmac(key: signingKey, msg: d)
    }
    private func receive() throws -> [UInt8] {
        let head = try readExactly(64)
        let cmd = head[12]
        let status = B.u32(head, 8)
        lastTreeId = B.u32(head, 34)
        lastSessionId = B.u64(head, 38)
        var msg = head
        switch cmd {
        case Self.opRead:
            let f = try readExactly(17); msg += f
            let total = Int(f[2]) + Int(B.u32(f, 4))
            if total > msg.count { msg += try readExactly(total - msg.count) }
        case Self.opQueryDir:
            let f = try readExactly(9); msg += f
            let total = Int(B.u16(f, 2)) + Int(B.u32(f, 4))
            if total > msg.count { msg += try readExactly(total - msg.count) }
        case Self.opCreate:
            let f = try readExactly(89); msg += f
            let total = max(153, Int(B.u32(f, 80)) + Int(B.u32(f, 84)))
            if total > msg.count { msg += try readExactly(total - msg.count) }
        case Self.opSessionSetup:
            let f = try readExactly(9); msg += f
            let total = max(73, Int(B.u16(f, 4)) + Int(B.u16(f, 6)))
            if total > msg.count { msg += try readExactly(total - msg.count) }
        case Self.opIoctl:
            let f = try readExactly(49); msg += f
            let total = max(113, Int(B.u32(f, 32)) + Int(B.u32(f, 36)))
            if total > msg.count { msg += try readExactly(total - msg.count) }
        case Self.opTreeConnect:
            msg += try readExactly(4)
        case Self.opNegotiate:
            let ss2 = try readExactly(2); msg += ss2
            let need = (Int(B.u16(ss2, 0)) == 66) ? 64 : 34
            msg += try readExactly(need)
        case Self.opClose:
            msg += try readExactly(60)
        case Self.opWrite:
            msg += try readExactly(17)
        default:
            msg += try readExactly(256)
        }
        if status != 0 && status != 0xC0000016 {
            throw smbErr(-10, "smb2 status 0x\(String(status, radix: 16, uppercase: true))")
        }
        return msg
    }
    private func rpc(_ cmd: UInt8, _ body: [UInt8], sign: Bool) throws -> [UInt8] {
        msgId &+= 1
        var msg = header(cmd, id: msgId, sign: sign && requireSigning) + body
        if sign && requireSigning { msg[46..<62] = signMsg(msg) }
        try sendRaw(msg)
        let resp = try receive()
        if requireSigning && B.u32(resp, 14) != 0 {
            if Array(resp[46..<62]) != signMsg(resp) { throw smbErr(-6, "signature mismatch") }
        }
        let status = B.u32(resp, 8)
        if status != 0 && status != 0xC0000016 {
            throw smbErr(-10, "smb2 status 0x\(String(status, radix: 16, uppercase: true))")
        }
        return Array(resp[64...])
    }
    private func negotiate() throws {
        var body = B.le16(36) + B.le16(3) + B.le16(0x0001) + B.le16(0) + B.le32(0)
        var guid = [UInt8](repeating: 0, count: 16)
        for i in 0..<16 { guid[i] = UInt8.random(in: 0...255) }
        body += guid
        body += B.le64(0)
        body += B.le16(0x0210) + B.le16(0x0300) + B.le16(0x0302)
        let resp = try rpc(Self.opNegotiate, body, sign: false)
        let ss = Int(B.u16(resp, 0))
        dialect = B.u16(resp, 2)
        requireSigning = (B.u16(resp, 4) & 0x0002) != 0
        maxReadSize = ss == 66 ? Int(B.u32(resp, 43)) : Int(B.u32(resp, 16))
        if maxReadSize == 0 { maxReadSize = 64 * 1024 }
    }
    private func sessionSetup() throws {
        var guest = B.le16(25) + B.le16(0) + B.le16(0) + B.le32(0) + B.le32(0)
        guest += B.le16(0) + B.le16(0) + B.le64(0) + [0x00]
        while guest.count < 32 { guest.append(0) }
        let gr = try rpc(Self.opSessionSetup, guest, sign: false)
        if (B.u16(gr, 2) & 0x0001) != 0 { sessionId = lastSessionId; return }
        let status = B.u32(gr, 0)
        if status == 0 { return }
        let secOff = Int(B.u16(gr, 4)), secLen = Int(B.u16(gr, 6))
        let bufStart = secOff - 64
        guard bufStart >= 0, bufStart + secLen <= gr.count else { return }
        guard let ch = NTLM.parseChallenge(Array(gr[bufStart..<bufStart+secLen])) else { throw smbErr(-7, "no NTLM challenge") }
        let v2resp = NTLM.ntlmV2Response(pass: cfg.pass, serverChallenge: ch.challenge, targetInfo: ch.targetInfo)
        let auth = NTLM.authenticateMessage(resp: v2resp, targetName: ch.targetName, targetInfo: ch.targetInfo, serverChallenge: ch.challenge)
        var req = B.le16(25) + B.le16(0) + B.le16(0x01) + B.le32(0) + B.le32(0)
        req += B.le16(96) + B.le16(UInt16(auth.count)) + B.le64(0) + [0x00]
        while req.count < 32 { req.append(0) }
        req += Array(auth)
        let ar = try rpc(Self.opSessionSetup, req, sign: false)
        if B.u32(ar, 0) != 0 { throw smbErr(-8, "auth failed 0x\(String(B.u32(ar, 0), radix: 16, uppercase: true))") }
        let aSecOff = Int(B.u16(ar, 4)), aSecLen = Int(B.u16(ar, 6))
        let aStart = aSecOff - 64
        sessionKey = Data(ar[aStart..<aStart+aSecLen])
        sessionId = lastSessionId
        if dialect == 0x0210 || dialect == 0x0202 || dialect == 0x0203 {
            signingKey = Array(sessionKey)
        } else {
            var kdfInput: Data = Data(B.le64(1))
            kdfInput.append(Data("SMB2AESCMAC\0".utf8))
            kdfInput.append(0x00)
            kdfInput.append(Data(B.le32(0x80)))
            signingKey = Array(NTLM.hmacSHA256(sessionKey, kdfInput).prefix(16))
        }
    }
    private func treeConnect() throws {
        let path = "\\\\\(cfg.host)\\\(share)"
        let pb = B.utf16le(path)
        var body = B.le16(9) + B.le16(0) + B.le16(80) + B.le16(UInt16(pb.count))
        body += [UInt8](repeating: 0, count: 80 - (64 + 8))
        body += pb
        let resp = try rpc(Self.opTreeConnect, body, sign: true)
        treeId = lastTreeId
        _ = resp
    }
    func create(path: String, desiredAccess: UInt32, createOptions: UInt32, disposition: UInt32) throws -> (fileId: [UInt8], endOf: UInt64, attrs: UInt32) {
        let nb = B.utf16le(path)
        var body = B.le16(57) + B.le16(0) + B.le16(0) + B.le32(2) + B.le64(0) + B.le64(0)
        body += B.le32(desiredAccess)
        body += B.le32(createOptions & 0x10 != 0 ? 0x10 : 0)
        body += B.le32(createOptions & 0x10 != 0 ? 0x01 : 0x07)
        body += B.le32(disposition)
        body += B.le32(createOptions)
        body += B.le16(128) + B.le16(UInt16(nb.count)) + B.le32(0) + B.le32(0)
        while body.count < 64 { body.append(0) }
        body += nb
        let resp = try rpc(Self.opCreate, body, sign: true)
        return (Array(resp[64..<80]), B.u64(resp, 48), B.u32(resp, 56))
    }
    func closeFile(_ fileId: [UInt8], delete: Bool) throws {
        var body = B.le16(24) + B.le16(delete ? 0x0002 : 0x0000) + B.le32(0)
        body += fileId
        _ = try rpc(Self.opClose, body, sign: true)
    }
    func readFile(_ fileId: [UInt8], offset: UInt64, length: Int) throws -> (data: [UInt8], remaining: UInt32) {
        let len = min(length, maxReadSize)
        var body = B.le16(49) + [0x80] + [0x00]
        body += B.le32(UInt32(len))
        body += B.le64(offset)
        body += fileId
        body += B.le32(0) + B.le32(0) + B.le32(0) + B.le16(0) + B.le16(0)
        let resp = try rpc(Self.opRead, body, sign: true)
        let dataOff = Int(resp[2])
        let dataLen = Int(B.u32(resp, 4))
        let remaining = B.u32(resp, 8)
        let start = dataOff - 64
        return (Array(resp[start..<start+dataLen]), remaining)
    }
    func queryDirectory(_ fileId: [UInt8], restart: Bool) throws -> [UInt8] {
        var body = B.le16(33) + B.le16(1) + B.le16(restart ? 1 : 0) + B.le32(0)
        body += fileId
        body += B.le16(0) + B.le16(0) + B.le32(0x10000) + [0x00]
        let resp = try rpc(Self.opQueryDir, body, sign: true)
        let outOff = Int(B.u16(resp, 2))
        let outLen = Int(B.u32(resp, 4))
        let start = outOff - 64
        return Array(resp[start..<start+outLen])
    }
    func rename(fileId: [UInt8], newName: String) throws {
        var info: [UInt8] = [0x00]
        info += B.le64(0)
        info += B.le32(0)
        let nb = B.utf16le(newName)
        info += B.le32(UInt32(nb.count))
        info += nb
        var body = B.le16(57) + B.le16(0) + B.le32(0x00050004)
        body += fileId
        body += B.le32(128) + B.le32(UInt32(info.count)) + B.le32(0)
        body += B.le32(0) + B.le32(0) + B.le32(0x1000) + B.le32(0x01) + B.le32(0)
        while body.count < 64 { body.append(0) }
        body += info
        _ = try rpc(Self.opIoctl, body, sign: true)
    }
    func rpcWrite(_ body: [UInt8]) throws -> [UInt8] {
        msgId &+= 1
        var msg = header(Self.opWrite, id: msgId, sign: requireSigning) + body
        if requireSigning { msg[46..<62] = signMsg(msg) }
        try sendRaw(msg)
        return try receive()
    }
}

struct SMB2DirEntry {
    let name: String
    let isDirectory: Bool
    let endOf: UInt64
}

enum SMB2Client {
    static func connect(_ cfg: SMB2Connection.Config, share: String) throws -> SMB2Connection {
        try SMB2Connection(cfg: cfg, share: share)
    }
    static func list(cfg: SMB2Connection.Config, share: String, path: String) throws -> [SMB2DirEntry] {
        let c = try connect(cfg, share: share)
        defer { c.close() }
        let rel = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let dirPath = rel.isEmpty ? "" : "\\" + rel.replacingOccurrences(of: "/", with: "\\")
        let dir = try c.create(path: dirPath, desiredAccess: 0x00120081, createOptions: 0x00000010, disposition: 1)
        var entries: [SMB2DirEntry] = []
        let buf = try c.queryDirectory(dir.fileId, restart: true)
        var i = 0
        while i < buf.count {
            let next = Int(B.u32(buf, i))
            let attrs = B.u32(buf, i + 32)
            let nameLen = Int(B.u32(buf, i + 40))
            let nameOff = Int(B.u32(buf, i + 44))
            let endOf = B.u64(buf, i + 24)
            let name = B.str16(buf, i + nameOff, nameLen)
            if name != "." && name != ".." {
                entries.append(SMB2DirEntry(name: name, isDirectory: attrs & 0x10 != 0, endOf: endOf))
            }
            if next == 0 { break }
            i += next
        }
        try? c.closeFile(dir.fileId, delete: false)
        return entries
    }
    static func createDirectory(cfg: SMB2Connection.Config, share: String, path: String, name: String) throws {
        let c = try connect(cfg, share: share)
        defer { c.close() }
        let rel = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let p = rel.isEmpty ? "\\" + name : "\\\(rel.replacingOccurrences(of: "/", with: "\\"))\\\(name)"
        let d = try c.create(path: p, desiredAccess: 0x00100082, createOptions: 0x00000010, disposition: 3)
        try? c.closeFile(d.fileId, delete: false)
    }
    static func rename(cfg: SMB2Connection.Config, share: String, path: String, name: String, newName: String) throws {
        let c = try connect(cfg, share: share)
        defer { c.close() }
        let rel = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let p = rel.isEmpty ? "\\" + name : "\\\(rel.replacingOccurrences(of: "/", with: "\\"))\\\(name)"
        let f = try c.create(path: p, desiredAccess: 0x00100080, createOptions: 0x00000040, disposition: 1)
        try c.rename(fileId: f.fileId, newName: newName)
        try? c.closeFile(f.fileId, delete: false)
    }
    static func remove(cfg: SMB2Connection.Config, share: String, path: String, name: String) throws {
        let c = try connect(cfg, share: share)
        defer { c.close() }
        let rel = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let p = rel.isEmpty ? "\\" + name : "\\\(rel.replacingOccurrences(of: "/", with: "\\"))\\\(name)"
        let f = try c.create(path: p, desiredAccess: 0x00110080, createOptions: 0, disposition: 1)
        try c.closeFile(f.fileId, delete: true)
    }
    static func move(cfg: SMB2Connection.Config, share: String, srcPath: String, name: String, destPath: String) throws {
        let c = try connect(cfg, share: share)
        defer { c.close() }
        let rel = srcPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let p = rel.isEmpty ? "\\" + name : "\\\(rel.replacingOccurrences(of: "/", with: "\\"))\\\(name)"
        let f = try c.create(path: p, desiredAccess: 0x00100080, createOptions: 0, disposition: 1)
        let drel = destPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let dest = drel.isEmpty ? "\\" + name : "\\\(drel.replacingOccurrences(of: "/", with: "\\"))\\\(name)"
        try c.rename(fileId: f.fileId, newName: dest)
        try? c.closeFile(f.fileId, delete: false)
    }
    static func copy(cfg: SMB2Connection.Config, share: String, srcPath: String, name: String, destPath: String) throws {
        let c = try connect(cfg, share: share)
        defer { c.close() }
        let rel = srcPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let src = rel.isEmpty ? "\\" + name : "\\\(rel.replacingOccurrences(of: "/", with: "\\"))\\\(name)"
        let sf = try c.create(path: src, desiredAccess: 0x00100081, createOptions: 0x00000040, disposition: 1)
        let drel = destPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let dest = drel.isEmpty ? "\\" + name : "\\\(drel.replacingOccurrences(of: "/", with: "\\"))\\\(name)"
        let df = try c.create(path: dest, desiredAccess: 0x00100082, createOptions: 0x00000040, disposition: 2)
        var offset: UInt64 = 0
        while true {
            let (data, rem) = try c.readFile(sf.fileId, offset: offset, length: 256 * 1024)
            if data.isEmpty { break }
            try writeData(c, df.fileId, data, offset)
            offset += UInt64(data.count)
            if rem == 0 { break }
        }
        try? c.closeFile(df.fileId, delete: false)
        try? c.closeFile(sf.fileId, delete: false)
    }
    private static func writeData(_ c: SMB2Connection, _ fileId: [UInt8], _ data: [UInt8], _ offset: UInt64) throws {
        var body = B.le16(49) + B.le16(120) + B.le32(UInt32(data.count)) + B.le64(offset)
        body += fileId
        body += B.le32(0) + B.le32(0) + B.le16(0) + B.le16(0) + B.le32(0)
        while body.count < 56 { body.append(0) }
        body += data
        _ = try c.rpcWrite(body)
    }
    static func fileSize(cfg: SMB2Connection.Config, share: String, path: String, name: String) throws -> Int64 {
        let c = try connect(cfg, share: share)
        defer { c.close() }
        let rel = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let p = rel.isEmpty ? "\\" + name : "\\\(rel.replacingOccurrences(of: "/", with: "\\"))\\\(name)"
        let f = try c.create(path: p, desiredAccess: 0x00100081, createOptions: 0x00000040, disposition: 1)
        try? c.closeFile(f.fileId, delete: false)
        return Int64(f.endOf)
    }
    static func isDir(cfg: SMB2Connection.Config, share: String, path: String, name: String) throws -> Bool {
        let c = try connect(cfg, share: share)
        defer { c.close() }
        let rel = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let p = rel.isEmpty ? "\\" + name : "\\\(rel.replacingOccurrences(of: "/", with: "\\"))\\\(name)"
        let f = try c.create(path: p, desiredAccess: 0x00120081, createOptions: 0x00000010, disposition: 1)
        try? c.closeFile(f.fileId, delete: false)
        return f.attrs & 0x10 != 0
    }
}

final class SMB2Stream {
    private let conn: SMB2Connection
    private let fileId: [UInt8]
    private(set) var endOf: UInt64
    init(cfg: SMB2Connection.Config, share: String, path: String, name: String) throws {
        conn = try SMB2Connection(cfg: cfg, share: share)
        let rel = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let p = rel.isEmpty ? "\\" + name : "\\\(rel.replacingOccurrences(of: "/", with: "\\"))\\\(name)"
        let f = try conn.create(path: p, desiredAccess: 0x00100081, createOptions: 0x00000040, disposition: 1)
        fileId = f.fileId
        endOf = f.endOf
    }
    func read(offset: UInt64, length: Int) throws -> [UInt8] {
        let (data, _) = try conn.readFile(fileId, offset: offset, length: length)
        return data
    }
    func close() {
        try? conn.closeFile(fileId, delete: false)
        conn.close()
    }
    deinit { close() }
}
