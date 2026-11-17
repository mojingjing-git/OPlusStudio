/**
 * Unified Dual-Target Backend Adapter:
 * - Windows Desktop (Tauri 2): 100% passthrough to native Rust IPC (`invoke` / `listen`).
 * - Zero-Install Web Driver (GitHub Pages / Chromium): routes to pure TS WebBLE + Gamepad + IndexedDB runtime.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import {
  getCachedWebDeviceSummary,
  isWebBluetoothSupported,
} from "./web/ble.ts";
import { listenWebStatus, webInvoke } from "./web/runtime.ts";

export { getCachedWebDeviceSummary, isWebBluetoothSupported };

export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

export function inferDesktopReleaseUrl(
  loc?: { hostname: string; pathname: string },
): string | null {
  const envRepo = (import.meta as unknown as { env?: Record<string, string> })
    .env?.VITE_GITHUB_REPO;
  if (
    typeof envRepo === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(envRepo.trim())
  ) {
    return `https://github.com/${envRepo.trim()}/releases/latest`;
  }

  const target =
    loc ??
    (typeof window !== "undefined" ? window.location : undefined);
  if (!target) return null;

  const host = target.hostname.toLowerCase();
  if (host.endsWith(".github.io") && host.length > ".github.io".length) {
    const owner = target.hostname.slice(0, -".github.io".length);
    const segments = target.pathname.split("/").filter(Boolean);
    const repo = segments[0] || `${owner}.github.io`;
    if (
      /^[A-Za-z0-9_.-]+$/.test(owner) &&
      /^[A-Za-z0-9_.-]+$/.test(repo)
    ) {
      return `https://github.com/${owner}/${repo}/releases/latest`;
    }
  }
  return null;
}

export async function invoke<T = any>(
  cmd: string,
  args?: Record<string, any>,
): Promise<T> {
  if (isTauriRuntime()) {
    return tauriInvoke<T>(cmd, args);
  }
  try {
    return await webInvoke<T>(cmd, args);
  } catch (e) {
    throw e instanceof Error ? e.message : String(e);
  }
}

export async function listen<T = any>(
  event: string,
  handler: (e: { payload: T }) => void,
): Promise<() => void> {
  if (isTauriRuntime()) {
    return tauriListen<T>(event, handler);
  }
  if (event === "status") {
    const unlisten = listenWebStatus((msg) => {
      handler({ payload: msg as unknown as T });
    });
    return unlisten;
  }
  return () => {};
}
