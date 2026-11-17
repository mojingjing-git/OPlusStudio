/**
 * Transactional onboard write engine with conflict detection, SHA-256 backup
 * verification, reverse-order rollback (with 1x GATT reconnect retry),
 * and explicit crash recovery center.
 * 100% port of `oplus-core/src/transaction.rs`.
 */

import type { Journal, Snapshot } from "../types.ts";
import {
  boundary,
  bytesEqual,
  normalizeAgainst,
  normalizePayloadFor,
  recordBytes,
  recordFromPayload,
  snapshotRecord,
  supportTier,
  validateRear,
} from "./model.ts";
import {
  type Identity,
  effectiveGeneration,
  normalizeIdentity,
  sameIdentity,
} from "./protocol.ts";
import {
  type WebStorage,
  generateId,
  sha256Hex,
  utf8Encode,
} from "./storage.ts";

export interface Device {
  snapshot(): Promise<Snapshot>;
  read(key: string): Promise<number[]>;
  write(key: string, payload: readonly number[]): Promise<void>;
  reconnect?(): Promise<void>;
}

export interface Edit {
  key: string;
  expected: number[];
  target: number[];
}

export interface JournalEntry {
  key: string;
  original: number[];
  target: number[];
  attempted: boolean;
  state: string;
}

export interface DurableJournal extends Journal {
  schema: number;
  identity: Identity;
  backup: string;
  backup_sha256: string;
  records: JournalEntry[];
  errors: string[];
}

export interface Receipt {
  journal: DurableJournal;
  snapshot: Snapshot;
}

const VALID_KINDS = new Set([
  "save",
  "undo",
  "identification",
  "recovery",
  "validation",
]);

export function isTerminalJournal(j: { state: string }): boolean {
  return j.state === "completed" || j.state === "rolled_back";
}

export async function persistJournal(
  store: WebStorage,
  j: DurableJournal,
): Promise<void> {
  await store.put("journals", j.id, j);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function arrayNumEqual(a: number[] | undefined, b: number[] | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (!a || !b) return false;
  return bytesEqual(a, b);
}

export async function prepare(
  device: Device,
  store: WebStorage,
  kind: string,
  edits: Edit[],
): Promise<[DurableJournal, Snapshot]> {
  const snapshot = await device.snapshot();
  if (supportTier(snapshot) === "read_only") {
    throw new Error("当前设备处于只读诊断模式，禁止写入配置");
  }
  validateRear(snapshot);
  if (edits.length > 16) {
    throw new Error("单次事务修改记录数超出上限");
  }

  const seen = new Set<string>();
  const records: JournalEntry[] = [];

  for (const e of edits) {
    if (seen.has(e.key)) {
      throw new Error("同一记录重复提交");
    }
    seen.add(e.key);

    const original = normalizePayloadFor(
      snapshot,
      e.key,
      snapshotRecord(snapshot, e.key),
    );
    const expected = normalizeAgainst(e.key, e.expected, original);
    const target = normalizeAgainst(e.key, e.target, original);
    if (!bytesEqual(original, expected)) {
      throw new Error(`${e.key} 已被其他软件修改，请重新读取后比较`);
    }
    boundary(snapshot, e.key, original, target);
    if (!bytesEqual(original, target)) {
      records.push({
        key: e.key,
        original,
        target,
        attempted: false,
        state: "prepared",
      });
    }
  }

  if (records.length === 0) {
    throw new Error("没有需要保存的更改");
  }
  if (!VALID_KINDS.has(kind)) {
    throw new Error("未知事务类型");
  }

  const id = generateId();
  const backup = `backups/web-${id}.json`;
  const backupText = JSON.stringify(snapshot, null, 2);
  const backupBytes = utf8Encode(backupText);
  await store.put("backups", backup, backupText);
  const backupSha256 = await sha256Hex(backupBytes);

  const journal: DurableJournal = {
    schema: 1,
    id,
    kind,
    address: snapshot.address,
    identity: normalizeIdentity(snapshot.identity),
    backup,
    backup_sha256: backupSha256,
    state: "prepared",
    records,
    errors: [],
  };
  await persistJournal(store, journal);
  return [journal, snapshot];
}

export async function apply(
  device: Device,
  store: WebStorage,
  j: DurableJournal,
): Promise<void> {
  for (let i = 0; i < j.records.length; i++) {
    j.records[i].attempted = true;
    j.records[i].state = "write_intent";
    j.state = "writing";
    await persistJournal(store, j);

    const entry = j.records[i];
    await device.write(entry.key, entry.target);
    const readback = await device.read(entry.key);
    if (!bytesEqual(normalizeAgainst(entry.key, readback, entry.target), entry.target)) {
      throw new Error(`${entry.key} 保存后回读不一致`);
    }
    j.records[i].state = "verified";
    await persistJournal(store, j);
  }
  j.state = j.kind === "identification" ? "sampling" : "completed";
  await persistJournal(store, j);
}

export async function rollback(
  device: Device,
  store: WebStorage,
  j: DurableJournal,
): Promise<boolean> {
  j.state = "restoring";
  try {
    await persistJournal(store, j);
  } catch (e) {
    j.errors.push(`恢复日志：${errMsg(e)}`);
  }

  let reconnected = false;
  let ok = true;
  const deadline = Date.now() + 180_000;

  for (let i = j.records.length - 1; i >= 0; i--) {
    if (!j.records[i].attempted || j.records[i].state === "restored") {
      continue;
    }
    j.records[i].state = "restore_intent";
    try {
      await persistJournal(store, j);
    } catch {
      // Best effort before hardware restore; disk error recorded after restore attempt
    }

    const entry = {
      ...j.records[i],
      original: [...j.records[i].original],
      target: [...j.records[i].target],
    };

    const doRestoreOnce = async (): Promise<void> => {
      await device.write(entry.key, entry.original);
      const rb = await device.read(entry.key);
      if (!bytesEqual(normalizeAgainst(entry.key, rb, entry.original), entry.original)) {
        throw new Error("恢复回读不一致");
      }
    };

    let restoreErr: string | null = null;
    try {
      const budget = Math.max(1000, Math.min(25_000, deadline - Date.now()));
      await withTimeout(doRestoreOnce(), budget, "恢复记录超时");
    } catch (e) {
      restoreErr = errMsg(e);
    }

    if (restoreErr !== null && !reconnected && Date.now() < deadline && device.reconnect) {
      reconnected = true;
      try {
        const reconnectBudget = Math.max(1000, deadline - Date.now());
        await withTimeout(device.reconnect(), reconnectBudget, "重连超时");
        const retryBudget = Math.max(1000, Math.min(25_000, deadline - Date.now()));
        await withTimeout(doRestoreOnce(), retryBudget, "重连恢复超时");
        restoreErr = null;
      } catch (e2) {
        restoreErr = errMsg(e2);
      }
    }

    if (restoreErr === null) {
      j.records[i].state = "restored";
    } else {
      ok = false;
      j.errors.push(`${entry.key} 未确认恢复：${restoreErr}`);
    }

    try {
      await persistJournal(store, j);
    } catch (e) {
      ok = false;
      j.errors.push(`恢复状态落盘失败：${errMsg(e)}`);
    }
  }

  j.state = ok ? "rolled_back" : "recovery_required";
  try {
    await persistJournal(store, j);
  } catch {
    ok = false;
  }
  return ok;
}

export async function execute(
  device: Device,
  store: WebStorage,
  kind: string,
  edits: Edit[],
): Promise<Receipt> {
  const [j, before] = await prepare(device, store, kind, edits);
  try {
    await apply(device, store, j);
  } catch (e) {
    const message = errMsg(e);
    j.errors.push(message);
    const restored = await rollback(device, store, j);
    throw new Error(
      `${message}。${
        restored ? "已恢复全部原始记录" : "存在未确认的恢复，请查看恢复中心"
      }；日志 ${j.id}`,
    );
  }

  let snapshot: Snapshot;
  try {
    snapshot = await device.snapshot();
  } catch (e) {
    const nextRaw = { ...before.raw };
    for (const entry of j.records) {
      nextRaw[entry.key] = recordFromPayload(entry.target);
    }
    snapshot = {
      ...before,
      raw: nextRaw,
      errors: [
        ...(before.errors ?? []),
        `保存已核对，额外刷新失败：${errMsg(e)}`,
      ],
    };
  }
  return { journal: j, snapshot };
}

export function undoEdits(j: DurableJournal): Edit[] {
  if (j.state !== "completed" || j.kind === "identification") {
    throw new Error("这项操作不可撤销");
  }
  return j.records.map((e) => ({
    key: e.key,
    expected: [...e.target],
    target: [...e.original],
  }));
}

export async function validateJournal(
  store: WebStorage,
  j: DurableJournal,
): Promise<Snapshot> {
  if (
    !j ||
    j.schema !== 1 ||
    !j.identity ||
    effectiveGeneration(normalizeIdentity(j.identity)) !== 2 ||
    typeof j.id !== "string" ||
    j.id.length === 0 ||
    !/^[0-9-]+$/.test(j.id) ||
    !Array.isArray(j.records) ||
    j.records.length > 16
  ) {
    throw new Error("日志格式无效");
  }

  if (
    j.backup !== `backups/web-${j.id}.json` &&
    j.backup !== `backups/rust-${j.id}.json`
  ) {
    throw new Error("日志备份路径无效");
  }

  const backupText = await store.get<string>("backups", j.backup);
  if (typeof backupText !== "string") {
    throw new Error("未找到备份文件");
  }
  const backupBytes = utf8Encode(backupText);
  if (backupBytes.byteLength > 128 * 1024) {
    throw new Error("备份过大");
  }
  const actualHash = await sha256Hex(backupBytes);
  if (actualHash !== j.backup_sha256) {
    throw new Error("备份校验失败");
  }

  let snapshot: Snapshot;
  try {
    snapshot = JSON.parse(backupText) as Snapshot;
  } catch (e) {
    throw new Error(`备份损坏：${errMsg(e)}`);
  }

  if (
    snapshot.address !== j.address ||
    !sameIdentity(normalizeIdentity(snapshot.identity), normalizeIdentity(j.identity)) ||
    supportTier(snapshot) === "read_only"
  ) {
    throw new Error("备份设备不匹配或处于只读模式");
  }

  const seen = new Set<string>();
  for (const e of j.records) {
    if (seen.has(e.key)) {
      throw new Error("日志原始记录不匹配");
    }
    seen.add(e.key);
    const origNorm = normalizeAgainst(
      e.key,
      normalizePayloadFor(snapshot, e.key, snapshotRecord(snapshot, e.key)),
      e.original,
    );
    if (!bytesEqual(origNorm, e.original)) {
      throw new Error("日志原始记录不匹配");
    }
    boundary(snapshot, e.key, e.original, e.target);
  }
  return snapshot;
}

export async function pending(store: WebStorage): Promise<DurableJournal[]> {
  const out: DurableJournal[] = [];
  let items: { key: string; value: DurableJournal }[] = [];
  try {
    items = await store.listAll<DurableJournal>("journals");
  } catch {
    return out;
  }
  for (const { value: j } of items) {
    if (!j || isTerminalJournal(j)) continue;
    try {
      await validateJournal(store, j);
      out.push(j);
    } catch {
      // Invalid or corrupted journal ignored by pending()
    }
  }
  return out;
}

export async function recoveryEdits(
  store: WebStorage,
  j: DurableJournal,
  current: Snapshot,
): Promise<Edit[]> {
  const backup = await validateJournal(store, j);
  let capsMatch = false;
  try {
    capsMatch = bytesEqual(
      recordBytes(current.capabilities),
      recordBytes(backup.capabilities),
    );
  } catch {
    capsMatch = false;
  }

  if (
    supportTier(current) === "read_only" ||
    !sameIdentity(normalizeIdentity(current.identity), normalizeIdentity(j.identity)) ||
    current.address !== j.address ||
    !capsMatch ||
    !arrayNumEqual(current.decoded?.macro_keys, backup.decoded?.macro_keys) ||
    !arrayNumEqual(current.decoded?.remap_keys, backup.decoded?.remap_keys)
  ) {
    throw new Error("当前设备与日志不匹配");
  }

  const edits: Edit[] = [];
  for (const e of j.records) {
    if (!e.attempted || e.state === "restored") {
      continue;
    }
    const now = normalizeAgainst(
      e.key,
      normalizePayloadFor(current, e.key, snapshotRecord(current, e.key)),
      e.original,
    );
    if (bytesEqual(now, e.original)) {
      continue;
    }
    if (!bytesEqual(now, e.target)) {
      throw new Error(
        `${e.key} 存在未知外部修改，停止恢复。可将原备份作为草稿导入后比较`,
      );
    }
    edits.push({
      key: e.key,
      expected: now,
      target: [...e.original],
    });
  }
  return edits;
}
