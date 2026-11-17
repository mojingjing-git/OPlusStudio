/**
 * Durable browser persistence backed by IndexedDB (`OPlusStudioWebDB` with
 * `kv`, `backups`, `journals` stores), WebCrypto SHA-256 checksums,
 * automatic in-memory fallback for headless/Node environments,
 * and browser file picker / JSON download helpers.
 */

import { toHex } from "./protocol.ts";

export const DB_NAME = "OPlusStudioWebDB";
export const DB_VERSION = 1;
export type StoreName = "kv" | "backups" | "journals";

export interface WebStorage {
  get<T = unknown>(store: StoreName, key: string): Promise<T | undefined>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  listKeys(store: StoreName): Promise<string[]>;
  listAll<T = unknown>(store: StoreName): Promise<{ key: string; value: T }[]>;
}

let idSequence = 0;

export function generateId(): string {
  idSequence += 1;
  const rand = Math.floor(Math.random() * 900000) + 100000;
  return `${Date.now()}-${rand}-${idSequence}`;
}

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text.startsWith("\ufeff") ? text.slice(1) : text;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const raw = typeof data === "string" ? utf8Encode(data) : data;
  const ab = new ArrayBuffer(raw.byteLength);
  new Uint8Array(ab).set(raw);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", ab);
  return toHex(new Uint8Array(digest));
}

export async function labelStorageKey(address: string): Promise<string> {
  const h = await sha256Hex(address.toUpperCase());
  return `rear-labels-${h.slice(0, 16)}`;
}

export function createMemoryStorage(): WebStorage {
  const maps: Record<StoreName, Map<string, string>> = {
    kv: new Map(),
    backups: new Map(),
    journals: new Map(),
  };

  return {
    async get<T = unknown>(store: StoreName, key: string): Promise<T | undefined> {
      const raw = maps[store].get(key);
      if (raw === undefined) return undefined;
      return JSON.parse(raw) as T;
    },
    async put(store: StoreName, key: string, value: unknown): Promise<void> {
      maps[store].set(key, JSON.stringify(value));
    },
    async delete(store: StoreName, key: string): Promise<void> {
      maps[store].delete(key);
    },
    async listKeys(store: StoreName): Promise<string[]> {
      return Array.from(maps[store].keys());
    },
    async listAll<T = unknown>(
      store: StoreName,
    ): Promise<{ key: string; value: T }[]> {
      const out: { key: string; value: T }[] = [];
      for (const [key, raw] of maps[store].entries()) {
        out.push({ key, value: JSON.parse(raw) as T });
      }
      return out;
    },
  };
}

function openIndexedDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ["kv", "backups", "journals"] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(new Error(req.error?.message || "无法打开浏览器本地数据库"));
  });
}

function createIndexedDbStorage(): WebStorage {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const fallback = createMemoryStorage();
  let useFallback = false;

  const getDb = async (): Promise<IDBDatabase | null> => {
    if (useFallback || typeof globalThis.indexedDB === "undefined") {
      useFallback = true;
      return null;
    }
    if (!dbPromise) {
      dbPromise = openIndexedDb().catch(() => {
        useFallback = true;
        return null as unknown as IDBDatabase;
      });
    }
    return dbPromise;
  };

  return {
    async get<T = unknown>(store: StoreName, key: string): Promise<T | undefined> {
      const db = await getDb();
      if (!db) return fallback.get<T>(store, key);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => {
          resolve(req.result === undefined ? undefined : (structuredClone(req.result) as T));
        };
        req.onerror = () =>
          reject(new Error(req.error?.message || "读取本地存储失败"));
      });
    },

    async put(store: StoreName, key: string, value: unknown): Promise<void> {
      const db = await getDb();
      if (!db) return fallback.put(store, key, value);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(structuredClone(value), key);
        tx.oncomplete = () => resolve();
        tx.onerror = () =>
          reject(new Error(tx.error?.message || "写入本地存储失败"));
        tx.onabort = () =>
          reject(new Error(tx.error?.message || "本地存储事务中断"));
      });
    },

    async delete(store: StoreName, key: string): Promise<void> {
      const db = await getDb();
      if (!db) return fallback.delete(store, key);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () =>
          reject(new Error(tx.error?.message || "删除本地存储失败"));
      });
    },

    async listKeys(store: StoreName): Promise<string[]> {
      const db = await getDb();
      if (!db) return fallback.listKeys(store);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).getAllKeys();
        req.onsuccess = () => resolve(req.result.map(String));
        req.onerror = () =>
          reject(new Error(req.error?.message || "枚举本地存储键失败"));
      });
    },

    async listAll<T = unknown>(
      store: StoreName,
    ): Promise<{ key: string; value: T }[]> {
      const db = await getDb();
      if (!db) return fallback.listAll<T>(store);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const os = tx.objectStore(store);
        const out: { key: string; value: T }[] = [];
        const req = os.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            out.push({
              key: String(cursor.key),
              value: structuredClone(cursor.value) as T,
            });
            cursor.continue();
          } else {
            resolve(out);
          }
        };
        req.onerror = () =>
          reject(new Error(req.error?.message || "读取本地列表失败"));
      });
    },
  };
}

export const webStorage: WebStorage = createIndexedDbStorage();

/**
 * Opens a browser JSON file picker (`<input type="file" accept=".json">`).
 * Rejects with `Error("已取消导入")` when cancelled by the user.
 */
export function pickJsonFile(
  maxBytes: number,
  maxErrMsg: string,
): Promise<Uint8Array> {
  if (typeof document === "undefined") {
    return Promise.reject(new Error("当前环境不支持文件选择器"));
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    document.body.appendChild(input);

    let settled = false;
    const cleanup = () => {
      input.removeEventListener("change", onChange);
      input.removeEventListener("cancel", onCancel);
      input.remove();
    };

    const onCancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("已取消导入"));
    };

    const onChange = () => {
      if (settled) return;
      settled = true;
      const file = input.files?.[0];
      cleanup();
      if (!file) {
        reject(new Error("已取消导入"));
        return;
      }
      if (file.size > maxBytes) {
        reject(new Error(maxErrMsg));
        return;
      }
      file
        .arrayBuffer()
        .then((buf) => resolve(new Uint8Array(buf)))
        .catch((e) => reject(new Error(`读取文件失败：${String(e)}`)));
    };

    input.addEventListener("change", onChange);
    input.addEventListener("cancel", onCancel);
    input.click();
  });
}

/**
 * Triggers a client-side JSON file download via Blob URL.
 */
export function downloadJson(filename: string, data: unknown): void {
  if (typeof document === "undefined") {
    throw new Error("当前环境不支持浏览器下载");
  }
  const jsonText = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonText], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
