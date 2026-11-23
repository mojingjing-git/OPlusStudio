/**
 * Self-contained Web Bluetooth transport & KeyLinker Gen2 `Device` session.
 * Includes real-hardware advertisement name-prefix filters (`致动O+_...`)
 * and session-level `BluetoothDevice` caching for chooser-free reconnects.
 */

import type { RecordData, Snapshot } from "../types.ts";
import {
  VERIFIED_137_CAPS,
  capabilityActiveSlots,
  claimsOPlus,
  hasPerSlotMacroLimits,
  hasRemapSelectList,
  hydrateOPlusDefaults,
  makeRecord,
  parseCapabilities,
  recordBytes,
  recordPayload,
  snapshotActiveSlots,
  snapshotCapabilities,
  supportTier,
} from "./model.ts";
import {
  type Identity,
  NOTIFY,
  type Packet,
  SERVICE,
  WRITE,
  decodeKeys,
  decodeMacroLimits,
  effectiveGeneration,
  frame,
  hostLength,
  isOPlusIdentity,
  nameClaimsOPlus,
  parse,
  parseIdentity,
  query,
  sameIdentity,
  saveSerial,
  toHex,
} from "./protocol.ts";
import type { Device } from "./transaction.ts";

export { NOTIFY, SERVICE, WRITE };

// ============================================================================
// Self-contained Web Bluetooth TypeScript Declarations
// ============================================================================

export interface WebBluetoothCharacteristicProperties {
  readonly write?: boolean;
  readonly writeWithoutResponse?: boolean;
  readonly notify?: boolean;
}

export interface WebBluetoothCharacteristicEvent extends Event {
  readonly target: (EventTarget & { value?: DataView | null }) | null;
}

export interface WebBluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly uuid: string;
  readonly properties: WebBluetoothCharacteristicProperties;
  readonly value?: DataView | null;
  startNotifications(): Promise<WebBluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<WebBluetoothRemoteGATTCharacteristic>;
  writeValueWithResponse?(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
  writeValue?(value: BufferSource): Promise<void>;
}

export interface WebBluetoothRemoteGATTService {
  readonly uuid: string;
  getCharacteristic(uuid: string): Promise<WebBluetoothRemoteGATTCharacteristic>;
}

export interface WebBluetoothRemoteGATTServer {
  readonly connected: boolean;
  connect(): Promise<WebBluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<WebBluetoothRemoteGATTService>;
}

export interface WebBluetoothDevice extends EventTarget {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: WebBluetoothRemoteGATTServer;
}

export interface WebBluetoothLEScanFilter {
  services?: string[];
  name?: string;
  namePrefix?: string;
}

export interface WebBluetoothRequestOptions {
  filters?: WebBluetoothLEScanFilter[];
  acceptAllDevices?: boolean;
  optionalServices?: string[];
}

export interface NavigatorBluetooth {
  requestDevice(options: WebBluetoothRequestOptions): Promise<WebBluetoothDevice>;
  getDevices?(): Promise<WebBluetoothDevice[]>;
  getAvailability?(): Promise<boolean>;
}

// ============================================================================
// Browser Support, Device Cache & BeforeUnload Guard
// ============================================================================

let cachedDevice: WebBluetoothDevice | null = null;
const knownDevicesById = new Map<
  string,
  { device: WebBluetoothDevice; seenInGetDevices: boolean }
>();
let activeUnloadGuards = 0;

function onBeforeUnload(e: BeforeUnloadEvent): void {
  e.preventDefault();
  e.returnValue = "";
}

export async function withBeforeUnloadGuard<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof window !== "undefined") {
    if (activeUnloadGuards === 0) {
      window.addEventListener("beforeunload", onBeforeUnload);
    }
    activeUnloadGuards += 1;
  }
  try {
    return await fn();
  } finally {
    if (typeof window !== "undefined") {
      activeUnloadGuards = Math.max(0, activeUnloadGuards - 1);
      if (activeUnloadGuards === 0) {
        window.removeEventListener("beforeunload", onBeforeUnload);
      }
    }
  }
}

export function getNavigatorBluetooth(): NavigatorBluetooth | null {
  if (typeof navigator === "undefined") return null;
  const bt = (navigator as unknown as { bluetooth?: NavigatorBluetooth }).bluetooth;
  if (!bt || typeof bt.requestDevice !== "function") return null;
  return bt;
}

export function isWebBluetoothSupported(): boolean {
  return getNavigatorBluetooth() !== null;
}

export function formatWebDeviceAddress(device: WebBluetoothDevice): string {
  const shortId = (device.id || "unknown").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 10) || "ble";
  const label = device.name?.trim();
  return label ? `${label} [${shortId}]` : `BLE-${shortId}`;
}

export function getCachedWebDeviceSummary(): {
  id: string;
  name: string;
  address: string;
} | null {
  if (!cachedDevice) return null;
  return {
    id: cachedDevice.id,
    name: cachedDevice.name?.trim() || "已授权蓝牙手柄",
    address: formatWebDeviceAddress(cachedDevice),
  };
}

export function setCachedWebDeviceForTest(device: WebBluetoothDevice | null): void {
  cachedDevice = device;
  if (!device) {
    knownDevicesById.clear();
  } else {
    knownDevicesById.set(device.id, { device, seenInGetDevices: false });
  }
}

export async function rememberWebBluetoothDevice(
  device: WebBluetoothDevice,
): Promise<void> {
  let seenInGetDevices = false;
  const bt = getNavigatorBluetooth();
  if (bt && typeof bt.getDevices === "function") {
    try {
      const permitted = await bt.getDevices();
      seenInGetDevices = permitted.some((d) => d.id === device.id);
    } catch {
      seenInGetDevices = false;
    }
  }
  cachedDevice = device;
  knownDevicesById.set(device.id, { device, seenInGetDevices });
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function translateBleError(err: unknown): Error {
  if (err instanceof Error) {
    if (
      err.name === "NotFoundError" ||
      /User cancelled|cancelled the requestDevice/i.test(err.message)
    ) {
      return new Error("已取消设备选择");
    }
    if (err.name === "SecurityError") {
      return new Error(
        "浏览器蓝牙权限需要用户点击触发且处于 HTTPS 或 localhost 安全上下文",
      );
    }
    if (err.name === "NotSupportedError") {
      return new Error("当前浏览器或系统不支持该蓝牙操作，请使用桌面版 Edge 或 Chrome");
    }
    if (err.name === "NetworkError") {
      return new Error(
        "蓝牙连接断开或手柄未响应，请确认手柄已开机、退出手机 KeyLinker 后重试",
      );
    }
    return err;
  }
  return new Error(String(err));
}

export async function acquireWebBluetoothDevice(options?: {
  forcePicker?: boolean;
  showAll?: boolean;
  preferredAddress?: string;
  preferredDeviceId?: string;
  requireExactDevice?: boolean;
  allowPickerForExactDevice?: boolean;
}): Promise<WebBluetoothDevice> {
  const bt = getNavigatorBluetooth();
  if (!bt) {
    throw new Error(
      "当前浏览器不支持 Web Bluetooth，请使用桌面版 Microsoft Edge 或 Google Chrome 打开本页",
    );
  }

  const forcePicker = Boolean(options?.forcePicker);
  const showAll = Boolean(options?.showAll);
  const requireExactDevice = Boolean(options?.requireExactDevice);
  const allowPickerForExactDevice = Boolean(options?.allowPickerForExactDevice);
  const preferredDeviceId = options?.preferredDeviceId?.trim() || "";
  const preferredAddress = options?.preferredAddress?.trim() || "";

  const reqOptions: WebBluetoothRequestOptions = showAll
    ? {
        acceptAllDevices: true,
        optionalServices: [SERVICE],
      }
    : {
        filters: [
          { namePrefix: "致动" },
          { namePrefix: "O+" },
          { namePrefix: "o+" },
          { namePrefix: "ZD" },
          { namePrefix: "KeyLink" },
          { services: [SERVICE] },
        ],
        optionalServices: [SERVICE],
      };

  if (requireExactDevice) {
    let permitted: WebBluetoothDevice[] | null = null;
    if (typeof bt.getDevices === "function") {
      try {
        permitted = await bt.getDevices();
      } catch {
        permitted = null;
      }
    }

    if (preferredDeviceId) {
      if (permitted !== null) {
        const hit = permitted.find((d) => d.id === preferredDeviceId);
        if (hit) {
          knownDevicesById.set(hit.id, { device: hit, seenInGetDevices: true });
          return hit;
        }
        const known = knownDevicesById.get(preferredDeviceId);
        if (known && !known.seenInGetDevices && permitted.length === 0) {
          return known.device;
        }
        if (known?.seenInGetDevices) {
          knownDevicesById.delete(preferredDeviceId);
          if (cachedDevice?.id === preferredDeviceId) {
            cachedDevice = null;
          }
        }
      } else {
        const known = knownDevicesById.get(preferredDeviceId)?.device;
        if (known) return known;
        if (cachedDevice && cachedDevice.id === preferredDeviceId) {
          return cachedDevice;
        }
      }

      if (allowPickerForExactDevice) {
        try {
          const picked = await bt.requestDevice(reqOptions);
          if (picked.id !== preferredDeviceId) {
            throw new Error("所选手柄与目标恢复记录不是同一台设备，已停止操作");
          }
          return picked;
        } catch (e) {
          throw translateBleError(e);
        }
      }
      throw new Error(
        "未找到原目标手柄授权连接，已停止写入以防写错设备；请重新连接原手柄读取后再试",
      );
    }

    if (preferredAddress) {
      if (permitted !== null) {
        const hits = permitted.filter(
          (d) => formatWebDeviceAddress(d) === preferredAddress,
        );
        if (hits.length === 1) return hits[0];
        if (hits.length > 1) {
          throw new Error("检测到多只同名蓝牙手柄，请重新选择并读取目标手柄");
        }
        if (
          permitted.length === 0 &&
          cachedDevice &&
          formatWebDeviceAddress(cachedDevice) === preferredAddress
        ) {
          return cachedDevice;
        }
      } else if (
        cachedDevice &&
        formatWebDeviceAddress(cachedDevice) === preferredAddress
      ) {
        return cachedDevice;
      }

      if (allowPickerForExactDevice) {
        try {
          const picked = await bt.requestDevice(reqOptions);
          if (formatWebDeviceAddress(picked) !== preferredAddress) {
            throw new Error("所选手柄与目标恢复记录不匹配，已停止操作");
          }
          return picked;
        } catch (e) {
          throw translateBleError(e);
        }
      }
      throw new Error(
        "未找到原目标手柄授权连接，已停止写入以防写错设备；请重新连接原手柄读取后再试",
      );
    }

    throw new Error("缺少目标手柄完整设备标识，已停止写入");
  }

  if (!forcePicker) {
    let permitted: WebBluetoothDevice[] | null = null;
    if (typeof bt.getDevices === "function") {
      try {
        permitted = await bt.getDevices();
      } catch {
        permitted = null;
      }
    }

    if (permitted !== null) {
      const byId = preferredDeviceId
        ? permitted.find((d) => d.id === preferredDeviceId)
        : undefined;
      if (byId) return byId;

      const byAddr = preferredAddress
        ? permitted.find((d) => formatWebDeviceAddress(d) === preferredAddress)
        : undefined;
      if (byAddr) return byAddr;

      if (!preferredDeviceId && !preferredAddress && permitted.length === 1) {
        return permitted[0];
      }
    }

    if (cachedDevice) {
      const known = knownDevicesById.get(cachedDevice.id);
      const revoked =
        permitted !== null &&
        Boolean(known?.seenInGetDevices) &&
        !permitted.some((d) => d.id === cachedDevice!.id);
      if (
        !revoked &&
        ((preferredDeviceId && cachedDevice.id === preferredDeviceId) ||
          (!preferredDeviceId &&
            (!preferredAddress ||
              formatWebDeviceAddress(cachedDevice) === preferredAddress)))
      ) {
        return cachedDevice;
      }
    }
  }

  try {
    return await bt.requestDevice(reqOptions);
  } catch (e) {
    throw translateBleError(e);
  }
}

export function readSpec(key: string): [number, number[]] {
  if (key.startsWith("macro_")) {
    const rest = key.slice(6);
    if (!/^[0-9]+$/.test(rest)) {
      throw new Error("无效槽位");
    }
    const slot = Number(rest);
    if (slot >= 0 && slot < 8) {
      return [0xb5, [0, slot]];
    }
    throw new Error("无效槽位");
  }
  switch (key) {
    case "sticks":
      return [0xb1, [0]];
    case "triggers":
      return [0xb2, [0]];
    case "motors":
      return [0xb3, [0]];
    case "remapping":
      return [0xb6, [0]];
    case "lighting":
      return [0xb7, [0]];
    default:
      throw new Error("不支持读取此记录");
  }
}

export interface WebBleSessionOptions {
  requestTimeoutMs?: number;
  chunkDelayMs?: number;
}

export class WebBleSession implements Device {
  private device: WebBluetoothDevice;
  private server: WebBluetoothRemoteGATTServer | null = null;
  private writeChar: WebBluetoothRemoteGATTCharacteristic | null = null;
  private notifyChar: WebBluetoothRemoteGATTCharacteristic | null = null;
  private onValueChanged: ((ev: Event) => void) | null = null;
  private pendingExchange: {
    serial: number;
    resolve: (packet: Packet) => void;
    reject: (err: Error) => void;
  } | null = null;
  private gattQueue: Promise<void> = Promise.resolve();

  public identity: Identity = {
    vid: "",
    pid: "",
    version_display: "",
    mode: 0,
    generation: 0,
    sensor: 0,
  };
  public readonly deviceId: string;
  public address: string;
  public isOPlus = false;
  public canWrite = false;
  public writableSlots: number[] = [];
  public trace: Record<string, unknown>[] = [];

  private serial = 0;
  private writeCounter = 0;
  private hostCounter = 0;
  private readonly requestTimeoutMs: number;
  private readonly chunkDelayMs: number;

  private constructor(
    device: WebBluetoothDevice,
    opts?: WebBleSessionOptions,
  ) {
    this.device = device;
    this.deviceId = device.id;
    this.address = formatWebDeviceAddress(device);
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 3000;
    this.chunkDelayMs = opts?.chunkDelayMs ?? 120;
  }

  static async connectDevice(
    device: WebBluetoothDevice,
    opts?: WebBleSessionOptions,
  ): Promise<WebBleSession> {
    const session = new WebBleSession(device, opts);
    try {
      await session.openGattAndIdentify();
      return session;
    } catch (e) {
      await session.close();
      throw translateBleError(e);
    }
  }

  private async openGattAndIdentify(): Promise<void> {
    if (!this.device.gatt) {
      throw new Error("所选蓝牙设备不支持 GATT 连接");
    }
    const server = await withTimeout(
      this.device.gatt.connect(),
      12_000,
      "蓝牙连接超时，请确认手柄已开机且已退出手机 KeyLinker",
    );
    this.server = server;

    let service: WebBluetoothRemoteGATTService;
    try {
      service = await withTimeout(
        server.getPrimaryService(SERVICE),
        12_000,
        "发现手柄服务超时",
      );
    } catch {
      throw new Error(
        "该设备未公开 KeyLinker 配置服务（请确认选择的是致动 / KeyLinker 蓝牙手柄，且未处于仅充电状态）",
      );
    }

    let writeChar: WebBluetoothRemoteGATTCharacteristic;
    let notifyChar: WebBluetoothRemoteGATTCharacteristic;
    try {
      writeChar = await service.getCharacteristic(WRITE);
    } catch {
      throw new Error("缺少配置写入特征");
    }
    try {
      notifyChar = await service.getCharacteristic(NOTIFY);
    } catch {
      throw new Error("缺少配置通知特征");
    }

    this.pendingExchange = null;
    const listener = (ev: Event) => {
      const target = (ev as WebBluetoothCharacteristicEvent).target ?? notifyChar;
      const dv = target?.value;
      if (!dv) return;
      const copy = new Uint8Array(dv.byteLength);
      copy.set(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
      let packet: Packet;
      try {
        packet = parse(copy);
      } catch {
        return;
      }
      this.pushTrace({
        direction: "rx",
        opcode: packet.opcode,
        serial: packet.serial,
        payload: toHex(packet.payload),
        wire: toHex(copy),
      });
      const active = this.pendingExchange;
      if (active && packet.opcode === 0x19 && packet.serial === active.serial) {
        active.resolve(packet);
      }
    };

    notifyChar.addEventListener("characteristicvaluechanged", listener);
    this.onValueChanged = listener;
    this.writeChar = writeChar;
    this.notifyChar = notifyChar;

    await withTimeout(notifyChar.startNotifications(), 3000, "订阅手柄通知超时");

    const idPacket = await this.sendQuery(0x91, []);
    this.identity = parseIdentity(idPacket.payload);
    this.isOPlus =
      isOPlusIdentity(this.identity) ||
      nameClaimsOPlus(this.address) ||
      nameClaimsOPlus(this.device.name);
  }

  private enqueueGatt<T>(op: () => Promise<T>): Promise<T> {
    const run = this.gattQueue.then(op, op);
    this.gattQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private nonce(): number {
    if (typeof globalThis.crypto?.getRandomValues === "function") {
      const b = new Uint8Array(1);
      globalThis.crypto.getRandomValues(b);
      return b[0];
    }
    return Math.floor(Math.random() * 256) & 0xff;
  }

  private pushTrace(entry: Record<string, unknown>): void {
    if (this.trace.length >= 512) {
      this.trace.shift();
    }
    this.trace.push(entry);
  }

  private async writeWire(wire: Uint8Array): Promise<void> {
    const ch = this.writeChar;
    if (!ch || !this.server?.connected) {
      throw new Error("蓝牙配置连接已断开");
    }
    const buf = new ArrayBuffer(wire.byteLength);
    new Uint8Array(buf).set(wire);

    if (ch.properties?.write && typeof ch.writeValueWithResponse === "function") {
      await ch.writeValueWithResponse(buf);
    } else if (typeof ch.writeValueWithoutResponse === "function") {
      await ch.writeValueWithoutResponse(buf);
    } else if (typeof ch.writeValue === "function") {
      await ch.writeValue(buf);
    } else {
      throw new Error("浏览器不支持特征写入方法");
    }
  }

  private async exchange(wire: Uint8Array): Promise<Packet> {
    return this.enqueueGatt(async () => {
      const sent = parse(wire);
      this.pushTrace({
        direction: "tx",
        opcode: sent.opcode,
        serial: sent.serial,
        payload: toHex(sent.payload),
        wire: toHex(wire),
      });

      if (this.pendingExchange) {
        this.pendingExchange.reject(new Error("上一条蓝牙请求已被新请求取代"));
        this.pendingExchange = null;
      }

      let timer: ReturnType<typeof setTimeout> | null = null;
      let entryRef: {
        serial: number;
        resolve: (packet: Packet) => void;
        reject: (err: Error) => void;
      } | null = null;
      let writeSettled = false;
      let writePromise: Promise<void> = Promise.resolve();

      try {
        const packetPromise = new Promise<Packet>((resolve, reject) => {
          entryRef = {
            serial: sent.serial,
            resolve,
            reject,
          };
          this.pendingExchange = entryRef;
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("手柄响应超时，请保持开机并关闭手机 KeyLinker"));
          }, this.requestTimeoutMs);
        });

        writePromise = this.writeWire(wire).finally(() => {
          writeSettled = true;
        });
        writePromise.catch(() => undefined);
        packetPromise.catch(() => undefined);

        const [, packet] = await Promise.race([
          Promise.all([writePromise, packetPromise]),
          timeoutPromise,
        ]);
        return packet;
      } finally {
        if (timer !== null) {
          clearTimeout(timer);
        }
        if (entryRef && this.pendingExchange === entryRef) {
          this.pendingExchange = null;
        }
        if (!writeSettled) {
          await Promise.race([
            writePromise.catch(() => undefined),
            sleep(250),
          ]);
        }
      }
    });
  }

  private async sendQuery(opcode: number, payload: readonly number[]): Promise<Packet> {
    this.serial += 1;
    const serial =
      ((this.serial % 128) | (this.serial % 2 === 0 ? 128 : 0)) & 0xff;
    const wire = query(
      opcode,
      payload,
      serial,
      this.nonce(),
      effectiveGeneration(this.identity) === 2 || this.isOPlus,
    );
    return this.exchange(wire);
  }

  private async readPagedRecord(
    op: number,
    args: readonly number[],
  ): Promise<RecordData> {
    const first = await this.sendQuery(op, args);
    if (first.payload.length === 0) {
      throw new Error("响应缺少记录长度");
    }
    const declared = first.payload[0] & 0xff;
    const data = first.payload.slice(1);
    for (let page = 1; page < 32; page++) {
      if (data.length >= declared) break;
      const nextArgs = [...args];
      nextArgs[0] = page;
      const more = await this.sendQuery(op, nextArgs);
      if (more.payload.length === 0) {
        throw new Error("分段响应为空");
      }
      data.push(...more.payload);
    }
    if (data.length !== declared) {
      throw new Error("记录声明长度与分段响应不一致");
    }
    return makeRecord(data);
  }

  private async readSnapshotRecord(
    op: number,
    args: readonly number[],
  ): Promise<RecordData> {
    try {
      return await this.readPagedRecord(op, args);
    } catch {
      await sleep(60);
      return this.readPagedRecord(op, args);
    }
  }

  async snapshot(): Promise<Snapshot> {
    this.canWrite = false;
    this.writableSlots = [];

    const raw: Record<string, RecordData | undefined> = {};
    const decoded: Snapshot["decoded"] = {};
    const errors: string[] = [];

    // Best-effort 0x90 controller internal name read
    try {
      const nameRec = await this.readPagedRecord(0x90, [0]);
      const bytes = recordBytes(nameRec);
      const clean = new TextDecoder("utf-8", { fatal: false })
        .decode(new Uint8Array(bytes))
        .replace(/[\u0000-\u001f\u007f]+/g, "")
        .trim();
      if (clean.length > 0) {
        decoded.device_name = clean;
      } else if (this.device.name?.trim()) {
        decoded.device_name = this.device.name.trim();
      }
    } catch {
      if (this.device.name?.trim()) {
        decoded.device_name = this.device.name.trim();
      }
    }
    if (nameClaimsOPlus(decoded.device_name)) {
      this.isOPlus = true;
    }

    // Read capability descriptor 0xB0 kind 1; O+ controllers fall back to standard O+ capabilities
    let capabilities: RecordData;
    try {
      capabilities = await this.readSnapshotRecord(0xb0, [0, 1]);
    } catch (e) {
      if (!this.isOPlus) {
        errors.push(
          `读取能力描述符失败（已降级为只读诊断模式）：${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return {
          address: this.address,
          device_id: this.deviceId,
          identity: { ...this.identity },
          raw,
          decoded,
          capabilities: makeRecord([]),
          errors,
        };
      }
      errors.push(
        `读取能力描述符失败（已按 O+ 默认能力开放编辑）：${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      capabilities = makeRecord(VERIFIED_137_CAPS);
    }

    const effGen = effectiveGeneration(this.identity);
    if (effGen !== 2 && !this.isOPlus) {
      for (const [field, kind] of [
        ["all_keys", 2],
        ["remap_keys", 3],
        ["macro_keys", 5],
      ] as const) {
        try {
          const r = await this.readPagedRecord(0xb0, [0, kind]);
          try {
            decoded[field] = decodeKeys(recordBytes(r));
          } catch {
            // Keep raw even if key table fails decoding
          }
          raw[field] = r;
        } catch {
          // Optional on non-Gen2
        }
      }
      errors.push(
        `设备协议有效代际为 ${effGen}（非 KeyLinker 第二代协议），已开放只读查看与诊断导出`,
      );
      return {
        address: this.address,
        device_id: this.deviceId,
        identity: { ...this.identity },
        raw,
        decoded,
        capabilities,
        errors,
      };
    }

    let caps: ReturnType<typeof parseCapabilities>;
    try {
      caps = parseCapabilities(capabilities);
    } catch (e) {
      if (!this.isOPlus) {
        errors.push(
          `解析能力描述符失败（已降级为只读模式）：${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return {
          address: this.address,
          device_id: this.deviceId,
          identity: { ...this.identity },
          raw,
          decoded,
          capabilities,
          errors,
        };
      }
      errors.push(
        `解析能力描述符失败（已按 O+ 默认能力开放编辑）：${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      capabilities = makeRecord(VERIFIED_137_CAPS);
      caps = parseCapabilities(capabilities);
    }

    // Read all_keys (kind 2)
    try {
      const r = await this.readSnapshotRecord(0xb0, [0, 2]);
      try {
        decoded.all_keys = decodeKeys(recordBytes(r));
      } catch (e) {
        errors.push(`解码 all_keys 失败：${e instanceof Error ? e.message : String(e)}`);
      }
      raw.all_keys = r;
    } catch (e) {
      errors.push(`读取 all_keys 失败：${e instanceof Error ? e.message : String(e)}`);
    }

    // Read remap_keys (kind 3) and optional remap_targets (kind 7)
    if (caps.changekey !== 0) {
      try {
        const r = await this.readSnapshotRecord(0xb0, [0, 3]);
        try {
          decoded.remap_keys = decodeKeys(recordBytes(r));
        } catch (e) {
          errors.push(`解码 remap_keys 失败：${e instanceof Error ? e.message : String(e)}`);
        }
        raw.remap_keys = r;
      } catch (e) {
        errors.push(`读取 remap_keys 失败：${e instanceof Error ? e.message : String(e)}`);
      }

      if (hasRemapSelectList(caps)) {
        try {
          const r = await this.readSnapshotRecord(0xb0, [0, 7]);
          try {
            decoded.remap_targets = decodeKeys(recordBytes(r));
          } catch (e) {
            errors.push(
              `解码 remap_targets 失败：${e instanceof Error ? e.message : String(e)}`,
            );
          }
          raw.remap_targets = r;
        } catch (e) {
          errors.push(
            `读取 remap_targets 失败：${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    // Read macro_keys (kind 5) and optional macro_limits (kind 6)
    if (caps.macros !== 0) {
      try {
        const r = await this.readSnapshotRecord(0xb0, [0, 5]);
        try {
          decoded.macro_keys = decodeKeys(recordBytes(r));
        } catch (e) {
          errors.push(`解码 macro_keys 失败：${e instanceof Error ? e.message : String(e)}`);
        }
        raw.macro_keys = r;
      } catch (e) {
        errors.push(`读取 macro_keys 失败：${e instanceof Error ? e.message : String(e)}`);
      }

      if (hasPerSlotMacroLimits(caps)) {
        try {
          const r = await this.readSnapshotRecord(0xb0, [0, 6]);
          try {
            decoded.macro_limits = decodeMacroLimits(recordBytes(r));
          } catch (e) {
            errors.push(
              `解码 macro_limits 失败：${e instanceof Error ? e.message : String(e)}`,
            );
          }
          raw.macro_limits = r;
        } catch (e) {
          errors.push(
            `读取 macro_limits 失败：${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    // Read setting records strictly on-demand according to capability bits
    for (const [enabled, name, op] of [
      [caps.sticks !== 0, "sticks", 0xb1],
      [caps.triggers !== 0, "triggers", 0xb2],
      [caps.motors !== 0, "motors", 0xb3],
      [caps.changekey !== 0, "remapping", 0xb6],
      [caps.lighting !== 0, "lighting", 0xb7],
    ] as const) {
      if (enabled) {
        try {
          raw[name] = await this.readSnapshotRecord(op, [0]);
        } catch (e) {
          errors.push(`读取 ${name} 失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    for (const slot of capabilityActiveSlots(caps)) {
      try {
        raw[`macro_${slot}`] = await this.readSnapshotRecord(0xb5, [0, slot]);
      } catch (e) {
        errors.push(
          `读取 macro_${slot} 失败：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const snap: Snapshot = {
      address: this.address,
      device_id: this.deviceId,
      identity: { ...this.identity },
      raw,
      decoded,
      capabilities,
      errors,
    };

    if (claimsOPlus(snap)) {
      this.isOPlus = true;
      hydrateOPlusDefaults(snap);
    }

    if (supportTier(snap) !== "read_only") {
      this.canWrite = true;
      this.writableSlots = snapshotActiveSlots(snap);
    }
    return snap;
  }

  async read(key: string): Promise<number[]> {
    const [op, args] = readSpec(key);
    const rec = await this.readPagedRecord(op, args);
    return recordPayload(rec);
  }

  async write(key: string, payload: readonly number[]): Promise<void> {
    if (!this.canWrite || (effectiveGeneration(this.identity) !== 2 && !this.isOPlus)) {
      throw new Error("当前设备处于只读模式，禁止写入");
    }
    if (
      payload.length === 0 ||
      payload.length > 240 ||
      (payload[0] & 0xff) !== payload.length - 1
    ) {
      throw new Error("记录前缀长度或分片边界无效");
    }

    let op: number;
    let slot: number | null = null;

    if (key.startsWith("macro_")) {
      const rest = key.slice(6);
      if (!/^[0-9]+$/.test(rest)) {
        throw new Error("无效槽位");
      }
      const parsedSlot = Number(rest);
      if (
        parsedSlot < 0 ||
        parsedSlot >= 8 ||
        !this.writableSlots.includes(parsedSlot) ||
        payload.length < 8 ||
        payload.length > 238 ||
        (payload.length - 3) % 5 !== 0
      ) {
        throw new Error("宏记录结构或槽位无效");
      }
      op = 0x35;
      slot = parsedSlot;
    } else if (key === "sticks") {
      if (payload.length !== 15) {
        throw new Error("摇杆记录长度超出安全边界");
      }
      op = 0x31;
    } else if (key === "triggers") {
      if (payload.length !== 15) {
        throw new Error("扳机记录长度超出安全边界");
      }
      op = 0x32;
    } else if (key === "motors") {
      if (payload.length < 5 || payload.length > 240) {
        throw new Error("马达记录长度超出安全边界");
      }
      op = 0x33;
    } else if (key === "remapping") {
      if (payload.length < 2 || payload.length > 240) {
        throw new Error("改键记录长度超出安全边界");
      }
      op = 0x36;
    } else if (key === "lighting") {
      if (
        payload.length < 7 ||
        payload.length > 240 ||
        (payload.length - 1) % 6 !== 0
      ) {
        throw new Error("灯光记录长度超出安全边界");
      }
      op = 0x37;
    } else {
      throw new Error("不支持写入此记录");
    }

    let chunk = 0;
    for (let offset = 0; offset < payload.length; offset += 15) {
      const piece = payload.slice(offset, offset + 15);
      this.writeCounter += 1;
      const serial = saveSerial(chunk, this.writeCounter);
      let lengthByte: number;
      if (slot !== null) {
        lengthByte = ((slot << 5) | (piece.length + 5)) & 0xff;
      } else {
        this.hostCounter = ((this.hostCounter - 1) & 0xff) % 8;
        lengthByte = hostLength(piece.length, this.hostCounter);
      }
      const wire = frame(op, piece, serial, this.nonce(), lengthByte);
      await this.exchange(wire);
      await sleep(this.chunkDelayMs);
      chunk += 1;
    }
  }

  async reconnect(): Promise<void> {
    const expected = { ...this.identity };
    const prevIsOPlus = this.isOPlus;
    const prevCanWrite = this.canWrite;
    const prevSlots = [...this.writableSlots];

    await this.close();
    await sleep(250);
    await this.openGattAndIdentify();

    if (!sameIdentity(this.identity, expected)) {
      await this.close();
      throw new Error("重连设备身份与原设备不同，已停止恢复");
    }
    this.isOPlus = this.isOPlus || prevIsOPlus;
    this.canWrite = prevCanWrite;
    this.writableSlots = prevSlots;
  }

  async close(): Promise<void> {
    if (this.pendingExchange) {
      const pending = this.pendingExchange;
      this.pendingExchange = null;
      pending.reject(new Error("设备通知已断开"));
    }
    if (this.notifyChar && this.onValueChanged) {
      this.notifyChar.removeEventListener(
        "characteristicvaluechanged",
        this.onValueChanged,
      );
    }
    this.onValueChanged = null;
    const notify = this.notifyChar;
    if (notify && this.server?.connected) {
      try {
        await withTimeout(
          this.enqueueGatt(() => notify.stopNotifications()),
          1500,
          "stop timeout",
        );
      } catch {
        // Ignore stopNotifications failures during disconnect
      }
    }
    this.notifyChar = null;
    this.writeChar = null;
    if (this.server?.connected) {
      try {
        this.server.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
    this.server = null;
  }
}
