/**
 * Complete Web runtime command dispatcher mirroring `native/app/src/commands.rs`.
 * Connects React UI directly to Web Bluetooth, W3C Gamepad API, and IndexedDB
 * when running outside Tauri (e.g., GitHub Pages or browser dev preview).
 */

import type {
  Candidate,
  Change,
  KeymapStore,
  PadButton,
  RunnerSnapshot,
  Snapshot,
  View,
} from "../types.ts";
import {
  WebBleSession,
  acquireWebBluetoothDevice,
  formatWebDeviceAddress,
  getCachedWebDeviceSummary,
  withBeforeUnloadGuard,
} from "./ble.ts";
import { identifyRearSlotsWeb, readWebGamepads } from "./gamepad.ts";
import {
  bridgeHoldChange,
  capabilityActiveSlots,
  capabilityLightingZones,
  capabilityMotorChannels,
  capabilityStickSides,
  capabilityTriggerSides,
  defaultKeymapStore,
  desiredSetting,
  diagnosticBundle,
  encodeForSlot,
  exportKeymapProfile,
  exportProfile,
  form,
  hasPerSlotMacroLimits,
  hasRemapSelectList,
  hexSpaced,
  importKeymapAny,
  importProfile,
  parseCapabilities,
  parseProgram,
  recordFromPayload,
  snapshotActiveSlots,
  snapshotLayout,
  snapshotPreset,
  snapshotRecord,
  snapshotSlotStepLimit,
  supportTier,
  validateKeymapStore,
} from "./model.ts";
import {
  downloadJson,
  labelStorageKey,
  pickJsonFile,
  webStorage,
} from "./storage.ts";
import {
  type DurableJournal,
  type Edit,
  execute,
  pending,
  persistJournal,
  recoveryEdits,
  undoEdits,
} from "./transaction.ts";

type StatusListener = (status: string) => void;

const statusListeners = new Set<StatusListener>();
let busy = false;
let cancelFlag = false;
let baselineSnapshot: Snapshot | null = null;
let undoJournal: DurableJournal | null = null;
let keymapCache: KeymapStore | null = null;

function emitStatus(text: string): void {
  for (const fn of statusListeners) {
    try {
      fn(text);
    } catch {
      // Ignore listener errors
    }
  }
}

export function listenWebStatus(fn: StatusListener): () => void {
  statusListeners.add(fn);
  return () => {
    statusListeners.delete(fn);
  };
}

function webRunnerSnapshot(): RunnerSnapshot {
  return {
    enabled: false,
    paused_reason: null,
    state: "stopped",
    active_slot: null,
    active_rules: [],
    armed: false,
    panic_count: 0,
    last_panic: false,
    blocked_count: 0,
    injection_warning: null,
  };
}

function requireBaseline(): Snapshot {
  if (!baselineSnapshot) {
    throw new Error("请先连接并读取配置");
  }
  return baselineSnapshot;
}

function parseSlotIndex(text: string): number {
  if (!/^[0-9]+$/.test(text)) {
    throw new Error("无效槽位");
  }
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n >= 8 || String(n) !== text) {
    throw new Error("无效槽位");
  }
  return n;
}

function slotForSnapshot(text: string, s: Snapshot): number {
  const n = parseSlotIndex(text);
  if (!snapshotActiveSlots(s).includes(n)) {
    throw new Error("该背键槽位在当前手柄上未启用");
  }
  return n;
}

async function loadKeymapStore(): Promise<KeymapStore> {
  if (keymapCache) return keymapCache;
  try {
    const raw = await webStorage.get<unknown>("kv", "keymap-profiles");
    if (raw) {
      keymapCache = validateKeymapStore(raw);
      return keymapCache;
    }
  } catch {
    // Fallback to clean default store
  }
  keymapCache = defaultKeymapStore();
  return keymapCache;
}

async function loadLabels(snapshot: Snapshot): Promise<Record<string, string>> {
  const active = snapshotActiveSlots(snapshot);
  const preset = snapshotPreset(snapshot);
  try {
    const key = await labelStorageKey(snapshot.address);
    const savedDoc = await webStorage.get<{
      address?: string;
      labels?: Record<string, string>;
    }>("kv", key);
    if (savedDoc && savedDoc.address === snapshot.address && savedDoc.labels) {
      const valid: Record<string, string> = {};
      for (const [k, v] of Object.entries(savedDoc.labels)) {
        const idx = Number(k);
        if (
          Number.isInteger(idx) &&
          active.includes(idx) &&
          typeof v === "string" &&
          v.trim().length > 0 &&
          [...v].length <= 20
        ) {
          valid[String(idx)] = v;
        }
      }
      const validValues = new Set(Object.values(valid));
      for (const [pk, pv] of Object.entries(preset)) {
        if (valid[pk] !== undefined || validValues.has(pv)) {
          delete preset[pk];
        }
      }
      Object.assign(preset, valid);
    }
  } catch {
    // Keep preset on read failure
  }
  return preset;
}

async function saveLabels(
  snapshot: Snapshot,
  labelsBySlot: Record<number, string>,
): Promise<void> {
  if (supportTier(snapshot) === "read_only") {
    throw new Error("只读诊断模式下不支持编辑背键名称");
  }
  const active = snapshotActiveSlots(snapshot);
  const seen = new Set<string>();
  const clean: Record<string, string> = {};

  for (const [slotStr, rawLabel] of Object.entries(labelsBySlot)) {
    const slot = Number(slotStr);
    const trimmed = typeof rawLabel === "string" ? rawLabel.trim() : "";
    if (
      !active.includes(slot) ||
      trimmed.length === 0 ||
      [...rawLabel].length > 20 ||
      seen.has(trimmed)
    ) {
      throw new Error("背键名称应为 1–20 字且不重复");
    }
    seen.add(trimmed);
    clean[String(slot)] = rawLabel;
  }

  const key = await labelStorageKey(snapshot.address);
  await webStorage.put("kv", key, {
    address: snapshot.address,
    labels: clean,
  });
}

async function buildView(snapshot: Snapshot): Promise<View> {
  const tier = supportTier(snapshot);
  let caps: ReturnType<typeof parseCapabilities> | null = null;
  try {
    caps = parseCapabilities(snapshot.capabilities);
  } catch {
    caps = null;
  }

  const activeSlots = tier !== "read_only" ? snapshotActiveSlots(snapshot) : [];
  const forms: Record<string, Change> = {};
  const programs: View["programs"] = {};
  const slotLimits: Record<string, number> = {};

  if (tier !== "read_only" && activeSlots.length > 0) {
    const layout = snapshotLayout(snapshot);
    for (const slot of activeSlots) {
      forms[String(slot)] = form(snapshot, slot);
      programs[String(slot)] = parseProgram(
        snapshotRecord(snapshot, `macro_${slot}`),
        layout,
      );
      slotLimits[String(slot)] = snapshotSlotStepLimit(snapshot, slot);
    }
  }

  return {
    snapshot,
    support_tier: tier,
    capabilities_info: caps
      ? {
          sticks: caps.sticks,
          stick_sides: capabilityStickSides(caps),
          triggers: caps.triggers,
          trigger_sides: capabilityTriggerSides(caps),
          motors: caps.motors,
          motor_channels: capabilityMotorChannels(caps),
          macros: caps.macros,
          active_slots: capabilityActiveSlots(caps),
          changekey: caps.changekey,
          has_remap_select_list: hasRemapSelectList(caps),
          lighting: caps.lighting,
          lighting_zones: capabilityLightingZones(caps),
          has_per_slot_macro_limits: hasPerSlotMacroLimits(caps),
        }
      : null,
    active_slots: activeSlots,
    slot_limits: slotLimits,
    forms,
    programs,
    labels: await loadLabels(snapshot),
    recoveries: await pending(webStorage),
  };
}

async function installSnapshot(snapshot: Snapshot): Promise<View> {
  const v = await buildView(snapshot);
  baselineSnapshot = structuredClone(snapshot);
  return v;
}

async function dispatchRun(request: Record<string, any>): Promise<unknown> {
  const action = request?.action;

  if (action === "preview") {
    const s = requireBaseline();
    const p = encodeForSlot(request.change as Change, s, Number(request.slot));
    return {
      payload: hexSpaced(p),
      program: parseProgram(p, snapshotLayout(s)),
    };
  }

  if (action === "labels") {
    const s = requireBaseline();
    const inputLabels = (request.labels ?? {}) as Record<string, string>;
    const mapped: Record<number, string> = {};
    for (const [k, val] of Object.entries(inputLabels)) {
      const slot = slotForSnapshot(k, s);
      mapped[slot] = String(val);
    }
    await saveLabels(s, mapped);
    return buildView(s);
  }

  if (action === "import") {
    const s = requireBaseline();
    const bytes = await pickJsonFile(65536, "配置文件超过 64 KiB");
    const changes = importProfile(bytes, s);
    return { changes };
  }

  if (action === "export") {
    const s = structuredClone(requireBaseline());
    const staged = (request.changes ?? {}) as Record<string, Change>;
    for (const [slotText, c] of Object.entries(staged)) {
      const slot = slotForSnapshot(slotText, s);
      const p = encodeForSlot(c, s, slot);
      s.raw[`macro_${slot}`] = recordFromPayload(p);
    }
    const profile = exportProfile(s, await loadLabels(s));
    downloadJson("OPlus-rear-profile.json", profile);
    return { message: "背键配置已导出（含当前草稿）" };
  }

  if (action === "backup") {
    const s = requireBaseline();
    downloadJson("OPlus-board-backup.json", s);
    return { message: "已导出最近读取的完整快照" };
  }

  if (action === "diagnostic") {
    const s = requireBaseline();
    const bundle = diagnosticBundle(s);
    downloadJson("OPlus-diagnostic-bundle.json", bundle);
    return { message: "已导出设备兼容诊断包" };
  }

  if (action === "scan") {
    const cached = getCachedWebDeviceSummary();
    const devices: Candidate[] = cached
      ? [
          {
            name: cached.name,
            address: cached.address,
            rssi: null,
            likely: true,
            confirmed_service: true,
          },
        ]
      : [];
    return { devices };
  }

  // Hardware BLE operations
  return withBeforeUnloadGuard(async () => {
    const savedDeviceMeta = await webStorage.get<{
      address?: string;
      deviceId?: string;
    }>("kv", "device");

    const requestedAddr =
      action === "read"
        ? typeof request.address === "string"
          ? request.address
          : ""
        : requireBaseline().address;

    emitStatus(
      request.forcePicker
        ? "请在浏览器蓝牙窗口中选择手柄…"
        : "正在连接手柄蓝牙配置通道…",
    );

    const btDevice = await acquireWebBluetoothDevice({
      forcePicker: Boolean(request.forcePicker),
      showAll: Boolean(request.showAll),
      preferredAddress: requestedAddr || savedDeviceMeta?.address,
      preferredDeviceId: savedDeviceMeta?.deviceId,
    });

    const resolvedAddress = formatWebDeviceAddress(btDevice);
    if (action === "save" || action === "undo" || action === "identify") {
      const pend = await pending(webStorage);
      if (pend.some((j) => j.address === resolvedAddress)) {
        throw new Error("此设备存在未完成操作，请先在恢复中心检查并恢复");
      }
    }

    emitStatus("正在建立蓝牙 GATT 服务连接…");
    const device = await WebBleSession.connectDevice(btDevice);
    try {
      if (action === "read") {
        emitStatus("正在读取手柄能力描述符与板载配置…");
        const s = await device.snapshot();
        if (undoJournal && undoJournal.address !== s.address) {
          undoJournal = null;
        }
        await webStorage.put("kv", "device", {
          address: s.address,
          deviceId: btDevice.id,
          deviceName: btDevice.name ?? "",
        });
        return await installSnapshot(s);
      }

      if (action === "save") {
        const s = requireBaseline();
        if (supportTier(s) === "read_only") {
          throw new Error("当前设备处于只读模式，禁止保存到手柄");
        }
        const edits: Edit[] = [];
        const changes = (request.changes ?? {}) as Record<string, Change>;
        for (const [slotText, c] of Object.entries(changes)) {
          const slot = slotForSnapshot(slotText, s);
          const key = `macro_${slot}`;
          edits.push({
            key,
            expected: snapshotRecord(s, key),
            target: encodeForSlot(c, s, slot),
          });
        }

        const settingTargets = new Map<string, number[]>();
        const staged = structuredClone(s);
        const settings = Array.isArray(request.settings) ? request.settings : [];
        for (const setting of settings) {
          let key: string;
          let changePayload: Record<string, unknown>;
          if (setting.feature === "stick_curve") {
            key = "sticks";
            changePayload = {
              side: setting.side,
              inner: setting.inner,
              outer_raw: setting.outer_raw,
              point1: setting.point1,
              point2: setting.point2,
              invert_x: setting.invert_x,
              invert_y: setting.invert_y,
              swap: setting.swap,
            };
          } else if (setting.feature === "trigger_curve") {
            key = "triggers";
            changePayload = {
              side: setting.side,
              inner: setting.inner,
              outer_raw: setting.outer_raw,
              point1: setting.point1,
              point2: setting.point2,
            };
          } else if (setting.feature === "motors") {
            key = "motors";
            changePayload = { levels: setting.levels };
          } else if (setting.feature === "motor_channel") {
            key = "motors";
            changePayload = {
              channel: setting.channel,
              level: setting.level,
            };
          } else if (setting.feature === "remapping") {
            key = "remapping";
            changePayload = {
              source: setting.source,
              target: setting.target,
            };
          } else if (setting.feature === "lighting") {
            key = "lighting";
            changePayload = {
              zone: setting.zone,
              rgb: setting.rgb,
            };
          } else {
            throw new Error("未知设置");
          }
          const p = desiredSetting(staged, key, changePayload);
          staged.raw[key] = recordFromPayload(p);
          settingTargets.set(key, p);
        }

        for (const [key, target] of settingTargets.entries()) {
          edits.push({
            key,
            expected: snapshotRecord(s, key),
            target,
          });
        }

        emitStatus("正在检查冲突、备份并保存；请等待核对完成…");
        const receipt = await execute(device, webStorage, "save", edits);
        undoJournal = receipt.journal;
        return await installSnapshot(receipt.snapshot);
      }

      if (action === "undo") {
        if (!undoJournal) {
          throw new Error("没有可撤销的保存");
        }
        if (undoJournal.address !== device.address) {
          throw new Error("可撤销操作属于另一只手柄，请重新连接原设备");
        }
        emitStatus("正在撤销并回读核对…");
        const receipt = await execute(
          device,
          webStorage,
          "undo",
          undoEdits(undoJournal),
        );
        undoJournal = null;
        return await installSnapshot(receipt.snapshot);
      }

      if (action === "identify") {
        const recognized = await identifyRearSlotsWeb(
          device,
          webStorage,
          () => cancelFlag,
          emitStatus,
        );
        const s = await device.snapshot();
        await saveLabels(s, recognized);
        return await installSnapshot(s);
      }

      if (action === "recovery_preview") {
        const pend = await pending(webStorage);
        const j = pend.find((item) => item.id === request.id);
        if (!j) {
          throw new Error("未找到可恢复日志");
        }
        const current = await device.snapshot();
        const edits = await recoveryEdits(webStorage, j, current);
        return { recovery: j, edits, current };
      }

      if (action === "recover") {
        const pend = await pending(webStorage);
        const j = pend.find((item) => item.id === request.id);
        if (!j) {
          throw new Error("未找到可恢复日志");
        }
        const current = await device.snapshot();
        const edits = await recoveryEdits(webStorage, j, current);
        const after =
          edits.length === 0
            ? current
            : (await execute(device, webStorage, "recovery", edits)).snapshot;
        for (const e of j.records) {
          if (e.attempted) {
            e.state = "restored";
          }
        }
        j.state = "rolled_back";
        await persistJournal(webStorage, j);
        return await installSnapshot(after);
      }

      throw new Error("无效操作");
    } finally {
      await device.close();
    }
  });
}

export async function webInvoke<T = any>(
  cmd: string,
  args?: Record<string, any>,
): Promise<T> {
  switch (cmd) {
    case "initial": {
      const savedDev = await webStorage.get<{ address?: string }>("kv", "device");
      const cached = getCachedWebDeviceSummary();
      const keymap = await loadKeymapStore();
      const recoveries = await pending(webStorage);
      return {
        address: cached?.address || savedDev?.address || "",
        recoveries,
        version: "0.7.0",
        keymap,
        runner: webRunnerSnapshot(),
      } as T;
    }

    case "inputs":
      return readWebGamepads() as T;

    case "runner_state":
    case "keymap_dismiss_warning":
    case "keymap_set_recording":
      return webRunnerSnapshot() as T;

    case "keymap_set_enabled":
      throw new Error(
        "浏览器安全沙箱无法向外部游戏发送全局按键；请下载免安装 Windows 桌面版运行键盘宏引擎",
      );

    case "keymap_save_store": {
      const validated = validateKeymapStore(args?.store);
      await webStorage.put("kv", "keymap-profiles", validated);
      keymapCache = validated;
      return {
        keymap: validated,
        runner: webRunnerSnapshot(),
      } as T;
    }

    case "keymap_sync_bridge": {
      const s = requireBaseline();
      const slot = Number(args?.slot);
      const trigger = (args?.trigger ?? []) as PadButton[];
      return bridgeHoldChange(slot, trigger, s) as T;
    }

    case "keymap_import": {
      const bytes = await pickJsonFile(
        256 * 1024,
        "键盘宏配置文件超过 256 KiB",
      );
      const imported = importKeymapAny(bytes);
      const store = structuredClone(await loadKeymapStore());
      if (store.profiles.length >= 32) {
        throw new Error("方案数量已达上限（32 个），请先删除不用的方案");
      }
      store.profiles.push(imported);
      store.active_profile_id = imported.id;
      const saved = validateKeymapStore(store);
      await webStorage.put("kv", "keymap-profiles", saved);
      keymapCache = saved;
      return {
        keymap: saved,
        runner: webRunnerSnapshot(),
        message: `已导入键盘宏方案“${imported.name}”`,
      } as T;
    }

    case "keymap_export": {
      const store = await loadKeymapStore();
      const targetId = String(args?.profileId ?? args?.profile_id ?? "");
      const profile =
        store.profiles.find((p) => p.id === targetId) ??
        store.profiles.find((p) => p.id === store.active_profile_id) ??
        store.profiles[0];
      if (!profile) {
        throw new Error("未找到要导出的方案");
      }
      const exported = exportKeymapProfile(profile);
      const safeName = profile.name.replace(/[/\\:*?"<>|]/g, "_");
      downloadJson(`OPlus-keymap-${safeName}.json`, exported);
      return { message: `已导出方案“${profile.name}”` } as T;
    }

    case "export_diagnostic": {
      const s = requireBaseline();
      downloadJson("OPlus-diagnostic-bundle.json", diagnosticBundle(s));
      return { message: "已导出设备兼容诊断包" } as T;
    }

    case "preview": {
      const s = requireBaseline();
      const p = encodeForSlot(args?.change as Change, s, Number(args?.slot));
      return {
        payload: hexSpaced(p),
        program: parseProgram(p, snapshotLayout(s)),
      } as T;
    }

    case "cancel": {
      cancelFlag = true;
      return undefined as T;
    }

    case "run": {
      if (busy) {
        throw new Error("另一项操作正在进行，请等待完成");
      }
      busy = true;
      cancelFlag = false;
      try {
        return (await dispatchRun(args?.request ?? {})) as T;
      } finally {
        busy = false;
      }
    }

    default:
      throw new Error(`不支持的命令：${cmd}`);
  }
}
