/**
 * KeyLinker Gen2 Stick & Trigger Curve Model, Presets, Trigger Gears,
 * and Fritsch-Carlson Monotone Cubic Hermite Spline (`keylinker.py:383-622, 1789-1846`).
 */

import type { RecordData } from "./types.ts";

export const CHANNEL_SIZE = 7;
export const STICK_MAX_PROGRESS = 100;
export const TRIGGER_MAX_PROGRESS = 200;
export const CURVE_AXIS_MAX = 255;

export const FLAG_INVERT_X = 0x01;
export const FLAG_INVERT_Y = 0x02;
export const FLAG_SWAP = 0x04;

export type CurvePoint = [number, number];

export interface ParsedCurveChannel {
  inner: number;
  outer_raw: number;
  point1: CurvePoint;
  point2: CurvePoint;
  flags: number;
  invert_x: boolean;
  invert_y: boolean;
  swap: boolean;
}

export interface CurvePresetDef {
  id: "default" | "quick" | "slow" | "smooth" | "fine";
  label: string;
  desc: string;
  point1: CurvePoint;
  point2: CurvePoint;
}

export interface TriggerGearDef {
  id: "zero" | "small" | "medium" | "large";
  label: string;
  desc: string;
  inner: number;
  outer_raw: number;
}

export const CURVE_PRESETS: readonly CurvePresetDef[] = [
  {
    id: "default",
    label: "线性默认",
    desc: "1:1 等比线性输出",
    point1: [85, 85],
    point2: [170, 170],
  },
  {
    id: "quick",
    label: "快速灵敏",
    desc: "前中段快速拉升响应",
    point1: [35, 35],
    point2: [136, 204],
  },
  {
    id: "slow",
    label: "缓和延迟",
    desc: "初段敏捷、后段平缓收敛",
    point1: [35, 35],
    point2: [219, 145],
  },
  {
    id: "smooth",
    label: "平滑渐进",
    desc: "中前段稳健、末段加速",
    point1: [142, 142],
    point2: [220, 157],
  },
  {
    id: "fine",
    label: "精细微调",
    desc: "强化小幅度瞄准微操",
    point1: [67, 67],
    point2: [72, 106],
  },
];

export const TRIGGER_GEARS: readonly TriggerGearDef[] = [
  {
    id: "zero",
    label: "零死区全行程",
    desc: "有效行程 0–200",
    inner: 0,
    outer_raw: 0,
  },
  {
    id: "small",
    label: "微死区灵巧",
    desc: "有效行程 4–166",
    inner: 4,
    outer_raw: 34,
  },
  {
    id: "medium",
    label: "中行程均衡",
    desc: "有效行程 20–160",
    inner: 20,
    outer_raw: 40,
  },
  {
    id: "large",
    label: "短触发速射",
    desc: "有效行程 30–140",
    inner: 30,
    outer_raw: 60,
  },
];

/**
 * Capability bit mask for a stick/trigger channel (`keylinker.py:1334-1348`):
 * - `side = 0` (Left: LS / LT) -> `bit 1` (`0x02`)
 * - `side = 1` (Right: RS / RT) -> `bit 0` (`0x01`)
 */
export function curveSideMask(side: number): number {
  if (side === 0) return 0x02;
  if (side === 1) return 0x01;
  return 0;
}

export function matchCurvePreset(
  point1: readonly [number, number],
  point2: readonly [number, number],
): CurvePresetDef["id"] | null {
  for (const p of CURVE_PRESETS) {
    if (
      p.point1[0] === point1[0] &&
      p.point1[1] === point1[1] &&
      p.point2[0] === point2[0] &&
      p.point2[1] === point2[1]
    ) {
      return p.id;
    }
  }
  return null;
}

export function matchTriggerGear(
  inner: number,
  outerRaw: number,
): TriggerGearDef["id"] | null {
  for (const g of TRIGGER_GEARS) {
    if (g.inner === inner && g.outer_raw === outerRaw) {
      return g.id;
    }
  }
  return null;
}

export function parseCurveRecordChannels(
  record: RecordData | undefined,
): [ParsedCurveChannel, ParsedCurveChannel] | null {
  if (!record || record.declared !== 14) return null;
  const parts = record.hex
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((x) => parseInt(x, 16));
  if (parts.length !== 14 || parts.some((n) => Number.isNaN(n))) return null;

  const parseOne = (offset: number): ParsedCurveChannel => {
    const flags = parts[offset + 6] & 0xff;
    return {
      inner: parts[offset] & 0xff,
      outer_raw: parts[offset + 1] & 0xff,
      point1: [parts[offset + 2] & 0xff, parts[offset + 3] & 0xff],
      point2: [parts[offset + 4] & 0xff, parts[offset + 5] & 0xff],
      flags,
      invert_x: (flags & FLAG_INVERT_X) !== 0,
      invert_y: (flags & FLAG_INVERT_Y) !== 0,
      swap: (flags & FLAG_SWAP) !== 0,
    };
  };

  return [parseOne(0), parseOne(7)];
}

/**
 * Fritsch-Carlson monotone cubic tangents (`keylinker.py:_monotone_slopes`).
 * Prevents artificial overshoot or non-monotone wiggles between control knots.
 */
export function monotoneSlopes(xs: readonly number[], ys: readonly number[]): number[] {
  const n = xs.length;
  const deltas: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    deltas.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  }

  const slopes: number[] = [deltas[0]];
  for (let i = 1; i < n - 1; i++) {
    if (deltas[i - 1] * deltas[i] <= 0) {
      slopes.push(0.0);
    } else {
      slopes.push((deltas[i - 1] + deltas[i]) / 2.0);
    }
  }
  slopes.push(deltas[deltas.length - 1]);

  for (let i = 0; i < deltas.length; i++) {
    const delta = deltas[i];
    if (delta === 0) {
      slopes[i] = 0.0;
      slopes[i + 1] = 0.0;
      continue;
    }
    const a = slopes[i] / delta;
    const b = slopes[i + 1] / delta;
    const sq = a * a + b * b;
    if (sq > 9.0) {
      const scale = 3.0 / Math.sqrt(sq);
      slopes[i] = scale * a * delta;
      slopes[i + 1] = scale * b * delta;
    }
  }
  return slopes;
}

/**
 * Cubic Hermite interpolation (`keylinker.py:_hermite`).
 */
export function hermite(
  xs: readonly number[],
  ys: readonly number[],
  slopes: readonly number[],
  x: number,
): number {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];

  let idx = 0;
  for (let j = 0; j < xs.length - 1; j++) {
    if (xs[j] <= x) idx = j;
  }

  const span = xs[idx + 1] - xs[idx];
  const t = (x - xs[idx]) / span;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * ys[idx] +
    (t3 - 2 * t2 + t) * span * slopes[idx] +
    (-2 * t3 + 3 * t2) * ys[idx + 1] +
    (t3 - t2) * span * slopes[idx + 1]
  );
}

function buildSplineKnots(
  point1: readonly [number, number],
  point2: readonly [number, number],
): { xs: number[]; ys: number[]; slopes: number[] } | null {
  const rawKnots: [number, number][] = [
    [0.0, 0.0],
    [point1[0], point1[1]],
    [point2[0], point2[1]],
    [CURVE_AXIS_MAX, CURVE_AXIS_MAX],
  ];

  const unique: [number, number][] = [];
  for (const [x, y] of rawKnots) {
    if (unique.length > 0 && Math.abs(unique[unique.length - 1][0] - x) < 1e-9) {
      unique[unique.length - 1] = [x, y];
    } else {
      unique.push([x, y]);
    }
  }
  if (unique.length < 2) return null;

  const xs = unique.map(([x]) => x);
  const ys = unique.map(([, y]) => y);
  const slopes = monotoneSlopes(xs, ys);
  return { xs, ys, slopes };
}

export function evaluateCurveY(
  point1: readonly [number, number],
  point2: readonly [number, number],
  x: number,
): number {
  const clampedX = Math.max(0, Math.min(CURVE_AXIS_MAX, x));
  const prepared = buildSplineKnots(point1, point2);
  if (!prepared) {
    return clampedX;
  }
  const y = hermite(prepared.xs, prepared.ys, prepared.slopes, clampedX);
  return Math.max(0, Math.min(CURVE_AXIS_MAX, y));
}

/**
 * Samples `(x, y)` points in `[0, 255]` along the Fritsch-Carlson monotone cubic curve (`keylinker.py:curve_shape`).
 */
export function curveShape(
  point1: readonly [number, number],
  point2: readonly [number, number],
  steps = 49,
): CurvePoint[] {
  const count = Math.max(2, Math.trunc(steps));
  const prepared = buildSplineKnots(point1, point2);
  if (!prepared) {
    return [
      [0, 0],
      [CURVE_AXIS_MAX, CURVE_AXIS_MAX],
    ];
  }
  const out: CurvePoint[] = [];
  for (let i = 0; i < count; i++) {
    const x = (CURVE_AXIS_MAX * i) / (count - 1);
    const y = Math.max(
      0,
      Math.min(CURVE_AXIS_MAX, hermite(prepared.xs, prepared.ys, prepared.slopes, x)),
    );
    out.push([x, y]);
  }
  return out;
}
