/**
 * W3C Gamepad API to XInput `Input` mapper (with Y-axis sign inversion so stick
 * crosshairs and deadzone directions match Windows XInput 100%) and guided
 * 1–8 physical rear-button slot identification over Web Bluetooth.
 */

import {
  type Input,
  LABELS_OPLUS_6,
  SLOT_ORDER_8,
} from "../types.ts";
import {
  encodeForSlot,
  snapshotActiveSlots,
  snapshotRecord,
  supportTier,
} from "./model.ts";
import type { WebStorage } from "./storage.ts";
import {
  type Device,
  type Edit,
  apply,
  prepare,
  rollback,
} from "./transaction.ts";

export const IDENTIFY_MARKERS: readonly [number, number][] = [
  [1, 0x1000], // A
  [2, 0x2000], // B
  [3, 0x4000], // X
  [4, 0x8000], // Y
  [5, 0x0100], // LB
  [6, 0x0200], // RB
  [11, 0x0040], // L3 (LS)
  [12, 0x0080], // R3 (RS)
];

export interface W3CGamepadButtonLike {
  readonly pressed: boolean;
  readonly value: number;
}

export interface W3CGamepadLike {
  readonly index?: number;
  readonly connected?: boolean;
  readonly buttons: readonly W3CGamepadButtonLike[];
  readonly axes: readonly number[];
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(min, Math.min(max, v));
}

function axisToXInput(raw: number | undefined, invert: boolean): number {
  const c = clamp(raw ?? 0, -1, 1);
  const v = Math.round((invert ? -c : c) * 32767);
  return v === 0 ? 0 : Math.max(-32768, Math.min(32767, v));
}

function triggerToXInput(btn: W3CGamepadButtonLike | undefined): number {
  if (!btn) return 0;
  const val =
    typeof btn.value === "number" && Number.isFinite(btn.value)
      ? clamp(btn.value, 0, 1)
      : btn.pressed
        ? 1
        : 0;
  return Math.round(val * 255);
}

export function gamepadToXInput(
  gp: W3CGamepadLike,
  fallbackSlot = 0,
): Input {
  const b = gp.buttons ?? [];
  let buttons = 0;
  const digitalTable: readonly [number, number][] = [
    [0, 0x1000], // A
    [1, 0x2000], // B
    [2, 0x4000], // X
    [3, 0x8000], // Y
    [4, 0x0100], // LB
    [5, 0x0200], // RB
    [8, 0x0020], // Back
    [9, 0x0010], // Start
    [10, 0x0040], // LS (L3)
    [11, 0x0080], // RS (R3)
    [12, 0x0001], // Up
    [13, 0x0002], // Down
    [14, 0x0004], // Left
    [15, 0x0008], // Right
  ];
  for (const [idx, mask] of digitalTable) {
    if (b[idx]?.pressed) {
      buttons |= mask;
    }
  }

  const axes = gp.axes ?? [];
  return {
    slot: typeof gp.index === "number" ? gp.index : fallbackSlot,
    buttons,
    left_trigger: triggerToXInput(b[6]),
    right_trigger: triggerToXInput(b[7]),
    lx: axisToXInput(axes[0], false),
    ly: axisToXInput(axes[1], true),
    rx: axisToXInput(axes[2], false),
    ry: axisToXInput(axes[3], true),
  };
}

export function readWebGamepads(): Input[] {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.getGamepads !== "function"
  ) {
    return [];
  }
  const rawPads = navigator.getGamepads();
  if (!rawPads) return [];
  const out: Input[] = [];
  for (let i = 0; i < rawPads.length && out.length < 4; i++) {
    const gp = rawPads[i];
    if (!gp || !gp.connected) continue;
    out.push(gamepadToXInput(gp, i));
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function identifyRearSlotsWeb(
  device: Device,
  store: WebStorage,
  isCancelled: () => boolean,
  onStatus: (msg: string) => void,
  readInputs: () => Input[] = readWebGamepads,
  pollIntervalMs = 12,
  expectedDeviceId?: string,
): Promise<Record<number, string>> {
  const initialPads = readInputs();
  if (initialPads.length === 0) {
    throw new Error(
      "未检测到手柄输入：请同时连接 USB 或 2.4G 接收器并在浏览器中按一下手柄任意键唤醒 Gamepad，或直接使用型号默认预设",
    );
  }
  if (initialPads.length !== 1) {
    throw new Error("识别时请只连接一只手柄；也可以直接使用型号默认预设");
  }
  const inputSlot = initialPads[0].slot;

  const before = await device.snapshot();
  if (supportTier(before) === "read_only") {
    throw new Error("当前设备处于只读模式，不支持写入识别标记");
  }
  const activeSlots = snapshotActiveSlots(before);
  if (activeSlots.length === 0 || activeSlots.length > 8) {
    throw new Error("当前手柄没有可识别的实体背键槽位");
  }
  if (before.raw.remapping) {
    const rem = snapshotRecord(before, "remapping");
    if (rem.slice(1).some((v) => v !== 0)) {
      throw new Error("标准按键存在自定义映射，请先还原或使用型号默认预设");
    }
  }

  const promptNames: string[] =
    before.identity.vid === "1005" &&
    activeSlots.length === 6 &&
    activeSlots.every((v, idx) => v === idx)
      ? [...LABELS_OPLUS_6]
      : activeSlots.map((s) => SLOT_ORDER_8[s] || `槽 ${s + 1}`);

  const edits: Edit[] = [];
  const slotMarkers: [number, number][] = [];
  activeSlots.forEach((slot, idx) => {
    const [keyCode, xinputMask] = IDENTIFY_MARKERS[idx];
    slotMarkers.push([slot, xinputMask]);
    edits.push({
      key: `macro_${slot}`,
      expected: snapshotRecord(before, `macro_${slot}`),
      target: encodeForSlot({ kind: "hold", keys: [keyCode] }, before, slot),
    });
  });

  const total = activeSlots.length;
  const [journal] = await prepare(
    device,
    store,
    "identification",
    edits,
    expectedDeviceId ? { expectedDeviceId } : undefined,
  );

  let sampleError: unknown = null;
  const labels: Record<number, string> = {};

  try {
    onStatus("正在设置临时标记，请松开所有按键");
    await apply(device, store, journal);

    const deadline = Date.now() + 60_000;
    let neutral = false;
    let held: { slot: number; startedAt: number } | null = null;
    let capturedCount = 0;

    onStatus(`请按实体 ${promptNames[0]} 一次并松开`);
    while (
      Date.now() < deadline &&
      capturedCount < total &&
      !isCancelled()
    ) {
      const pads = readInputs();
      if (pads.length !== 1 || pads[0].slot !== inputSlot) {
        throw new Error("手柄连接发生变化，正在恢复");
      }
      const pad = pads[0];
      if (
        pad.buttons === 0 &&
        pad.left_trigger < 30 &&
        pad.right_trigger < 30
      ) {
        if (held !== null) {
          const { slot, startedAt } = held;
          held = null;
          if (
            Date.now() - startedAt >= 40 &&
            labels[slot] === undefined
          ) {
            labels[slot] = promptNames[capturedCount];
            capturedCount += 1;
            if (capturedCount < total) {
              onStatus(
                `已识别 ${capturedCount}/${total}，请按实体 ${promptNames[capturedCount]} 一次并松开`,
              );
            }
          }
        }
        neutral = true;
      } else if (
        neutral &&
        held === null &&
        pad.left_trigger < 30 &&
        pad.right_trigger < 30
      ) {
        const hit = slotMarkers.find(([, mask]) => mask === pad.buttons);
        if (hit) {
          held = { slot: hit[0], startedAt: Date.now() };
        }
        neutral = false;
      } else if (!slotMarkers.some(([, mask]) => mask === pad.buttons)) {
        held = null;
        neutral = false;
      }
      await sleep(pollIntervalMs);
    }

    if (capturedCount !== total) {
      throw new Error("识别已取消或超时");
    }
  } catch (e) {
    sampleError = e;
  }

  onStatus("正在恢复原始背键配置，请等待完成");
  const restored = await rollback(device, store, journal);
  if (!restored) {
    throw new Error("部分配置未确认恢复，请查看恢复中心");
  }
  if (sampleError) {
    throw sampleError instanceof Error
      ? sampleError
      : new Error(String(sampleError));
  }
  return labels;
}
