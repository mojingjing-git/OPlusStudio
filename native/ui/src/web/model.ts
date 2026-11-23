/**
 * Dynamic device model, macro bitmask codec, cross-firmware translator,
 * boundary validator, and keymap profile validator/migrator.
 * 100% bit-for-bit port of `oplus-core/src/model.rs` & `keymap.rs`.
 */

import {
  APP_VERSION,
  type Change,
  type KbStep,
  type KeymapAction,
  type KeymapProfile,
  type KeymapRule,
  type KeymapStore,
  LABELS_OPLUS_6,
  type OutputToken,
  type PadButton,
  type Program,
  type RecordData,
  SLOT_ORDER_8,
  type Snapshot,
  type Step,
  type SupportTier,
  padButtonToOnboardKey,
} from "../types.ts";
import {
  FLAG_INVERT_X,
  FLAG_INVERT_Y,
  FLAG_SWAP,
  STICK_MAX_PROGRESS,
  TRIGGER_MAX_PROGRESS,
  curveSideMask,
} from "../curves.ts";
import {
  type ByteSource,
  type Identity,
  effectiveGeneration,
  fromHex,
  isOPlusIdentity,
  isVerified137,
  nameClaimsOPlus,
  normalizeIdentity,
  toHex,
} from "./protocol.ts";

export const MACRO_KEYS: readonly number[] = [
  18, 19, 13, 14, 15, 16, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 93, 94,
];

export const VERIFIED_137_CAPS: readonly number[] = [
  3, 3, 15, 0, 63, 1, 11, 0, 192, 0,
];

export const DEFAULT_OPLUS_ALL_KEYS: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 93, 94, 95, 96,
  97, 104,
];

export const DEFAULT_OPLUS_REMAP_KEYS: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 13, 14, 15, 16, 11, 12, 93, 94,
];

const DEFAULT_OPLUS_STICKS_BODY: readonly number[] = [
  6, 8, 85, 85, 170, 170, 0, 6, 8, 85, 85, 170, 170, 0,
];

const DEFAULT_OPLUS_TRIGGERS_BODY: readonly number[] = [
  4, 2, 85, 85, 170, 170, 0, 4, 2, 85, 85, 170, 170, 0,
];

const DEFAULT_OPLUS_MOTORS_BODY: readonly number[] = [
  0xbf, 0xbf, 0x4c, 0x4c, 0x20, 0xbf, 0x02, 0x00,
];

const DEFAULT_OPLUS_LIGHTING_BODY: readonly number[] = [
  255, 255, 255, 0, 0, 32, 0, 255, 0, 16, 0, 64, 0, 0, 255, 64, 128, 128, 128,
  128, 128, 160, 128, 255,
];

const DIRECTIONS: readonly string[] = [
  "UP",
  "UP_RIGHT",
  "RIGHT",
  "DOWN_RIGHT",
  "DOWN",
  "DOWN_LEFT",
  "LEFT",
  "UP_LEFT",
];

const KEY_NAMES: readonly [number, string][] = [
  [1, "A"],
  [2, "B"],
  [3, "X"],
  [4, "Y"],
  [5, "LB"],
  [6, "RB"],
  [7, "LT"],
  [8, "RT"],
  [9, "SELECT_LEGACY"],
  [10, "START_LEGACY"],
  [11, "L3"],
  [12, "R3"],
  [13, "DPAD_DOWN"],
  [14, "DPAD_UP"],
  [15, "DPAD_RIGHT"],
  [16, "DPAD_LEFT"],
  [17, "HOME"],
  [18, "LSTICK_ANALOG"],
  [19, "RSTICK_ANALOG"],
  [93, "SELECT"],
  [94, "START"],
  [95, "CAPTURE"],
  [96, "TURBO"],
  [97, "M_LEFT"],
  [104, "M2"],
];

export interface Capabilities {
  sticks: number;
  triggers: number;
  motors: number;
  turbo: number;
  macros: number;
  changekey: number;
  lighting: number;
  engine: number;
  nfc: number;
  sensor: number;
  raw_hex: string;
}

export function bytesEqual(a: ByteSource, b: ByteSource): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if ((a[i] & 0xff) !== (b[i] & 0xff)) return false;
  }
  return true;
}

export function unhex(text: string): number[] {
  return Array.from(fromHex(text));
}

export function hexSpaced(bytes: ByteSource): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    parts.push((bytes[i] & 0xff).toString(16).padStart(2, "0"));
  }
  return parts.join(" ");
}

export function makeRecord(bytes: ByteSource, text: string | null = null): RecordData {
  return {
    declared: bytes.length,
    hex: hexSpaced(bytes),
    text,
  };
}

export function recordBytes(record: RecordData): number[] {
  const data = unhex(record.hex);
  if (data.length !== record.declared || data.length > 239) {
    throw new Error("记录长度不匹配");
  }
  return data;
}

export function recordPayload(record: RecordData): number[] {
  const body = recordBytes(record);
  return [record.declared & 0xff, ...body];
}

export function recordFromPayload(p: ByteSource): RecordData {
  if (p.length === 0 || (p[0] & 0xff) !== p.length - 1) {
    throw new Error("记录长度前缀不匹配");
  }
  return makeRecord(Array.from(p).slice(1));
}

export function parseCapabilities(record: RecordData): Capabilities {
  const d = recordBytes(record);
  if (d.length < 10) {
    throw new Error("能力描述符不足 10 字节");
  }
  return {
    sticks: d[0],
    triggers: d[1],
    motors: d[2],
    turbo: d[3],
    macros: d[4],
    changekey: d[5],
    lighting: d[6],
    engine: d[7],
    nfc: d[8],
    sensor: d[9],
    raw_hex: toHex(d),
  };
}

export function capabilityActiveSlots(caps: Capabilities): number[] {
  const out: number[] = [];
  for (let s = 0; s < 8; s++) {
    if (((caps.macros >>> s) & 1) !== 0) out.push(s);
  }
  return out;
}

export function hasStickSide(caps: Capabilities, side: number): boolean {
  return (caps.sticks & curveSideMask(side)) !== 0;
}

export function capabilityStickSides(caps: Capabilities): number[] {
  const out: number[] = [];
  for (let s = 0; s < 2; s++) {
    if (hasStickSide(caps, s)) out.push(s);
  }
  return out;
}

export function hasTriggerSide(caps: Capabilities, side: number): boolean {
  return (caps.triggers & curveSideMask(side)) !== 0;
}

export function capabilityTriggerSides(caps: Capabilities): number[] {
  const out: number[] = [];
  for (let s = 0; s < 2; s++) {
    if (hasTriggerSide(caps, s)) out.push(s);
  }
  return out;
}

export function capabilityMotorChannels(caps: Capabilities): number[] {
  const out: number[] = [];
  for (let c = 0; c < 4; c++) {
    if (((caps.motors >>> c) & 1) !== 0) out.push(c);
  }
  return out;
}

export function capabilityLightingZones(caps: Capabilities): number[] {
  const out: number[] = [];
  for (let z = 0; z < 4; z++) {
    if (((caps.lighting >>> z) & 1) !== 0) out.push(z);
  }
  return out;
}

export function hasPerSlotMacroLimits(caps: Capabilities): boolean {
  return (caps.engine & 0x02) !== 0;
}

export function hasRemapSelectList(caps: Capabilities): boolean {
  return (caps.changekey & 0x02) !== 0;
}

export function keyName(code: number): string | null {
  const found = KEY_NAMES.find(([c]) => c === code);
  return found ? found[1] : null;
}

export function keyCode(name: string): number | null {
  if (name === "LS") return 11;
  if (name === "RS") return 12;
  if (name === "BACK") return 93;
  const found = KEY_NAMES.find(([, n]) => n === name);
  if (found) return found[0];
  if (name.startsWith("KEY_")) {
    const rest = name.slice(4);
    if (/^[0-9]+$/.test(rest)) {
      const code = Number(rest);
      if (code >= 1 && code <= 255 && `KEY_${code}` === name) {
        return code;
      }
    }
  }
  return null;
}

export class Layout {
  readonly digital: Map<number, number>;
  readonly analog: Map<number, number>;
  readonly neutral: number;

  constructor(keys: readonly number[]) {
    if (keys.length === 0) {
      throw new Error("宏按键表为空、包含键码 0 或存在重复项");
    }
    const seen = new Set<number>();
    for (const k of keys) {
      if (!Number.isInteger(k) || k <= 0 || k > 255 || seen.has(k)) {
        throw new Error("宏按键表为空、包含键码 0 或存在重复项");
      }
      seen.add(k);
    }

    const digitalPairs: [number, number][] = [];
    const analogPairs: [number, number][] = [];
    let pos = 0;
    let neutral = 0;

    for (const key of keys) {
      if (key === 18 || key === 19) {
        if (pos > 20) {
          throw new Error("宏布局超过 24 位");
        }
        analogPairs.push([key, pos]);
        neutral = (neutral | (8 << pos)) >>> 0;
        pos += 4;
      } else {
        if (pos >= 24) {
          throw new Error("宏布局超过 24 位");
        }
        digitalPairs.push([key, pos]);
        pos += 1;
      }
    }

    // Match Rust BTreeMap<u8, u8> key ordering
    digitalPairs.sort((a, b) => a[0] - b[0]);
    analogPairs.sort((a, b) => a[0] - b[0]);
    this.digital = new Map(digitalPairs);
    this.analog = new Map(analogPairs);
    this.neutral = neutral;
  }

  mask(tokens: readonly string[]): number {
    if (tokens.length === 0) {
      throw new Error("请选择输出按键");
    }
    let mask = this.neutral;
    const seenSticks = new Map<number, number>();
    for (const rawTok of tokens) {
      const t = rawTok.trim().toUpperCase().replace(/-/g, "_");
      if (t === "WAIT") continue;
      const stick = t.startsWith("LS_")
        ? 18
        : t.startsWith("RS_")
          ? 19
          : null;
      if (stick !== null) {
        const dirName = t.slice(3);
        const dir = DIRECTIONS.indexOf(dirName);
        if (dir < 0) {
          throw new Error("无效摇杆方向");
        }
        const prev = seenSticks.get(stick);
        if (prev !== undefined && prev !== dir) {
          throw new Error("同一摇杆不能同时指向两个方向");
        }
        seenSticks.set(stick, dir);
        const shift = this.analog.get(stick);
        if (shift === undefined) {
          throw new Error("设备不支持该摇杆宏");
        }
        mask = ((mask & ~(15 << shift)) | (dir << shift)) >>> 0;
      } else {
        const key = keyCode(t);
        if (key === null) {
          throw new Error(`未知按键：${t}`);
        }
        const bit = this.digital.get(key);
        if (bit === undefined) {
          throw new Error("设备不支持该宏按键");
        }
        mask = (mask | (1 << bit)) >>> 0;
      }
    }
    return mask;
  }

  names(mask: number): string[] {
    const out: string[] = [];
    const byBit = Array.from(this.digital.entries()).sort(
      (a, b) => a[1] - b[1],
    );
    for (const [key, bit] of byBit) {
      if ((mask & (1 << bit)) !== 0) {
        out.push(keyName(key) ?? `KEY_${key}`);
      }
    }
    for (const [stick, shift] of this.analog.entries()) {
      const nib = (mask >>> shift) & 15;
      if (nib < 8) {
        out.push(`${stick === 18 ? "LS" : "RS"}_${DIRECTIONS[nib]}`);
      }
    }
    return out;
  }

  validate(p: ByteSource): void {
    if (p.length === 1 && (p[0] & 0xff) === 0) {
      return;
    }
    if (
      p.length < 8 ||
      p.length > 238 ||
      (p[0] & 0xff) !== p.length - 1 ||
      (p.length - 3) % 5 !== 0 ||
      (p[2] & 0x70) !== 0
    ) {
      throw new Error("宏记录结构或保留位无效");
    }
    let allowed = 0;
    for (const bit of this.digital.values()) {
      allowed = (allowed | (1 << bit)) >>> 0;
    }
    for (const shift of this.analog.values()) {
      allowed = (allowed | (15 << shift)) >>> 0;
    }
    for (let i = 3; i < p.length; i += 5) {
      const mask =
        ((p[i] & 0xff) |
          ((p[i + 1] & 0xff) << 8) |
          ((p[i + 2] & 0xff) << 16)) >>>
        0;
      if ((mask & ~allowed) !== 0) {
        throw new Error("宏记录使用未知位或无效摇杆方向");
      }
      for (const shift of this.analog.values()) {
        if (((mask >>> shift) & 15) > 8) {
          throw new Error("宏记录使用未知位或无效摇杆方向");
        }
      }
    }
  }
}

export function parseProgram(p: ByteSource, layout: Layout): Program {
  layout.validate(p);
  if (p.length === 1 && (p[0] & 0xff) === 0) {
    return { steps: [], loop_ms: 0, trigger: 0 };
  }
  const steps: Step[] = [];
  for (let i = 3; i < p.length; i += 5) {
    const mask =
      ((p[i] & 0xff) |
        ((p[i + 1] & 0xff) << 8) |
        ((p[i + 2] & 0xff) << 16)) >>>
      0;
    const ticks = (p[i + 3] & 0xff) | ((p[i + 4] & 0xff) << 8);
    steps.push({ mask, duration_ms: ticks * 5 });
  }
  return {
    steps,
    loop_ms: ((p[1] & 0xff) | (((p[2] & 15) & 0xff) << 8)) * 5,
    trigger: (p[2] & 0xff) >>> 7,
  };
}

export function encodeProgramWithLimit(
  prog: Program,
  layout: Layout,
  maxSteps = 42,
): number[] {
  const cap = Math.max(1, Math.min(47, Math.trunc(maxSteps)));
  if (
    prog.steps.length === 0 ||
    prog.steps.length > cap ||
    !Number.isInteger(prog.loop_ms) ||
    prog.loop_ms < 0 ||
    prog.loop_ms > 20000 ||
    prog.loop_ms % 5 !== 0 ||
    !Number.isInteger(prog.trigger) ||
    prog.trigger < 0 ||
    prog.trigger > 1
  ) {
    throw new Error("宏步骤数、循环时间或触发模式无效");
  }
  const ticks = prog.loop_ms / 5;
  const data: number[] = [
    (2 + prog.steps.length * 5) & 0xff,
    ticks & 0xff,
    (((ticks >>> 8) & 0xff) | ((prog.trigger & 1) << 7)) & 0xff,
  ];
  for (const step of prog.steps) {
    if (
      !Number.isInteger(step.mask) ||
      step.mask < 0 ||
      step.mask > 0xffffff ||
      !Number.isInteger(step.duration_ms) ||
      step.duration_ms < 0 ||
      step.duration_ms % 5 !== 0 ||
      step.duration_ms / 5 > 65535
    ) {
      throw new Error("宏步骤超出格式范围");
    }
    const stepTicks = step.duration_ms / 5;
    data.push(
      step.mask & 0xff,
      (step.mask >>> 8) & 0xff,
      (step.mask >>> 16) & 0xff,
      stepTicks & 0xff,
      (stepTicks >>> 8) & 0xff,
    );
  }
  layout.validate(data);
  return data;
}

export function encodeProgram(prog: Program, layout: Layout): number[] {
  return encodeProgramWithLimit(prog, layout, 42);
}

export function translateProgram(
  prog: Program,
  src: Layout,
  dst: Layout,
): Program {
  const outSteps: Step[] = [];
  for (const step of prog.steps) {
    let newMask = dst.neutral;
    for (const [key, srcBit] of src.digital.entries()) {
      if ((step.mask & (1 << srcBit)) !== 0) {
        const dstBit = dst.digital.get(key);
        if (dstBit === undefined) {
          throw new Error(
            `当前手柄不支持导入配置中的按键 ${keyName(key) ?? `KEY_${key}`}`,
          );
        }
        newMask = (newMask | (1 << dstBit)) >>> 0;
      }
    }
    for (const [stick, srcShift] of src.analog.entries()) {
      const nib = (step.mask >>> srcShift) & 15;
      if (nib < 8) {
        const dstShift = dst.analog.get(stick);
        if (dstShift === undefined) {
          throw new Error("当前手柄不支持导入配置中的摇杆方向宏");
        }
        newMask = ((newMask & ~(15 << dstShift)) | (nib << dstShift)) >>> 0;
      } else if (nib > 8) {
        throw new Error("导入配置包含无效摇杆方向");
      }
    }
    outSteps.push({
      mask: newMask,
      duration_ms: step.duration_ms,
    });
  }
  return {
    steps: outSteps,
    loop_ms: prog.loop_ms,
    trigger: prog.trigger,
  };
}

export function programSequence(prog: Program, layout: Layout): string {
  const groups: [string, number, number][] = [];
  for (const step of prog.steps) {
    const keys = layout.names(step.mask);
    if (keys.length === 0) {
      if (groups.length > 0) {
        groups[groups.length - 1][2] += step.duration_ms;
      } else {
        groups.push(["WAIT", step.duration_ms, 0]);
      }
    } else {
      groups.push([keys.join("+"), step.duration_ms, 0]);
    }
  }
  return groups.map(([k, h, g]) => `${k}:${h}/${g}`).join(", ");
}

export function claimsOPlus(snapshot: Snapshot): boolean {
  const devName =
    typeof snapshot.decoded?.device_name === "string"
      ? snapshot.decoded.device_name
      : "";
  return (
    isOPlusIdentity(snapshot.identity) ||
    nameClaimsOPlus(snapshot.address) ||
    nameClaimsOPlus(devName)
  );
}

function snapshotKeysRaw(snapshot: Snapshot, field: string): number[] {
  const arr = (snapshot.decoded as Record<string, unknown> | undefined)?.[field];
  if (!Array.isArray(arr)) {
    throw new Error(`缺少设备按键表 ${field}`);
  }
  return arr.map((n) => {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) {
      throw new Error("无效按键码");
    }
    return n;
  });
}

export function snapshotKeys(snapshot: Snapshot, field: string): number[] {
  try {
    const v = snapshotKeysRaw(snapshot, field);
    if (v.length > 0) return v;
  } catch (e) {
    if (!claimsOPlus(snapshot)) throw e;
  }
  if (claimsOPlus(snapshot)) {
    if (field === "all_keys") return [...DEFAULT_OPLUS_ALL_KEYS];
    if (field === "remap_keys" || field === "remap_targets") {
      return [...DEFAULT_OPLUS_REMAP_KEYS];
    }
    if (field === "macro_keys") return [...MACRO_KEYS];
  }
  return snapshotKeysRaw(snapshot, field);
}

export function snapshotCapabilities(snapshot: Snapshot): Capabilities {
  try {
    const c = parseCapabilities(snapshot.capabilities);
    const hasAnyFeature =
      (c.sticks & 0x03) !== 0 ||
      (c.triggers & 0x03) !== 0 ||
      c.macros !== 0 ||
      c.motors !== 0 ||
      c.changekey !== 0 ||
      c.lighting !== 0;
    if (!claimsOPlus(snapshot) || hasAnyFeature) {
      return c;
    }
  } catch (e) {
    if (!claimsOPlus(snapshot)) throw e;
  }
  return parseCapabilities(makeRecord(VERIFIED_137_CAPS));
}

export function hydrateOPlusDefaults(snapshot: Snapshot): Snapshot {
  if (!claimsOPlus(snapshot)) return snapshot;
  const caps = snapshotCapabilities(snapshot);
  try {
    const rawC = parseCapabilities(snapshot.capabilities);
    const anyBit =
      (rawC.sticks & 0x03) !== 0 ||
      (rawC.triggers & 0x03) !== 0 ||
      rawC.macros !== 0 ||
      rawC.motors !== 0 ||
      rawC.changekey !== 0 ||
      rawC.lighting !== 0;
    if (!anyBit) {
      snapshot.capabilities = makeRecord(VERIFIED_137_CAPS);
    }
  } catch {
    snapshot.capabilities = makeRecord(VERIFIED_137_CAPS);
  }
  if (!snapshot.decoded || typeof snapshot.decoded !== "object") {
    snapshot.decoded = {};
  }
  if (!snapshot.raw || typeof snapshot.raw !== "object") {
    snapshot.raw = {};
  }
  try {
    if (snapshotKeysRaw(snapshot, "all_keys").length === 0) throw new Error();
  } catch {
    snapshot.decoded.all_keys = [...DEFAULT_OPLUS_ALL_KEYS];
  }
  if (caps.changekey !== 0) {
    try {
      if (snapshotKeysRaw(snapshot, "remap_keys").length === 0) throw new Error();
    } catch {
      snapshot.decoded.remap_keys = [...DEFAULT_OPLUS_REMAP_KEYS];
    }
  }
  if (caps.macros !== 0) {
    try {
      new Layout(snapshotKeysRaw(snapshot, "macro_keys"));
    } catch {
      snapshot.decoded.macro_keys = [...MACRO_KEYS];
    }
  }
  if (caps.sticks !== 0) {
    let ok = false;
    try {
      ok = Boolean(snapshot.raw.sticks && recordPayload(snapshot.raw.sticks).length === 15);
    } catch {
      ok = false;
    }
    if (!ok) snapshot.raw.sticks = makeRecord(DEFAULT_OPLUS_STICKS_BODY);
  }
  if (caps.triggers !== 0) {
    let ok = false;
    try {
      ok = Boolean(snapshot.raw.triggers && recordPayload(snapshot.raw.triggers).length === 15);
    } catch {
      ok = false;
    }
    if (!ok) snapshot.raw.triggers = makeRecord(DEFAULT_OPLUS_TRIGGERS_BODY);
  }
  if (caps.motors !== 0) {
    let ok = false;
    try {
      ok = Boolean(snapshot.raw.motors && recordPayload(snapshot.raw.motors).length >= 5);
    } catch {
      ok = false;
    }
    if (!ok) snapshot.raw.motors = makeRecord(DEFAULT_OPLUS_MOTORS_BODY);
  }
  if (caps.changekey !== 0) {
    const rkLen = snapshotKeys(snapshot, "remap_keys").length;
    let ok = false;
    try {
      const p = snapshot.raw.remapping ? recordPayload(snapshot.raw.remapping) : null;
      ok = Boolean(p && ((p.length === 1 && p[0] === 0) || p.length === rkLen + 1));
    } catch {
      ok = false;
    }
    if (!ok) snapshot.raw.remapping = makeRecord(new Array<number>(rkLen).fill(0));
  }
  if (caps.lighting !== 0) {
    let ok = false;
    try {
      const p = snapshot.raw.lighting ? recordPayload(snapshot.raw.lighting) : null;
      ok = Boolean(p && p.length >= 7 && (p.length - 1) % 6 === 0);
    } catch {
      ok = false;
    }
    if (!ok) snapshot.raw.lighting = makeRecord(DEFAULT_OPLUS_LIGHTING_BODY);
  }
  let neutral = 0x88;
  try {
    neutral = new Layout(snapshotKeys(snapshot, "macro_keys")).neutral;
  } catch {
    neutral = 0x88;
  }
  const defaultMacroBody = [
    0x00,
    0x00,
    neutral & 0xff,
    (neutral >>> 8) & 0xff,
    (neutral >>> 16) & 0xff,
    0x00,
    0x00,
  ];
  for (const slot of capabilityActiveSlots(caps)) {
    const key = `macro_${slot}`;
    let ok = false;
    try {
      ok = Boolean(snapshot.raw[key] && recordPayload(snapshot.raw[key]).length >= 1);
    } catch {
      ok = false;
    }
    if (!ok) snapshot.raw[key] = makeRecord(defaultMacroBody);
  }
  return snapshot;
}

export function snapshotRecord(snapshot: Snapshot, key: string): number[] {
  const rec = snapshot.raw?.[key];
  const isOPlus = claimsOPlus(snapshot);
  if (rec) {
    try {
      const p = recordPayload(rec);
      if (!isOPlus) return p;
      let valid = true;
      if (key === "sticks" || key === "triggers") {
        valid = p.length === 15 && (p[0] & 0xff) === 14;
      } else if (key === "motors") {
        valid = p.length >= 5;
      } else if (key === "lighting") {
        valid = p.length >= 7 && (p.length - 1) % 6 === 0;
      } else if (key === "remapping") {
        const rkLen = snapshotKeys(snapshot, "remap_keys").length;
        valid = (p.length === 1 && p[0] === 0) || p.length === rkLen + 1;
      }
      if (valid) return p;
    } catch (e) {
      if (!isOPlus) throw e;
    }
  }
  if (isOPlus) {
    if (key === "sticks") return [14, ...DEFAULT_OPLUS_STICKS_BODY];
    if (key === "triggers") return [14, ...DEFAULT_OPLUS_TRIGGERS_BODY];
    if (key === "motors") return [8, ...DEFAULT_OPLUS_MOTORS_BODY];
    if (key === "remapping") {
      const rkLen = snapshotKeys(snapshot, "remap_keys").length;
      return [rkLen & 0xff, ...new Array<number>(rkLen).fill(0)];
    }
    if (key === "lighting") return [24, ...DEFAULT_OPLUS_LIGHTING_BODY];
    if (key.startsWith("macro_")) {
      const slotStr = key.slice(6);
      if (/^[0-9]+$/.test(slotStr) && Number(slotStr) < 8) {
        let neutral = 0x88;
        try {
          neutral = new Layout(snapshotKeys(snapshot, "macro_keys")).neutral;
        } catch {
          neutral = 0x88;
        }
        return [
          7,
          0x00,
          0x00,
          neutral & 0xff,
          (neutral >>> 8) & 0xff,
          (neutral >>> 16) & 0xff,
          0x00,
          0x00,
        ];
      }
    }
  }
  throw new Error(`缺少 ${key} 记录`);
}

export function snapshotActiveSlots(snapshot: Snapshot): number[] {
  try {
    return capabilityActiveSlots(snapshotCapabilities(snapshot));
  } catch {
    return [];
  }
}

export function snapshotRemapTargets(snapshot: Snapshot): number[] {
  const caps = snapshotCapabilities(snapshot);
  if (hasRemapSelectList(caps)) {
    return snapshotKeys(snapshot, "remap_targets");
  }
  return snapshotKeys(snapshot, "remap_keys");
}

export function snapshotSlotStepLimit(snapshot: Snapshot, slot: number): number {
  const limits = snapshot.decoded?.macro_limits;
  if (Array.isArray(limits)) {
    const lim = limits[slot];
    if (typeof lim === "number" && Number.isInteger(lim) && lim > 0) {
      return Math.max(1, Math.min(47, lim));
    }
  }
  return 42;
}

export function normalizePayload(key: string, p: ByteSource): number[] {
  if (key === "remapping" && p.length === 1 && p[0] === 0) {
    return [16, ...new Array<number>(16).fill(0)];
  }
  return Array.from(p);
}

export function normalizePayloadFor(
  snapshot: Snapshot,
  key: string,
  p: ByteSource,
): number[] {
  if (key === "remapping" && p.length === 1 && p[0] === 0) {
    let len = 16;
    try {
      len = snapshotKeys(snapshot, "remap_keys").length;
    } catch {
      len = 16;
    }
    return [len & 0xff, ...new Array<number>(len).fill(0)];
  }
  return Array.from(p);
}

export function normalizeAgainst(
  key: string,
  readback: ByteSource,
  reference: ByteSource,
): number[] {
  if (
    key === "remapping" &&
    readback.length === 1 &&
    readback[0] === 0 &&
    reference.length > 0
  ) {
    const count = reference[0] & 0xff;
    if (reference.length === count + 1) {
      return [reference[0] & 0xff, ...new Array<number>(count).fill(0)];
    }
  }
  return Array.from(readback);
}

function strictSupportTier(snapshot: Snapshot): SupportTier {
  if (effectiveGeneration(snapshot.identity) !== 2) {
    return "read_only";
  }
  let caps: Capabilities;
  try {
    caps = parseCapabilities(snapshot.capabilities);
  } catch {
    return "read_only";
  }
  if (
    (caps.sticks & 0x03) === 0 &&
    (caps.triggers & 0x03) === 0 &&
    caps.macros === 0 &&
    caps.motors === 0 &&
    caps.changekey === 0 &&
    caps.lighting === 0
  ) {
    return "read_only";
  }

  if (caps.sticks !== 0) {
    try {
      const rec = snapshot.raw?.sticks;
      if (!rec || recordPayload(rec).length !== 15) return "read_only";
    } catch {
      return "read_only";
    }
  }

  if (caps.triggers !== 0) {
    try {
      const rec = snapshot.raw?.triggers;
      if (!rec || recordPayload(rec).length !== 15) return "read_only";
    } catch {
      return "read_only";
    }
  }

  if (caps.macros !== 0) {
    const slots = capabilityActiveSlots(caps);
    if (slots.length === 0) return "read_only";
    let layout: Layout;
    try {
      const mk = snapshotKeysRaw(snapshot, "macro_keys");
      layout = new Layout(mk);
    } catch {
      return "read_only";
    }
    if (
      hasPerSlotMacroLimits(caps) &&
      !Array.isArray(snapshot.decoded?.macro_limits)
    ) {
      return "read_only";
    }
    for (const s of slots) {
      try {
        const rec = snapshot.raw?.[`macro_${s}`];
        if (!rec) return "read_only";
        layout.validate(recordPayload(rec));
      } catch {
        return "read_only";
      }
    }
  }

  if (caps.motors !== 0) {
    try {
      const rec = snapshot.raw?.motors;
      if (!rec || recordPayload(rec).length < 5) return "read_only";
    } catch {
      return "read_only";
    }
  }

  if (caps.changekey !== 0) {
    try {
      const rk = snapshotKeysRaw(snapshot, "remap_keys");
      const targets = hasRemapSelectList(caps)
        ? snapshotKeysRaw(snapshot, "remap_targets")
        : rk;
      if (rk.length === 0 || targets.length === 0) return "read_only";
      const rec = snapshot.raw?.remapping;
      if (!rec) return "read_only";
      const norm = normalizePayloadFor(snapshot, "remapping", recordPayload(rec));
      if (norm.length !== rk.length + 1) return "read_only";
    } catch {
      return "read_only";
    }
  }

  if (caps.lighting !== 0) {
    try {
      const rec = snapshot.raw?.lighting;
      if (!rec) return "read_only";
      const l = recordPayload(rec);
      if (l.length < 7 || (l.length - 1) % 6 !== 0) return "read_only";
    } catch {
      return "read_only";
    }
  }

  let mkMatchesVerified = false;
  try {
    mkMatchesVerified = bytesEqual(snapshotKeysRaw(snapshot, "macro_keys"), MACRO_KEYS);
  } catch {
    mkMatchesVerified = false;
  }
  let capsMatchVerified = false;
  try {
    capsMatchVerified = bytesEqual(
      recordBytes(snapshot.capabilities),
      VERIFIED_137_CAPS,
    );
  } catch {
    capsMatchVerified = false;
  }

  if (isVerified137(snapshot.identity) && mkMatchesVerified && capsMatchVerified) {
    return "verified";
  }
  return "compatible";
}

export function supportTier(snapshot: Snapshot): SupportTier {
  const strict = strictSupportTier(snapshot);
  if (strict !== "read_only") {
    return strict;
  }
  if (claimsOPlus(snapshot)) {
    return isVerified137(snapshot.identity) ? "verified" : "compatible";
  }
  return "read_only";
}

export function snapshotLayout(snapshot: Snapshot): Layout {
  if (supportTier(snapshot) === "read_only") {
    throw new Error("当前设备处于只读模式，不支持编辑宏布局");
  }
  try {
    return new Layout(snapshotKeys(snapshot, "macro_keys"));
  } catch (e) {
    if (claimsOPlus(snapshot)) {
      return new Layout(MACRO_KEYS);
    }
    throw e;
  }
}

export function validateRear(snapshot: Snapshot): void {
  if (supportTier(snapshot) === "read_only") {
    throw new Error("当前设备处于只读模式");
  }
  if (claimsOPlus(snapshot)) {
    return;
  }
  const caps = snapshotCapabilities(snapshot);
  if (caps.macros === 0) return;
  const spec = snapshotLayout(snapshot);
  for (const i of capabilityActiveSlots(caps)) {
    spec.validate(snapshotRecord(snapshot, `macro_${i}`));
  }
}

export function snapshotPreset(snapshot: Snapshot): Record<string, string> {
  if (supportTier(snapshot) === "read_only") {
    return {};
  }
  const slots = snapshotActiveSlots(snapshot);
  const out: Record<string, string> = {};
  if (
    (snapshot.identity.vid === "1005" || claimsOPlus(snapshot)) &&
    slots.length === 6 &&
    slots.every((v, idx) => v === idx)
  ) {
    LABELS_OPLUS_6.forEach((lbl, idx) => {
      out[String(idx)] = lbl;
    });
  } else {
    for (const s of slots) {
      out[String(s)] = SLOT_ORDER_8[s] || `槽 ${s + 1}`;
    }
  }
  return out;
}

export function encodeChangeWithLimit(
  change: Change,
  snapshot: Snapshot,
  maxSteps = 42,
): number[] {
  const layout = snapshotLayout(snapshot);
  const cap = Math.max(1, Math.min(47, Math.trunc(maxSteps)));
  let p: number[];
  if (change.kind === "record") {
    const raw = unhex(change.payload);
    layout.validate(raw);
    if (!(raw.length === 1 && raw[0] === 0) && (raw.length - 3) / 5 > cap) {
      throw new Error("宏步骤数超出该背键槽位上限");
    }
    p = raw;
  } else if (change.kind === "hold") {
    const keys = change.keys;
    if (keys.length === 0 || new Set(keys).size !== keys.length) {
      throw new Error("保持映射不能为空或重复");
    }
    if (
      (keys.includes(13) && keys.includes(14)) ||
      (keys.includes(15) && keys.includes(16))
    ) {
      throw new Error("不能同时选择相反十字键");
    }
    let mask = layout.neutral;
    for (const key of keys) {
      const bit = layout.digital.get(key);
      if (bit === undefined) {
        throw new Error("保持映射目标不受支持");
      }
      mask = (mask | (1 << bit)) >>> 0;
    }
    p = encodeProgramWithLimit(
      { steps: [{ mask, duration_ms: 0 }], loop_ms: 0, trigger: 0 },
      layout,
      cap,
    );
  } else {
    if (change.sequence.trim().length === 0) {
      throw new Error("请添加宏步骤");
    }
    const steps: Step[] = [];
    for (const rawGroup of change.sequence.split(",")) {
      const trimmed = rawGroup.trim();
      const colonIdx = trimmed.indexOf(":");
      const keysPart = colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
      const timingPart =
        colonIdx >= 0 ? trimmed.slice(colonIdx + 1) : "100/60";
      const slashIdx = timingPart.indexOf("/");
      const holdStr = slashIdx >= 0 ? timingPart.slice(0, slashIdx) : timingPart;
      const gapStr = slashIdx >= 0 ? timingPart.slice(slashIdx + 1) : "60";

      if (!/^[0-9]+$/.test(holdStr.trim())) {
        throw new Error("按住时间无效");
      }
      if (!/^[0-9]+$/.test(gapStr.trim())) {
        throw new Error("间隔时间无效");
      }
      const h = Number(holdStr.trim());
      const g = Number(gapStr.trim());
      if (
        h < 5 ||
        h > 10000 ||
        g < 0 ||
        g > 10000 ||
        h % 5 !== 0 ||
        g % 5 !== 0
      ) {
        throw new Error("按住 5–10000 ms、间隔 0–10000 ms，按 5 ms 步进");
      }
      const mask = layout.mask(keysPart.split("+"));
      steps.push({ mask, duration_ms: h });
      if (g > 0) {
        steps.push({ mask: layout.neutral, duration_ms: g });
      }
    }
    p = encodeProgramWithLimit(
      {
        steps,
        loop_ms: change.loop_ms ?? 0,
        trigger: change.trigger ?? 0,
      },
      layout,
      cap,
    );
  }
  layout.validate(p);
  return p;
}

export function encodeChange(change: Change, snapshot: Snapshot): number[] {
  return encodeChangeWithLimit(change, snapshot, 42);
}

export function encodeForSlot(
  change: Change,
  snapshot: Snapshot,
  slot: number,
): number[] {
  if (!snapshotActiveSlots(snapshot).includes(slot)) {
    throw new Error("该背键槽位在当前手柄上未启用");
  }
  return encodeChangeWithLimit(
    change,
    snapshot,
    snapshotSlotStepLimit(snapshot, slot),
  );
}

export function form(snapshot: Snapshot, slot: number): Change {
  if (!snapshotActiveSlots(snapshot).includes(slot)) {
    throw new Error("无效背键槽位");
  }
  const layout = snapshotLayout(snapshot);
  const p = snapshotRecord(snapshot, `macro_${slot}`);
  let program: Program;
  try {
    program = parseProgram(p, layout);
  } catch (e) {
    if (claimsOPlus(snapshot)) {
      return { kind: "record", payload: hexSpaced(p) };
    }
    throw e;
  }

  const sticksNeutral = Array.from(layout.analog.values()).every(
    (s) => ((program.steps[0]?.mask >>> s) & 15) === 8,
  );
  if (
    program.steps.length === 1 &&
    program.steps[0].duration_ms === 0 &&
    program.loop_ms === 0 &&
    program.trigger === 0 &&
    sticksNeutral
  ) {
    const keys: number[] = [];
    for (const [k, bit] of layout.digital.entries()) {
      if ((program.steps[0].mask & (1 << bit)) !== 0) {
        keys.push(k);
      }
    }
    if (keys.length > 0) {
      return { kind: "hold", keys };
    }
  }
  if (program.steps.length === 0) {
    return { kind: "record", payload: "00" };
  }
  const candidate: Change = {
    kind: "macro",
    sequence: programSequence(program, layout),
    loop_ms: program.loop_ms,
    trigger: program.trigger,
  };
  try {
    if (bytesEqual(encodeForSlot(candidate, snapshot, slot), p)) {
      return candidate;
    }
  } catch {
    // Fallback to lossless record preservation
  }
  return { kind: "record", payload: hexSpaced(p) };
}

export function validateCurveChannel(ch: ByteSource, maxProgress: number): void {
  if (ch.length !== 7) {
    throw new Error("曲线通道长度必须为 7 字节");
  }
  const inner = ch[0] & 0xff;
  const outerRaw = ch[1] & 0xff;
  if (inner > maxProgress || outerRaw > maxProgress) {
    throw new Error(`死区超出有效范围 0–${maxProgress}`);
  }
  if (inner + outerRaw >= maxProgress) {
    throw new Error("内死区与外死区之和必须小于最大行程，以保留有效触发区间");
  }
  const p1x = ch[2] & 0xff;
  const p2x = ch[4] & 0xff;
  if (p1x === 0 || p2x === 255 || p1x >= p2x) {
    throw new Error(
      "响应曲线控制点横坐标需满足 1 ≤ P1.x < P2.x ≤ 254，以保留固定端点 (0,0) 与 (255,255)",
    );
  }
}

function parseCurvePoint(val: unknown, name: string): [number, number] {
  if (!Array.isArray(val) || val.length !== 2) {
    throw new Error(`${name} 必须为两个 0–255 坐标`);
  }
  const [x, y] = val;
  if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > 255) {
    throw new Error(`${name}.x 超出 0–255`);
  }
  if (typeof y !== "number" || !Number.isInteger(y) || y < 0 || y > 255) {
    throw new Error(`${name}.y 超出 0–255`);
  }
  return [x, y];
}

export function validateRestoreRecord(
  snapshot: Snapshot,
  key: string,
  p: ByteSource,
): void {
  if (supportTier(snapshot) === "read_only") {
    throw new Error("当前设备处于只读模式，禁止写入配置");
  }
  const caps = snapshotCapabilities(snapshot);
  const record = recordFromPayload(p);

  if (key.startsWith("macro_")) {
    const slotStr = key.slice(6);
    if (!/^[0-9]+$/.test(slotStr)) {
      throw new Error("无效槽位");
    }
    const slot = Number(slotStr);
    if (!capabilityActiveSlots(caps).includes(slot)) {
      throw new Error("无效或未启用的背键槽位");
    }
    if (claimsOPlus(snapshot)) {
      if (
        !(p.length === 1 && (p[0] & 0xff) === 0) &&
        (p.length < 8 ||
          p.length > 238 ||
          (p[0] & 0xff) !== p.length - 1 ||
          (p.length - 3) % 5 !== 0)
      ) {
        throw new Error("宏记录结构无效");
      }
    } else {
      snapshotLayout(snapshot).validate(p);
    }
    return;
  }

  if (key === "sticks") {
    if ((caps.sticks & 0x03) === 0) {
      throw new Error("设备不支持摇杆配置");
    }
    const orig = snapshotRecord(snapshot, "sticks");
    if (orig.length !== 15 || p.length !== 15 || record.declared !== 14) {
      throw new Error("摇杆记录长度不匹配");
    }
    return;
  }

  if (key === "triggers") {
    if ((caps.triggers & 0x03) === 0) {
      throw new Error("设备不支持扳机配置");
    }
    const orig = snapshotRecord(snapshot, "triggers");
    if (orig.length !== 15 || p.length !== 15 || record.declared !== 14) {
      throw new Error("扳机记录长度不匹配");
    }
    return;
  }

  if (key === "motors") {
    if (caps.motors === 0) {
      throw new Error("设备不支持振动配置");
    }
    const orig = snapshotRecord(snapshot, "motors");
    if (orig.length < 5 || p.length !== orig.length) {
      throw new Error("马达记录长度不匹配");
    }
    return;
  }

  if (key === "remapping") {
    if (caps.changekey === 0) {
      throw new Error("设备不支持标准按键改键");
    }
    const sources = snapshotKeys(snapshot, "remap_keys");
    if (record.declared !== sources.length) {
      throw new Error("标准映射长度与按键表不匹配");
    }
    return;
  }

  if (key === "lighting") {
    if (caps.lighting === 0) {
      throw new Error("设备不支持灯光配置");
    }
    const orig = snapshotRecord(snapshot, "lighting");
    if (
      orig.length < 7 ||
      (orig.length - 1) % 6 !== 0 ||
      p.length !== orig.length
    ) {
      throw new Error("灯光记录长度不匹配");
    }
    return;
  }

  throw new Error("不允许写入该记录");
}

export function validateRecord(
  snapshot: Snapshot,
  key: string,
  p: ByteSource,
): void {
  if (supportTier(snapshot) === "read_only") {
    throw new Error("当前设备处于只读模式，禁止写入配置");
  }
  const caps = snapshotCapabilities(snapshot);
  const record = recordFromPayload(p);

  if (key.startsWith("macro_")) {
    const slotStr = key.slice(6);
    if (!/^[0-9]+$/.test(slotStr)) {
      throw new Error("无效槽位");
    }
    const slot = Number(slotStr);
    if (!capabilityActiveSlots(caps).includes(slot)) {
      throw new Error("无效或未启用的背键槽位");
    }
    snapshotLayout(snapshot).validate(p);
    if (
      !(p.length === 1 && p[0] === 0) &&
      (p.length - 3) / 5 > snapshotSlotStepLimit(snapshot, slot)
    ) {
      throw new Error("宏步骤数超出该槽位上限");
    }
    return;
  }

  if (key === "sticks") {
    if ((caps.sticks & 0x03) === 0) {
      throw new Error("设备不支持摇杆配置");
    }
    const orig = snapshotRecord(snapshot, "sticks");
    if (orig.length !== 15 || p.length !== 15 || record.declared !== 14) {
      throw new Error("摇杆记录长度不匹配");
    }
    const arr = Array.from(p);
    for (let side = 0; side < 2; side++) {
      if (hasStickSide(caps, side)) {
        const off = 1 + side * 7;
        if (!bytesEqual(arr.slice(off, off + 7), orig.slice(off, off + 7))) {
          validateCurveChannel(arr.slice(off, off + 7), STICK_MAX_PROGRESS);
        }
      }
    }
    return;
  }

  if (key === "triggers") {
    if ((caps.triggers & 0x03) === 0) {
      throw new Error("设备不支持扳机配置");
    }
    const orig = snapshotRecord(snapshot, "triggers");
    if (orig.length !== 15 || p.length !== 15 || record.declared !== 14) {
      throw new Error("扳机记录长度不匹配");
    }
    const arr = Array.from(p);
    for (let side = 0; side < 2; side++) {
      if (hasTriggerSide(caps, side)) {
        const off = 1 + side * 7;
        if (!bytesEqual(arr.slice(off, off + 7), orig.slice(off, off + 7))) {
          validateCurveChannel(arr.slice(off, off + 7), TRIGGER_MAX_PROGRESS);
        }
      }
    }
    return;
  }

  if (key === "motors") {
    if (caps.motors === 0) {
      throw new Error("设备不支持振动配置");
    }
    const orig = snapshotRecord(snapshot, "motors");
    if (orig.length < 5 || p.length !== orig.length) {
      throw new Error("马达记录长度不匹配");
    }
    return;
  }

  if (key === "remapping") {
    if (caps.changekey === 0) {
      throw new Error("设备不支持标准按键改键");
    }
    const sources = snapshotKeys(snapshot, "remap_keys");
    const targets = snapshotRemapTargets(snapshot);
    if (record.declared !== sources.length) {
      throw new Error("标准映射长度与按键表不匹配");
    }
    const bytes = recordBytes(record);
    if (bytes.some((v) => v !== 0 && !targets.includes(v))) {
      throw new Error("标准映射包含不支持的目标按键");
    }
    return;
  }

  if (key === "lighting") {
    if (caps.lighting === 0) {
      throw new Error("设备不支持灯光配置");
    }
    const orig = snapshotRecord(snapshot, "lighting");
    if (
      orig.length < 7 ||
      (orig.length - 1) % 6 !== 0 ||
      p.length !== orig.length
    ) {
      throw new Error("灯光记录长度不匹配");
    }
    return;
  }

  throw new Error("不允许写入该记录");
}

export function boundary(
  snapshot: Snapshot,
  key: string,
  original: ByteSource,
  target: ByteSource,
): void {
  boundaryForKind(snapshot, "save", key, original, target);
}

export function boundaryForKind(
  snapshot: Snapshot,
  kind: string,
  key: string,
  original: ByteSource,
  target: ByteSource,
): void {
  if (kind === "undo" || kind === "recovery") {
    validateRestoreRecord(snapshot, key, target);
  } else {
    validateRecord(snapshot, key, target);
  }
  if (
    key.startsWith("macro_") &&
    ((original.length === 1 && original[0] === 0) ||
      (target.length === 1 && target[0] === 0))
  ) {
    throw new Error("空背键记录的写入与恢复尚未验证");
  }
  if (key === "sticks") {
    const caps = snapshotCapabilities(snapshot);
    if (
      original.length !== 15 ||
      target.length !== 15 ||
      (original[0] & 0xff) !== 14 ||
      (target[0] & 0xff) !== 14
    ) {
      throw new Error("摇杆记录长度不匹配");
    }
    const origArr = Array.from(original);
    const targArr = Array.from(target);
    for (let side = 0; side < 2; side++) {
      const off = 1 + side * 7;
      if (
        !hasStickSide(caps, side) &&
        !bytesEqual(origArr.slice(off, off + 7), targArr.slice(off, off + 7))
      ) {
        throw new Error("不能修改未启用的摇杆通道");
      }
      if ((origArr[off + 6] & 0xf8) !== (targArr[off + 6] & 0xf8)) {
        throw new Error("不能修改摇杆的未知标志位");
      }
    }
  }
  if (key === "triggers") {
    const caps = snapshotCapabilities(snapshot);
    if (
      original.length !== 15 ||
      target.length !== 15 ||
      (original[0] & 0xff) !== 14 ||
      (target[0] & 0xff) !== 14
    ) {
      throw new Error("扳机记录长度不匹配");
    }
    const origArr = Array.from(original);
    const targArr = Array.from(target);
    for (let side = 0; side < 2; side++) {
      const off = 1 + side * 7;
      if (
        !hasTriggerSide(caps, side) &&
        !bytesEqual(origArr.slice(off, off + 7), targArr.slice(off, off + 7))
      ) {
        throw new Error("不能修改未启用的扳机通道");
      }
      if ((origArr[off + 6] & 0xff) !== (targArr[off + 6] & 0xff)) {
        throw new Error("不能修改扳机的未知标志位");
      }
    }
  }
  if (key === "motors") {
    const caps = snapshotCapabilities(snapshot);
    if (
      original.length < 5 ||
      target.length !== original.length ||
      !bytesEqual(Array.from(original).slice(5), Array.from(target).slice(5))
    ) {
      throw new Error("不能修改电机的未知字段");
    }
    for (let ch = 0; ch < 4; ch++) {
      if (
        (caps.motors & (1 << ch)) === 0 &&
        (original[1 + ch] & 0xff) !== (target[1 + ch] & 0xff)
      ) {
        throw new Error("不能修改未启用的电机通道");
      }
    }
  }
  if (key === "lighting") {
    const caps = snapshotCapabilities(snapshot);
    if (
      original.length < 7 ||
      (original.length - 1) % 6 !== 0 ||
      target.length !== original.length
    ) {
      throw new Error("灯光记录不完整");
    }
    for (let i = 1; i < original.length; i++) {
      const zone = Math.floor((i - 1) / 6);
      const rgb = (i - 1) % 6 < 3;
      const zoneSupported = zone < 4 && (caps.lighting & (1 << zone)) !== 0;
      if (
        (original[i] & 0xff) !== (target[i] & 0xff) &&
        (!rgb || !zoneSupported)
      ) {
        throw new Error("不能修改灯光的未知字段或未支持区域");
      }
    }
  }
}

function roundTiesEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5 - 1e-12) return floor;
  if (diff > 0.5 + 1e-12) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function desiredSetting(
  snapshot: Snapshot,
  feature: string,
  change: Record<string, any>,
): number[] {
  if (supportTier(snapshot) === "read_only") {
    throw new Error("当前设备处于只读模式，禁止修改配置");
  }
  const caps = snapshotCapabilities(snapshot);
  const orig = normalizePayloadFor(
    snapshot,
    feature,
    snapshotRecord(snapshot, feature),
  );
  const p = [...orig];

  if (feature === "sticks") {
    if ((caps.sticks & 0x03) === 0 || p.length !== 15 || (p[0] & 0xff) !== 14) {
      throw new Error("摇杆记录不可写或不完整");
    }
    const side = change.side;
    if (typeof side !== "number" || !Number.isInteger(side) || side < 0 || side > 1) {
      throw new Error("无效摇杆通道");
    }
    if (!hasStickSide(caps, side)) {
      throw new Error("该摇杆通道未在设备上启用");
    }
    const inner = change.inner;
    const outerRaw = change.outer_raw;
    if (
      typeof inner !== "number" ||
      !Number.isInteger(inner) ||
      inner < 0 ||
      inner > STICK_MAX_PROGRESS
    ) {
      throw new Error("摇杆中心死区应为 0–100");
    }
    if (
      typeof outerRaw !== "number" ||
      !Number.isInteger(outerRaw) ||
      outerRaw < 0 ||
      outerRaw > STICK_MAX_PROGRESS
    ) {
      throw new Error("摇杆外死区边距应为 0–100");
    }
    const point1 = parseCurvePoint(change.point1, "point1");
    const point2 = parseCurvePoint(change.point2, "point2");
    if (typeof change.invert_x !== "boolean") {
      throw new Error("缺少 invert_x 布尔值");
    }
    if (typeof change.invert_y !== "boolean") {
      throw new Error("缺少 invert_y 布尔值");
    }
    if (typeof change.swap !== "boolean") {
      throw new Error("缺少 swap 布尔值");
    }
    const off = 1 + side * 7;
    const preservedFlags = orig[off + 6] & 0xf8;
    const lowFlags =
      (change.invert_x ? FLAG_INVERT_X : 0) |
      (change.invert_y ? FLAG_INVERT_Y : 0) |
      (change.swap ? FLAG_SWAP : 0);
    const ch = [
      inner,
      outerRaw,
      point1[0],
      point1[1],
      point2[0],
      point2[1],
      preservedFlags | lowFlags,
    ];
    validateCurveChannel(ch, STICK_MAX_PROGRESS);
    for (let i = 0; i < 7; i++) {
      p[off + i] = ch[i];
    }
  } else if (feature === "triggers") {
    if ((caps.triggers & 0x03) === 0 || p.length !== 15 || (p[0] & 0xff) !== 14) {
      throw new Error("扳机记录不可写或不完整");
    }
    const side = change.side;
    if (typeof side !== "number" || !Number.isInteger(side) || side < 0 || side > 1) {
      throw new Error("无效扳机通道");
    }
    if (!hasTriggerSide(caps, side)) {
      throw new Error("该扳机通道未在设备上启用");
    }
    const inner = change.inner;
    const outerRaw = change.outer_raw;
    if (
      typeof inner !== "number" ||
      !Number.isInteger(inner) ||
      inner < 0 ||
      inner > TRIGGER_MAX_PROGRESS
    ) {
      throw new Error("扳机起始死区应为 0–200");
    }
    if (
      typeof outerRaw !== "number" ||
      !Number.isInteger(outerRaw) ||
      outerRaw < 0 ||
      outerRaw > TRIGGER_MAX_PROGRESS
    ) {
      throw new Error("扳机末端死区边距应为 0–200");
    }
    const point1 = parseCurvePoint(change.point1, "point1");
    const point2 = parseCurvePoint(change.point2, "point2");
    const off = 1 + side * 7;
    const ch = [
      inner,
      outerRaw,
      point1[0],
      point1[1],
      point2[0],
      point2[1],
      orig[off + 6] & 0xff,
    ];
    validateCurveChannel(ch, TRIGGER_MAX_PROGRESS);
    for (let i = 0; i < 7; i++) {
      p[off + i] = ch[i];
    }
  } else if (feature === "motors") {
    if (caps.motors === 0 || p.length < 5) {
      throw new Error("马达记录不可写或不完整");
    }
    if (change.channel !== undefined && change.channel !== null) {
      const ch = change.channel;
      if (
        typeof ch !== "number" ||
        !Number.isInteger(ch) ||
        ch < 0 ||
        ch >= 4 ||
        (caps.motors & (1 << ch)) === 0
      ) {
        throw new Error("该振动通道未在设备上启用");
      }
      const lvl = change.level;
      if (
        typeof lvl !== "number" ||
        !Number.isInteger(lvl) ||
        lvl < 0 ||
        lvl > 100
      ) {
        throw new Error("强度应为 0–100");
      }
      p[1 + ch] = roundTiesEven((lvl * 255) / 100);
    } else {
      const values = change.levels;
      if (!Array.isArray(values) || values.length !== 4) {
        throw new Error("需要四个强度值");
      }
      for (let i = 0; i < 4; i++) {
        const n = values[i];
        if (n === null || n === undefined) {
          p[i + 1] = orig[i + 1];
          continue;
        }
        if (
          typeof n !== "number" ||
          !Number.isInteger(n) ||
          n < 0 ||
          n > 100
        ) {
          throw new Error("强度应为 0–100");
        }
        if ((caps.motors & (1 << i)) !== 0) {
          p[i + 1] = roundTiesEven((n * 255) / 100);
        } else {
          p[i + 1] = orig[i + 1];
        }
      }
    }
  } else if (feature === "remapping") {
    if (caps.changekey === 0) {
      throw new Error("设备不支持标准按键改键");
    }
    const sources = snapshotKeys(snapshot, "remap_keys");
    const targets = snapshotRemapTargets(snapshot);
    if (p.length !== sources.length + 1) {
      throw new Error("标准映射记录不完整");
    }
    const source = change.source;
    const target = change.target;
    if (
      typeof source !== "number" ||
      !Number.isInteger(source) ||
      source < 0 ||
      source > 255
    ) {
      throw new Error("无效来源键");
    }
    if (
      typeof target !== "number" ||
      !Number.isInteger(target) ||
      target < 0 ||
      target > 255
    ) {
      throw new Error("无效目标键");
    }
    const idx = sources.indexOf(source);
    if (idx < 0) {
      throw new Error("来源键不支持");
    }
    if (source === 93 || source === 94) {
      if (target !== 0 && target !== source) {
        throw new Error(
          "固件不支持将 Back / Start 作为改键来源（仅允许恢复默认或作为其他键的目标）",
        );
      }
      p[idx + 1] = 0;
    } else {
      if (target !== 0 && target !== source && !targets.includes(target)) {
        throw new Error("目标键不支持");
      }
      p[idx + 1] = target === 0 || target === source ? 0 : target;
    }
  } else if (feature === "lighting") {
    const zone = change.zone;
    if (
      typeof zone !== "number" ||
      !Number.isInteger(zone) ||
      zone < 0 ||
      zone >= 4
    ) {
      throw new Error("无效灯区");
    }
    if (p.length < 7 || (p.length - 1) % 6 !== 0) {
      throw new Error("灯光记录不完整");
    }
    const zoneCount = (p.length - 1) / 6;
    if (zone >= zoneCount || (caps.lighting & (1 << zone)) === 0) {
      throw new Error("灯区不支持");
    }
    const text = change.rgb;
    if (typeof text !== "string" || !text.startsWith("#") || text.length !== 7) {
      throw new Error("颜色应为 #RRGGBB");
    }
    const rgb = unhex(text.slice(1));
    p[1 + zone * 6] = rgb[0];
    p[2 + zone * 6] = rgb[1];
    p[3 + zone * 6] = rgb[2];
  } else {
    throw new Error("未知设置");
  }

  validateRecord(snapshot, feature, p);
  return p;
}

export function exportProfile(
  snapshot: Snapshot,
  labels: Record<string, string> = {},
): Record<string, unknown> {
  validateRear(snapshot);
  const active = snapshotActiveSlots(snapshot);
  if (active.length === 0) {
    throw new Error("当前手柄没有可导出的背键宏槽");
  }
  const slots = active.map((i) => ({
    slot: i,
    payload: hexSpaced(snapshotRecord(snapshot, `macro_${i}`)),
    label: labels[String(i)] ?? "",
  }));
  return {
    format: "oplus-rear-v1",
    identity: normalizeIdentity(snapshot.identity),
    macro_keys: snapshotKeys(snapshot, "macro_keys"),
    slots,
  };
}

function decodeUtf8NoBom(data: Uint8Array | string, maxBytes: number, errMsg: string): string {
  let bytes: Uint8Array;
  if (typeof data === "string") {
    bytes = new TextEncoder().encode(data);
  } else {
    bytes = data;
  }
  if (bytes.length > maxBytes) {
    throw new Error(errMsg);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("配置必须为 UTF-8");
  }
  return text.startsWith("\ufeff") ? text.slice(1) : text;
}

export function importProfile(
  data: Uint8Array | string,
  snapshot: Snapshot,
): Record<number, Change> {
  if (supportTier(snapshot) === "read_only") {
    throw new Error("当前设备为只读模式，无法导入背键配置");
  }
  const text = decodeUtf8NoBom(data, 65536, "配置文件超过 64 KiB");
  let v: any;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 解析失败：${String(e)}`);
  }
  if (!v || typeof v !== "object") {
    throw new Error("不支持的背键配置文件格式");
  }

  if (v.format === undefined) {
    if (!v.address || !v.identity || !v.raw || !v.capabilities) {
      throw new Error("不支持的背键配置文件格式");
    }
    const backup: Snapshot = {
      address: String(v.address),
      identity: normalizeIdentity(v.identity),
      raw: v.raw,
      decoded: v.decoded ?? {},
      capabilities: v.capabilities,
      errors: Array.isArray(v.errors) ? v.errors : [],
    };
    v = exportProfile(backup, {});
  }

  if (v.format !== "oplus-rear-v1") {
    throw new Error("不支持的背键配置文件格式");
  }

  const identity: Identity = normalizeIdentity(v.identity);
  if (
    effectiveGeneration(identity) !== 2 &&
    !isOPlusIdentity(identity) &&
    !claimsOPlus(snapshot)
  ) {
    throw new Error("导入配置非第二代协议格式");
  }
  if (!Array.isArray(v.macro_keys)) {
    throw new Error("缺少源文件宏按键表");
  }
  const srcMacroKeys = v.macro_keys.map((n: unknown) => {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) {
      throw new Error("源文件宏按键码无效");
    }
    return n;
  });
  const srcLayout = new Layout(srcMacroKeys);
  const dstMacroKeys = snapshotKeys(snapshot, "macro_keys");
  const dstLayout = snapshotLayout(snapshot);
  const activeSlots = snapshotActiveSlots(snapshot);

  if (!Array.isArray(v.slots) || v.slots.length < 1 || v.slots.length > 8) {
    throw new Error("配置必须包含 1–8 个背键槽");
  }

  const seen = new Set<number>();
  const changes: Record<number, Change> = {};

  for (const row of v.slots) {
    const slot = row?.slot;
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot >= 8) {
      throw new Error("无效槽位");
    }
    if (seen.has(slot)) {
      throw new Error("重复槽位");
    }
    seen.add(slot);
    if (!activeSlots.includes(slot)) {
      throw new Error(`当前手柄不存在背键槽位 ${slot + 1}`);
    }
    if (typeof row?.payload !== "string") {
      throw new Error("缺少宏记录");
    }
    const srcBytes = unhex(row.payload);
    srcLayout.validate(srcBytes);
    const currentBytes = snapshotRecord(snapshot, `macro_${slot}`);

    if (srcBytes.length === 1 && srcBytes[0] === 0) {
      if (!(currentBytes.length === 1 && currentBytes[0] === 0)) {
        throw new Error("空槽清空尚未验证");
      }
      continue;
    }

    const limit = snapshotSlotStepLimit(snapshot, slot);
    let dstBytes: number[];
    if (bytesEqual(srcMacroKeys, dstMacroKeys)) {
      dstLayout.validate(srcBytes);
      const prog = parseProgram(srcBytes, dstLayout);
      if (prog.steps.length > limit) {
        throw new Error(`槽位 ${slot + 1} 的宏步数超出当前手柄上限（${limit} 步）`);
      }
      dstBytes = srcBytes;
    } else {
      const srcProg = parseProgram(srcBytes, srcLayout);
      const dstProg = translateProgram(srcProg, srcLayout, dstLayout);
      dstBytes = encodeProgramWithLimit(dstProg, dstLayout, limit);
    }

    if (!bytesEqual(dstBytes, currentBytes)) {
      changes[slot] = {
        kind: "record",
        payload: hexSpaced(dstBytes),
      };
    }
  }

  return changes;
}

export function diagnosticBundle(snapshot: Snapshot): Record<string, unknown> {
  const tier = supportTier(snapshot);
  let caps: Capabilities | null = null;
  try {
    caps = snapshotCapabilities(snapshot);
  } catch {
    caps = null;
  }
  return {
    format: "oplus-diagnostic-v1",
    app_version: APP_VERSION,
    address: snapshot.address,
    support_tier: tier,
    effective_generation: effectiveGeneration(snapshot.identity),
    verified_137: isVerified137(snapshot.identity),
    device_name: snapshot.decoded?.device_name ?? null,
    identity: normalizeIdentity(snapshot.identity),
    capabilities_raw: snapshot.capabilities,
    capabilities_decoded: caps
      ? {
          sticks: caps.sticks,
          stick_sides: capabilityStickSides(caps),
          triggers: caps.triggers,
          trigger_sides: capabilityTriggerSides(caps),
          motors: caps.motors,
          motor_channels: capabilityMotorChannels(caps),
          turbo: caps.turbo,
          macros: caps.macros,
          active_slots: capabilityActiveSlots(caps),
          changekey: caps.changekey,
          has_remap_select_list: hasRemapSelectList(caps),
          lighting: caps.lighting,
          lighting_zones: capabilityLightingZones(caps),
          engine: caps.engine,
          has_per_slot_macro_limits: hasPerSlotMacroLimits(caps),
          nfc: caps.nfc,
          sensor: caps.sensor,
        }
      : null,
    decoded: snapshot.decoded,
    raw: snapshot.raw,
    errors: snapshot.errors ?? [],
  };
}

// ============================================================================
// Keymap Store Validation, Bridge Encoding & 0.4.0 Profile Migration
// ============================================================================

const CANONICAL_PAD_BUTTONS: readonly PadButton[] = [
  "A",
  "B",
  "X",
  "Y",
  "LB",
  "RB",
  "Back",
  "Start",
  "LS",
  "RS",
  "Up",
  "Down",
  "Left",
  "Right",
  "LT",
  "RT",
  "LXNeg",
  "LXPos",
  "LYNeg",
  "LYPos",
  "RXNeg",
  "RXPos",
  "RYNeg",
  "RYPos",
];

const CANONICAL_OUTPUT_TOKENS: readonly string[] = [
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
  "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
  "Key0", "Key1", "Key2", "Key3", "Key4", "Key5", "Key6", "Key7", "Key8", "Key9",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F9", "F10", "F11", "F12",
  "LShift", "RShift", "LCtrl", "RCtrl", "LAlt", "RAlt", "LWin", "RWin",
  "Space", "Enter", "Escape", "Tab", "Backspace", "CapsLock", "Insert", "Delete",
  "Home", "End", "PageUp", "PageDown", "Up", "Down", "Left", "Right",
  "Grave", "Minus", "Equals", "LeftBracket", "RightBracket", "Backslash",
  "Semicolon", "Apostrophe", "Comma", "Period", "Slash",
  "Num0", "Num1", "Num2", "Num3", "Num4", "Num5", "Num6", "Num7", "Num8", "Num9",
  "NumMultiply", "NumAdd", "NumSubtract", "NumDecimal", "NumDivide", "NumEnter",
  "MouseLeft", "MouseRight", "MouseMiddle", "MouseX1", "MouseX2", "WheelUp", "WheelDown",
];

let localIdSeq = 0;
function makeLocalId(prefix: string): string {
  localIdSeq += 1;
  return `${prefix}-${Date.now()}-${localIdSeq}`;
}

export function parsePadButton(raw: unknown): PadButton | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const legacyMap: Record<string, PadButton> = {
    "LX-": "LXNeg",
    "LX+": "LXPos",
    "LY-": "LYNeg",
    "LY+": "LYPos",
    "RX-": "RXNeg",
    "RX+": "RXPos",
    "RY-": "RYNeg",
    "RY+": "RYPos",
  };
  if (legacyMap[s]) return legacyMap[s];
  return CANONICAL_PAD_BUTTONS.find((b) => b === s) ?? null;
}

export function parseOutputToken(raw: unknown): OutputToken {
  if (typeof raw !== "string") {
    throw new Error("输出按键格式无效");
  }
  const s = raw.trim();
  if (s.toLowerCase() === "f8") {
    throw new Error("F8 为全局紧急停止保留键，禁止作为映射输出");
  }
  const hit = CANONICAL_OUTPUT_TOKENS.find(
    (t) => t.toLowerCase() === s.toLowerCase(),
  );
  if (hit) return hit;

  const lower = s.toLowerCase();
  if (/^[0-9]$/.test(lower)) return `Key${lower}`;
  if (lower === "shift") return "LShift";
  if (lower === "ctrl" || lower === "control") return "LCtrl";
  if (lower === "alt") return "LAlt";
  if (lower === "win" || lower === "meta" || lower === "super") return "LWin";
  throw new Error(`不支持的输出键鼠按键：${s}`);
}

export function bridgeHoldChange(
  slot: number,
  trigger: readonly PadButton[],
  snapshot: Snapshot,
): Change {
  if (supportTier(snapshot) === "read_only") {
    throw new Error("当前手柄为只读模式，无法写入背键暗号");
  }
  if (!snapshotActiveSlots(snapshot).includes(slot)) {
    throw new Error("当前手柄不存在该背键槽位");
  }
  if (trigger.length < 1 || trigger.length > 4) {
    throw new Error("背键暗号需包含 1–4 个板载数字按键");
  }
  const keys: number[] = [];
  for (const b of trigger) {
    const parsed = parsePadButton(b);
    if (!parsed) {
      throw new Error("无效手柄按键");
    }
    const code = padButtonToOnboardKey(parsed);
    if (code === null) {
      throw new Error("触发组合包含模拟摇杆阈值，无法编码为板载数字按键按住映射");
    }
    if (!keys.includes(code)) {
      keys.push(code);
    }
  }
  const change: Change = { kind: "hold", keys };
  encodeForSlot(change, snapshot, slot);
  return change;
}

function validateKbStep(raw: any): KbStep {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.keys)) {
    throw new Error("宏步骤格式无效");
  }
  if (raw.keys.length > 6) {
    throw new Error("单步最多同时包含 6 个键鼠按键");
  }
  const dedup: OutputToken[] = [];
  for (const k of raw.keys) {
    const tok = parseOutputToken(k);
    if (dedup.includes(tok)) {
      throw new Error("单步中包含重复的输出按键");
    }
    dedup.push(tok);
  }
  if (dedup.includes("WheelUp") && dedup.includes("WheelDown")) {
    throw new Error("同一宏步骤不能同时向上和向下滚动滚轮");
  }
  const holdMs = raw.hold_ms;
  const gapMs = raw.gap_ms ?? 0;
  if (
    typeof holdMs !== "number" ||
    !Number.isInteger(holdMs) ||
    holdMs < 0 ||
    holdMs > 30000 ||
    typeof gapMs !== "number" ||
    !Number.isInteger(gapMs) ||
    gapMs < 0 ||
    gapMs > 30000
  ) {
    throw new Error("按住时间与间隔时间不能超过 30000 ms");
  }
  if (dedup.length === 0) {
    if (holdMs === 0 && gapMs === 0) {
      throw new Error("纯等待步骤的时间不能为 0 ms");
    }
  } else if (dedup.every((k) => k === "WheelUp" || k === "WheelDown")) {
    // Pure wheel pulse step: hold_ms === 0 allowed
  } else if (holdMs === 0) {
    throw new Error("包含键盘或鼠标按键的步骤，按住时间必须为 1–30000 ms");
  }
  return {
    keys: dedup,
    hold_ms: holdMs,
    gap_ms: gapMs,
  };
}

function validateKeymapAction(raw: any): KeymapAction {
  if (!raw || typeof raw !== "object") {
    throw new Error("动作格式无效");
  }
  if (raw.kind === "hold") {
    if (!Array.isArray(raw.keys) || raw.keys.length < 1 || raw.keys.length > 6) {
      throw new Error("按住映射需包含 1–6 个键鼠按键");
    }
    const dedup: OutputToken[] = [];
    for (const k of raw.keys) {
      const tok = parseOutputToken(k);
      if (dedup.includes(tok)) {
        throw new Error("按住映射包含重复按键");
      }
      dedup.push(tok);
    }
    if (dedup.includes("WheelUp") && dedup.includes("WheelDown")) {
      throw new Error("不能同时映射滚轮上滚与下滚");
    }
    return { kind: "hold", keys: dedup };
  }

  if (raw.kind === "macro") {
    if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > 64) {
      throw new Error("键盘顺序宏需包含 1–64 个步骤");
    }
    const mode = raw.trigger_mode;
    if (mode !== "once" && mode !== "hold_loop" && mode !== "toggle_loop") {
      throw new Error("无效循环触发模式");
    }
    const loopMs = raw.loop_ms ?? 0;
    if (
      typeof loopMs !== "number" ||
      !Number.isInteger(loopMs) ||
      loopMs < 0 ||
      loopMs > 30000
    ) {
      throw new Error("循环间隔不能超过 30000 ms");
    }
    let totalCycleMs = loopMs;
    const steps: KbStep[] = raw.steps.map((s: any) => {
      const clean = validateKbStep(s);
      totalCycleMs += clean.hold_ms + clean.gap_ms;
      return clean;
    });
    if ((mode === "hold_loop" || mode === "toggle_loop") && totalCycleMs === 0) {
      throw new Error("循环宏单轮总耗时不能为 0 ms（请设置间隔时间）");
    }
    return {
      kind: "macro",
      steps,
      trigger_mode: mode,
      loop_ms: loopMs,
    };
  }

  throw new Error("不支持的映射动作类型");
}

function validateKeymapRule(raw: any): KeymapRule {
  if (!raw || typeof raw !== "object") {
    throw new Error("规则格式无效");
  }
  let id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (id.length === 0 || id.length > 80) {
    id = makeLocalId("rule");
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const charCount = [...name].length;
  if (charCount < 1 || charCount > 60) {
    throw new Error("规则名称应为 1–60 个字符");
  }

  let rearSlot: number | null = null;
  if (raw.rear_slot !== null && raw.rear_slot !== undefined) {
    if (
      typeof raw.rear_slot !== "number" ||
      !Number.isInteger(raw.rear_slot) ||
      raw.rear_slot < 0 ||
      raw.rear_slot >= 8
    ) {
      throw new Error("关联背键槽位编号无效");
    }
    rearSlot = raw.rear_slot;
  }

  if (!Array.isArray(raw.trigger)) {
    throw new Error("触发源格式无效");
  }
  const normSet = new Set<PadButton>();
  for (const item of raw.trigger) {
    const b = parsePadButton(item);
    if (!b) {
      throw new Error(`未知手柄输入：${String(item)}`);
    }
    normSet.add(b);
  }
  const norm = Array.from(normSet).sort(
    (a, b) => CANONICAL_PAD_BUTTONS.indexOf(a) - CANONICAL_PAD_BUTTONS.indexOf(b),
  );
  if (norm.length < 1 || norm.length > 4) {
    throw new Error("触发源需选择 1–4 个手柄输入");
  }

  const opposites: readonly [PadButton, PadButton][] = [
    ["Up", "Down"],
    ["Left", "Right"],
    ["LXNeg", "LXPos"],
    ["LYNeg", "LYPos"],
    ["RXNeg", "RXPos"],
    ["RYNeg", "RYPos"],
  ];
  for (const [a, b] of opposites) {
    if (norm.includes(a) && norm.includes(b)) {
      throw new Error("触发组合不能同时包含相反方向输入");
    }
  }

  return {
    id,
    name,
    enabled: Boolean(raw.enabled),
    rear_slot: rearSlot,
    trigger: norm,
    action: validateKeymapAction(raw.action),
  };
}

export function validateKeymapProfile(raw: any): KeymapProfile {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.rules)) {
    throw new Error("方案格式无效");
  }
  let id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (id.length === 0 || id.length > 80) {
    id = makeLocalId("profile");
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const charCount = [...name].length;
  if (charCount < 1 || charCount > 60) {
    throw new Error("方案名称应为 1–60 个字符");
  }
  if (raw.rules.length > 64) {
    throw new Error("单个方案最多包含 64 条规则");
  }

  const ruleIds = new Set<string>();
  const activeTriggers = new Set<string>();
  const rules: KeymapRule[] = [];

  for (const r of raw.rules) {
    const clean = validateKeymapRule(r);
    if (ruleIds.has(clean.id)) {
      clean.id = makeLocalId("rule");
    }
    ruleIds.add(clean.id);

    if (clean.enabled) {
      const sig = clean.trigger.join("+");
      if (activeTriggers.has(sig)) {
        throw new Error(
          `方案“${name}”中存在多条启用规则使用完全相同的触发组合（${clean.name}）`,
        );
      }
      activeTriggers.add(sig);
    }
    rules.push(clean);
  }

  return { id, name, rules };
}

export function defaultKeymapStore(): KeymapStore {
  return {
    schema: 1,
    active_profile_id: "default",
    controller_slot: null,
    trigger_threshold: 64,
    stick_deadzone: 16000,
    profiles: [{ id: "default", name: "默认方案", rules: [] }],
  };
}

export function validateKeymapStore(raw: any): KeymapStore {
  if (!raw || typeof raw !== "object") {
    throw new Error("方案库格式无效");
  }
  if (raw.schema !== 1) {
    throw new Error("不支持的键盘宏存储版本");
  }
  let controllerSlot: number | null = null;
  if (raw.controller_slot !== null && raw.controller_slot !== undefined) {
    if (
      typeof raw.controller_slot !== "number" ||
      !Number.isInteger(raw.controller_slot) ||
      raw.controller_slot < 0 ||
      raw.controller_slot >= 4
    ) {
      throw new Error("XInput 手柄槽位应为 0–3");
    }
    controllerSlot = raw.controller_slot;
  }

  const trig = raw.trigger_threshold ?? 64;
  if (
    typeof trig !== "number" ||
    !Number.isInteger(trig) ||
    trig < 10 ||
    trig > 240
  ) {
    throw new Error("扳机触发阈值范围应为 10–240");
  }

  const dz = raw.stick_deadzone ?? 16000;
  if (
    typeof dz !== "number" ||
    !Number.isInteger(dz) ||
    dz < 4000 ||
    dz > 30000
  ) {
    throw new Error("摇杆方向触发阈值范围应为 4000–30000");
  }

  if (!Array.isArray(raw.profiles) || raw.profiles.length < 1 || raw.profiles.length > 32) {
    throw new Error("方案数量应为 1–32 个");
  }

  const ids = new Set<string>();
  const profiles: KeymapProfile[] = [];
  for (const p of raw.profiles) {
    const clean = validateKeymapProfile(p);
    if (ids.has(clean.id)) {
      throw new Error("存在重复的方案 ID");
    }
    ids.add(clean.id);
    profiles.push(clean);
  }

  const activeId =
    typeof raw.active_profile_id === "string" &&
    profiles.some((p) => p.id === raw.active_profile_id)
      ? raw.active_profile_id
      : profiles[0].id;

  return {
    schema: 1,
    active_profile_id: activeId,
    controller_slot: controllerSlot,
    trigger_threshold: trig,
    stick_deadzone: dz,
    profiles,
  };
}

export const MAX_KEYMAP_BYTES = 8 * 1024 * 1024;

export function exportKeymapProfile(profile: KeymapProfile): Record<string, unknown> {
  const clean = validateKeymapProfile(profile);
  return {
    format: "oplus-keymap-v1",
    app_version: APP_VERSION,
    profile: clean,
  };
}

function importLegacy04Profile(v: any): KeymapProfile {
  const rawName = typeof v.name === "string" ? v.name.trim() : "";
  const name =
    rawName.length >= 1 && [...rawName].length <= 60
      ? rawName
      : "导入的 0.4.0 方案";

  if (!v.mappings || typeof v.mappings !== "object" || Array.isArray(v.mappings)) {
    throw new Error("0.4.0 配置缺少 mappings 对象");
  }
  if (!v.macros || typeof v.macros !== "object" || Array.isArray(v.macros)) {
    throw new Error("0.4.0 配置缺少 macros 对象");
  }

  for (const k of Object.keys(v.mappings)) {
    if (Object.prototype.hasOwnProperty.call(v.macros, k)) {
      throw new Error(`0.4.0 配置中按键 ${k} 同时分配了单键映射与宏`);
    }
  }

  const rules: KeymapRule[] = [];

  for (const [btnStr, keyVal] of Object.entries(v.mappings)) {
    const btn = parsePadButton(btnStr);
    if (!btn) {
      throw new Error(`0.4.0 配置包含未知手柄输入：${btnStr}`);
    }
    if (typeof keyVal !== "string") {
      throw new Error("0.4.0 映射目标类型无效");
    }
    const tok = parseOutputToken(keyVal);
    rules.push({
      id: makeLocalId("rule"),
      name: `${btnStr} → ${tok}`,
      enabled: true,
      rear_slot: null,
      trigger: [btn],
      action: { kind: "hold", keys: [tok] },
    });
  }

  for (const [btnStr, stepsVal] of Object.entries(v.macros)) {
    const btn = parsePadButton(btnStr);
    if (!btn) {
      throw new Error(`0.4.0 配置包含未知宏触发键：${btnStr}`);
    }
    if (!Array.isArray(stepsVal) || stepsVal.length < 1 || stepsVal.length > 64) {
      throw new Error("0.4.0 宏步骤数量需为 1–64 步");
    }
    const steps: KbStep[] = stepsVal.map((s: any) => {
      if (!s || typeof s.key !== "string") {
        throw new Error("0.4.0 宏步骤缺少按键");
      }
      const tok = parseOutputToken(s.key);
      const holdMs = s.hold_ms;
      const gapMs = s.after_ms;
      if (
        typeof holdMs !== "number" ||
        !Number.isInteger(holdMs) ||
        holdMs < 10 ||
        holdMs > 10000
      ) {
        throw new Error("0.4.0 宏按住时间无效");
      }
      if (
        typeof gapMs !== "number" ||
        !Number.isInteger(gapMs) ||
        gapMs < 0 ||
        gapMs > 10000
      ) {
        throw new Error("0.4.0 宏间隔时间无效");
      }
      return {
        keys: [tok],
        hold_ms: holdMs,
        gap_ms: gapMs,
      };
    });
    rules.push({
      id: makeLocalId("rule"),
      name: `${btnStr} 顺序宏`,
      enabled: true,
      rear_slot: null,
      trigger: [btn],
      action: {
        kind: "macro",
        steps,
        trigger_mode: "once",
        loop_ms: 0,
      },
    });
  }

  return validateKeymapProfile({
    id: makeLocalId("profile"),
    name,
    rules,
  });
}

export function importKeymapAny(data: Uint8Array | string): KeymapProfile {
  const text = decodeUtf8NoBom(data, MAX_KEYMAP_BYTES, "键盘宏配置文件超过 8 MiB");
  let v: any;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 解析失败：${String(e)}`);
  }
  if (!v || typeof v !== "object") {
    throw new Error("不支持的键盘宏配置格式");
  }

  // 1. Wrapped oplus-keymap-v1
  if (v.format === "oplus-keymap-v1") {
    const clean = validateKeymapProfile({
      ...v.profile,
      id: makeLocalId("profile"),
    });
    return clean;
  }

  // 2. Legacy 0.4.0 profile.json
  if (v.version === 1 && v.mappings !== undefined && v.macros !== undefined) {
    return importLegacy04Profile(v);
  }

  // 3. Full KeymapStore
  if (v.schema === 1 && v.profiles !== undefined) {
    const store = validateKeymapStore(v);
    const active =
      store.profiles.find((p) => p.id === store.active_profile_id) ??
      store.profiles[0];
    if (!active) {
      throw new Error("方案库中没有可用方案");
    }
    return validateKeymapProfile({
      ...active,
      id: makeLocalId("profile"),
    });
  }

  // 4. Bare KeymapProfile
  return validateKeymapProfile({
    ...v,
    id: makeLocalId("profile"),
  });
}
