/**
 * KeyLinker BLE framing & identity codec — 100% bit-for-bit port of `oplus-core/src/protocol.rs`.
 * Adapted from x20ctl (GPL-3.0-or-later).
 */

export const SERVICE = "d7f010e0-660d-46e9-96c3-19c4148bdab5";
export const WRITE = "d7f010e1-660d-46e9-96c3-19c4148bdab5";
export const NOTIFY = "d7f010e2-660d-46e9-96c3-19c4148bdab5";

const SEND: readonly number[] = [
  51, 99, 157, 121, 242, 219, 162, 26, 170, 33, 139, 232, 116, 211, 88,
];

const SERIAL: readonly number[] = [
  161, 82, 213, 163, 245, 137, 246, 143, 240, 157, 72, 147, 234, 52, 49, 186,
  195, 77, 198, 235, 73, 96, 216, 163, 218, 42, 83, 141, 244, 97, 24, 191, 174,
  215, 111, 81, 228, 160, 217, 146,
];

export type ByteSource = Uint8Array | readonly number[];

export interface Packet {
  opcode: number;
  serial: number;
  payload: number[];
}

export interface Identity {
  vid: string;
  pid: string;
  version_display: string;
  mode: number;
  generation: number;
  sensor?: number;
}

export function toHex(data: ByteSource): string {
  let out = "";
  for (let i = 0; i < data.length; i++) {
    out += (data[i] & 0xff).toString(16).padStart(2, "0");
  }
  return out;
}

export function toHexUpper(data: ByteSource): string {
  return toHex(data).toUpperCase();
}

export function fromHex(hexText: string): Uint8Array {
  const clean = hexText.replace(/\s+/g, "");
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error("无效十六进制记录");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function crc8(data: ByteSource): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc = (crc ^ (data[i] & 0xff)) & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xeb) & 0xff : crc >>> 1;
    }
  }
  return crc;
}

function assertFrameSize(len: number): void {
  if (len < 5 || len > 20) {
    throw new Error("KeyLinker 帧必须为 5–20 字节");
  }
}

export function scramble(data: ByteSource): Uint8Array {
  assertFrameSize(data.length);
  const s = data[2] & 0xff;
  const n = data[3] & 0xff;
  const sn = (s + n) & 0xff;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] & 0xff;
  }
  out[0] = (out[0] ^ ((sn - 154) & 0xff)) & 0xff;
  out[1] = (out[1] ^ ((sn + 155) & 0xff)) & 0xff;
  out[2] = (((s - 173) & 0xff) ^ n) & 0xff;
  out[3] = (((n + 191) & 0xff) ^ 219) & 0xff;
  for (let i = 4; i < out.length - 1; i++) {
    out[i] = (out[i] ^ ((sn - SEND[i - 4]) & 0xff)) & 0xff;
  }
  const offset = (out[3] & 2) !== 0 ? 20 : 0;
  for (let i = 0; i < out.length; i++) {
    out[i] = (out[i] ^ SERIAL[offset + i]) & 0xff;
  }
  return out;
}

export function unscramble(data: ByteSource): Uint8Array {
  assertFrameSize(data.length);
  const offset = (((data[3] & 0xff) ^ SERIAL[3]) & 2) !== 0 ? 20 : 0;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = ((data[i] & 0xff) ^ SERIAL[offset + i]) & 0xff;
  }
  const n = ((out[3] ^ 219) - 191) & 0xff;
  const s = ((out[2] ^ n) + 173) & 0xff;
  const sn = (s + n) & 0xff;
  out[0] = (out[0] ^ ((sn - 154) & 0xff)) & 0xff;
  out[1] = (out[1] ^ ((sn + 155) & 0xff)) & 0xff;
  out[2] = s;
  out[3] = n;
  for (let i = 4; i < out.length - 1; i++) {
    out[i] = (out[i] ^ ((sn - SEND[i - 4]) & 0xff)) & 0xff;
  }
  return out;
}

export function parse(data: ByteSource): Packet {
  const plain = unscramble(data);
  if ((plain[1] & 31) !== plain.length) {
    throw new Error("响应帧长度不匹配");
  }
  if (crc8(plain.subarray(0, plain.length - 1)) !== plain[plain.length - 1]) {
    throw new Error("响应 CRC 校验失败");
  }
  return {
    opcode: plain[0],
    serial: plain[2],
    payload: Array.from(plain.subarray(4, plain.length - 1)),
  };
}

export function frame(
  opcode: number,
  payload: ByteSource,
  serial: number,
  nonce: number,
  length?: number | null,
): Uint8Array {
  if (payload.length > 15) {
    throw new Error("单帧数据超过 15 字节");
  }
  const lenByte =
    length !== undefined && length !== null
      ? length & 0xff
      : (payload.length + 5) & 0xff;
  if ((lenByte & 31) !== payload.length + 5) {
    throw new Error("长度字段与数据不一致");
  }
  const plain = new Uint8Array(payload.length + 5);
  plain[0] = opcode & 0xff;
  plain[1] = lenByte;
  plain[2] = serial & 0xff;
  plain[3] = nonce & 0xff;
  for (let i = 0; i < payload.length; i++) {
    plain[4 + i] = payload[i] & 0xff;
  }
  plain[plain.length - 1] = crc8(plain.subarray(0, plain.length - 1));
  return scramble(plain);
}

export function query(
  opcode: number,
  payload: ByteSource,
  serial: number,
  nonce: number,
  gen2Allowed: boolean,
): Uint8Array {
  const op = opcode & 0xff;
  let identification = false;
  if (op === 0x91) {
    identification = payload.length === 0;
  } else if (op === 0x90) {
    identification = payload.length === 1 && payload[0] >= 0 && payload[0] < 8;
  } else if (op === 0xb0) {
    identification =
      payload.length === 2 &&
      payload[0] >= 0 &&
      payload[0] < 8 &&
      payload[1] >= 1 &&
      payload[1] <= 7;
  }

  let setting = false;
  if (gen2Allowed) {
    if (
      (op >= 0xb1 && op <= 0xb4) ||
      op === 0xb6 ||
      op === 0xb7
    ) {
      setting = payload.length === 1 && payload[0] >= 0 && payload[0] < 32;
    } else if (op === 0xb5) {
      setting =
        payload.length === 2 &&
        payload[0] >= 0 &&
        payload[0] < 32 &&
        payload[1] >= 0 &&
        payload[1] < 8;
    }
  }

  if (!identification && !setting) {
    throw new Error("不允许的配置查询");
  }
  return frame(op, payload, serial, nonce, null);
}

export function saveSerial(chunk: number, counter: number): number {
  if (!Number.isInteger(chunk) || chunk < 0 || chunk > 15) {
    throw new Error("分片索引超过范围");
  }
  const c = counter >>> 0;
  return (((c % 2) << 7) | (chunk << 3) | (c % 8)) & 0xff;
}

export function hostLength(len: number, counter: number): number {
  if (!Number.isInteger(len) || len < 0 || len > 15) {
    throw new Error("单帧数据超过 15 字节");
  }
  if (len === 0) return 5;
  const c = counter & 0xff;
  return (((c % 8) << 5) | (len + 5)) & 0xff;
}

export function effectiveGeneration(identity: Identity): number {
  if (
    identity.generation === 2 &&
    (identity.mode === 0 || identity.mode === 7 || identity.mode === 8)
  ) {
    return 1;
  }
  return identity.generation;
}

export function isVerified137(identity: Identity): boolean {
  return (
    identity.vid === "1005" &&
    identity.pid === "2001" &&
    identity.version_display === "1.37" &&
    identity.mode === 6 &&
    identity.generation === 2
  );
}

export function isOPlusIdentity(identity: Identity): boolean {
  return (
    identity.vid.toUpperCase() === "1005" &&
    identity.pid.toUpperCase() === "2001"
  );
}

export function nameClaimsOPlus(name: string | null | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return ["o+", "oplus", "o plus", "致动o", "zd o"].some((needle) =>
    lower.includes(needle),
  );
}

export function normalizeIdentity(raw: any): Identity {
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof raw.vid !== "string" ||
    typeof raw.pid !== "string" ||
    typeof raw.version_display !== "string" ||
    typeof raw.mode !== "number" ||
    typeof raw.generation !== "number"
  ) {
    throw new Error("缺少设备身份");
  }
  return {
    vid: raw.vid,
    pid: raw.pid,
    version_display: raw.version_display,
    mode: raw.mode & 0xff,
    generation: raw.generation & 0xff,
    sensor: typeof raw.sensor === "number" ? raw.sensor & 0xff : 0,
  };
}

export function sameIdentity(a: Identity, b: Identity): boolean {
  return (
    a.vid === b.vid &&
    a.pid === b.pid &&
    a.version_display === b.version_display &&
    a.mode === b.mode &&
    a.generation === b.generation &&
    (a.sensor ?? 0) === (b.sensor ?? 0)
  );
}

export function parseIdentity(payload: ByteSource): Identity {
  if (payload.length === 0) {
    throw new Error("身份记录为空");
  }
  const declared = payload[0] & 0xff;
  if (declared < 6 || payload.length !== declared + 1) {
    throw new Error("身份记录不完整或长度不匹配");
  }
  const p = Array.from(payload).slice(1);
  let mode = 0;
  let generation = 0;
  let sensor = 0;
  if (declared === 7) {
    mode = p[6] & 15;
    generation = p[6] >>> 5;
    sensor = (p[6] >>> 4) & 1;
  }
  return {
    vid: toHexUpper(p.slice(0, 2)),
    pid: toHexUpper(p.slice(2, 4)),
    version_display: `${(p[4] & 0xff).toString(16).toUpperCase()}.${(p[5] & 0xff)
      .toString(16)
      .toUpperCase()
      .padStart(2, "0")}`,
    mode,
    generation,
    sensor,
  };
}

export function decodeKeys(data: ByteSource): number[] {
  if (data.length === 0) {
    return [];
  }
  const count = data[0] & 0xff;
  const keys: number[] = [];
  for (let i = 1; i < data.length; i++) {
    if (keys.length >= count) {
      break;
    }
    const b = data[i] & 0xff;
    if ((b & 128) !== 0) {
      const run = b & 127;
      if (keys.length === 0 || run === 0) {
        throw new Error("无效压缩按键表");
      }
      for (let r = 1; r < run; r++) {
        const last = keys[keys.length - 1];
        const next = last + 1;
        if (next > 255) {
          throw new Error("按键码溢出");
        }
        keys.push(next);
      }
    } else {
      keys.push(b);
    }
  }
  if (keys.length !== count) {
    throw new Error("按键表数量不匹配");
  }
  return keys;
}

export function decodeMacroLimits(data: ByteSource): number[] {
  if (data.length % 2 !== 0) {
    throw new Error("每槽宏步数记录长度无效");
  }
  const limits: number[] = [];
  for (let i = 0; i < data.length; i += 2) {
    limits.push((data[i] & 0xff) | ((data[i + 1] & 0xff) << 8));
  }
  return limits;
}
