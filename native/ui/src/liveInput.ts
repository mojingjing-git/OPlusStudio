/**
 * High-FPS, zero-React-render live gamepad feed & telemetry math
 * (inspired by gamepadtester.cn's rAF + Float32Array(36) circularity engine).
 *
 * - Runs a single shared `requestAnimationFrame` loop ONLY while subscribed.
 * - Reads `navigator.getGamepads()` synchronously at native display refresh rate
 *   (60/120/144/240 Hz) with zero IPC overhead in both Web and Tauri WebView2.
 * - Falls back seamlessly to non-overlapping Tauri `invoke("inputs")` when W3C
 *   Gamepad has not woken up yet in WebView2.
 */

import { invoke, isTauriRuntime } from "./backend.ts";
import type { Input } from "./types.ts";
import { gamepadToXInput } from "./web/gamepad.ts";

export interface LivePadSample extends Input {
  /** Normalized float axes in [-1, 1], with +Y pointing UP (matching XInput). */
  fx: number;
  fy: number;
  frx: number;
  fry: number;
  /** Normalized trigger values in [0, 1]. */
  flt: number;
  frt: number;
  /** Monotonic sample timestamp (ms) from Gamepad.timestamp or performance.now(). */
  sampleTs: number;
  /** Hardware / driver ID string if exposed by W3C Gamepad API. */
  id: string;
  /** Browser dual-rumble actuator when available. */
  actuator: GamepadHapticActuatorLike | null;
}

export interface GamepadHapticActuatorLike {
  playEffect?: (
    type: string,
    params: {
      startDelay?: number;
      duration: number;
      weakMagnitude: number;
      strongMagnitude: number;
    },
  ) => Promise<unknown>;
  reset?: () => Promise<unknown>;
}

export interface LiveInputFrame {
  pads: LivePadSample[];
  now: number;
}

type FrameListener = (frame: LiveInputFrame) => void;

const listeners = new Set<FrameListener>();
let rafId: number | null = null;
let tauriInFlight = false;
let tauriFallbackPads: LivePadSample[] = [];
let lastTauriPollMs = 0;

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < min ? min : v > max ? max : v;
}

function readBrowserSamples(now: number): LivePadSample[] {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.getGamepads !== "function"
  ) {
    return [];
  }
  const rawList = navigator.getGamepads();
  if (!rawList) return [];
  const out: LivePadSample[] = [];
  for (let i = 0; i < rawList.length && out.length < 4; i++) {
    const gp = rawList[i] as (Gamepad & {
      vibrationActuator?: GamepadHapticActuatorLike | null;
    }) | null;
    if (!gp || !gp.connected) continue;
    const base = gamepadToXInput(gp, i);
    const axes = gp.axes ?? [];
    const btns = gp.buttons ?? [];
    const flt = clamp(btns[6]?.value ?? (btns[6]?.pressed ? 1 : 0), 0, 1);
    const frt = clamp(btns[7]?.value ?? (btns[7]?.pressed ? 1 : 0), 0, 1);
    out.push({
      ...base,
      fx: clamp(axes[0] ?? 0, -1, 1),
      fy: clamp(-(axes[1] ?? 0), -1, 1),
      frx: clamp(axes[2] ?? 0, -1, 1),
      fry: clamp(-(axes[3] ?? 0), -1, 1),
      flt,
      frt,
      sampleTs:
        typeof gp.timestamp === "number" && gp.timestamp > 0
          ? gp.timestamp
          : now,
      id: gp.id || `Controller #${base.slot + 1}`,
      actuator: gp.vibrationActuator ?? null,
    });
  }
  return out;
}

function xinputToSample(inp: Input, now: number): LivePadSample {
  return {
    ...inp,
    fx: clamp(inp.lx / (inp.lx < 0 ? 32768 : 32767), -1, 1),
    fy: clamp(inp.ly / (inp.ly < 0 ? 32768 : 32767), -1, 1),
    frx: clamp(inp.rx / (inp.rx < 0 ? 32768 : 32767), -1, 1),
    fry: clamp(inp.ry / (inp.ry < 0 ? 32768 : 32767), -1, 1),
    flt: clamp(inp.left_trigger / 255, 0, 1),
    frt: clamp(inp.right_trigger / 255, 0, 1),
    sampleTs: now,
    id: `XInput 槽位 #${inp.slot + 1}`,
    actuator: null,
  };
}

function pumpTauriFallback(now: number): void {
  if (!isTauriRuntime() || tauriInFlight) return;
  // When no pad is detected yet, probe gently every 250ms; when active, stream every frame
  const minGap = tauriFallbackPads.length === 0 ? 250 : 0;
  if (now - lastTauriPollMs < minGap) return;
  lastTauriPollMs = now;
  tauriInFlight = true;
  invoke<Input[]>("inputs")
    .then((list) => {
      const ts = performance.now();
      tauriFallbackPads = Array.isArray(list)
        ? list.map((item) => xinputToSample(item, ts))
        : [];
    })
    .catch(() => {})
    .finally(() => {
      tauriInFlight = false;
    });
}

function tick(now: number): void {
  if (listeners.size === 0) {
    rafId = null;
    return;
  }
  let pads = readBrowserSamples(now);
  if (pads.length === 0 && isTauriRuntime()) {
    pumpTauriFallback(now);
    pads = tauriFallbackPads;
  }
  const frame: LiveInputFrame = { pads, now };
  for (const fn of listeners) {
    fn(frame);
  }
  rafId = requestAnimationFrame(tick);
}

export function subscribeLiveInputs(fn: FrameListener): () => void {
  listeners.add(fn);
  if (rafId === null && typeof requestAnimationFrame === "function") {
    rafId = requestAnimationFrame(tick);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && rafId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };
}

// ============================================================================
// Zero-Allocation 36-Sector Stick Circularity & Resting Drift Analyzer
// ============================================================================

export const CIRC_SECTORS = 36;

export class StickBenchAnalyzer {
  readonly sectors = new Float32Array(CIRC_SECTORS);
  public coveredCount = 0;
  public avgErrorPct: number | null = null;
  public maxReach = 0;
  public restX = 0;
  public restY = 0;
  public restDriftPct = 0;
  private wasDeflected = false;
  private settleFrames = 0;

  reset(): void {
    this.sectors.fill(0);
    this.coveredCount = 0;
    this.avgErrorPct = null;
    this.maxReach = 0;
    this.restX = 0;
    this.restY = 0;
    this.restDriftPct = 0;
    this.wasDeflected = false;
    this.settleFrames = 0;
  }

  /** Returns `true` if the circularity polygon changed on this sample. */
  push(fx: number, fy: number): boolean {
    const r = Math.hypot(fx, fy);
    if (r > this.maxReach) {
      this.maxReach = r;
    }

    // Track resting drift after releasing stick from >= 35% deflection
    if (r >= 0.35) {
      this.wasDeflected = true;
      this.settleFrames = 0;
    } else if (r < 0.22) {
      if (this.wasDeflected) {
        this.settleFrames += 1;
        if (this.settleFrames === 12) {
          this.restX = fx;
          this.restY = fy;
          this.restDriftPct = Math.hypot(fx, fy) * 100;
          this.wasDeflected = false;
        }
      } else if (this.restDriftPct === 0 && r > 0) {
        this.restX = fx;
        this.restY = fy;
        this.restDriftPct = r * 100;
      }
    }

    // Record outer circularity envelope when stick is pushed past 50%
    if (r <= 0.5) return false;
    let deg = (Math.atan2(-fy, fx) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    const idx = Math.min(CIRC_SECTORS - 1, Math.floor(deg / (360 / CIRC_SECTORS)));
    if (r <= this.sectors[idx]) return false;

    this.sectors[idx] = r;
    let count = 0;
    let sqSum = 0;
    for (let i = 0; i < CIRC_SECTORS; i++) {
      const sv = this.sectors[i];
      if (sv > 0.5) {
        count += 1;
        const diff = sv - 1;
        sqSum += diff * diff;
      }
    }
    this.coveredCount = count;
    // Standard RMS circularity error % across tested outer sectors (matches gamepadtester)
    this.avgErrorPct = count >= 8 ? Math.sqrt(sqSum / count) * 100 : null;
    return true;
  }

  /** Builds a smooth closed SVG polygon path inside a radar of center `(cx, cy)` and unit radius `unitR`. */
  buildSvgPath(cx: number, cy: number, unitR: number): string {
    if (this.coveredCount < 2) return "";
    let d = "";
    let started = false;
    for (let i = 0; i < CIRC_SECTORS; i++) {
      const r = Math.min(1.18, this.sectors[i]);
      if (r <= 0.5) continue;
      const rad = ((i + 0.5) * (360 / CIRC_SECTORS) * Math.PI) / 180;
      const x = cx + Math.cos(rad) * r * unitR;
      const y = cy + Math.sin(rad) * r * unitR;
      d += `${started ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)} `;
      started = true;
    }
    if (this.coveredCount >= 24) {
      d += "Z";
    }
    return d.trim();
  }
}

// ============================================================================
// Zero-Allocation Ring-Buffer Polling Rate & Jitter Estimator
// ============================================================================

export class PollingRateAnalyzer {
  private readonly deltas = new Float32Array(64);
  private head = 0;
  private count = 0;
  private lastSampleTs = 0;
  private lastSig = "";

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.lastSampleTs = 0;
    this.lastSig = "";
  }

  push(pad: LivePadSample): void {
    const sig = `${pad.lx},${pad.ly},${pad.rx},${pad.ry},${pad.left_trigger},${pad.right_trigger},${pad.buttons}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    const ts = pad.sampleTs;
    if (this.lastSampleTs > 0) {
      const dt = ts - this.lastSampleTs;
      if (dt >= 0.4 && dt <= 100) {
        this.deltas[this.head] = dt;
        this.head = (this.head + 1) & 63;
        if (this.count < 64) this.count += 1;
      }
    }
    this.lastSampleTs = ts;
  }

  stats(): { hz: number; jitterMs: number } | null {
    if (this.count < 6) return null;
    let sum = 0;
    for (let i = 0; i < this.count; i++) {
      sum += this.deltas[i];
    }
    const mean = sum / this.count;
    if (mean <= 0) return null;
    let varSum = 0;
    for (let i = 0; i < this.count; i++) {
      const diff = this.deltas[i] - mean;
      varSum += diff * diff;
    }
    return {
      hz: Math.round(1000 / mean),
      jitterMs: Math.sqrt(varSum / this.count),
    };
  }
}
