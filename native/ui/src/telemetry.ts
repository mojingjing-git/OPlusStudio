/**
 * O+ Studio Privacy-Friendly Usage Telemetry & Zero-Login Feedback Client
 * Endpoint: Cloudflare Custom Domain `https://oplus.20000102.online` (accessible in Mainland China without VPN).
 * Zero raw IP / zero cookies stored; all background pings fail silently so offline usage is never affected.
 */

export const TELEMETRY_API_BASE = "https://oplus.20000102.online";
export const GITHUB_ISSUES_URL =
  "https://github.com/mojingjing-git/OPlusStudio/issues/new";

export type PublicStats = {
  total_uv: number;
  total_pv: number;
  today_uv: number;
  web_uv: number;
  desktop_uv: number;
  ble_connects: number;
  feedback_total: number;
};

export type FeedbackCategory = "compat" | "bug" | "feature";

export type FeedbackPayload = {
  category: FeedbackCategory;
  title: string;
  description: string;
  platform: "desktop" | "web";
  app_version: string;
  diagnostic?: Record<string, unknown> | null;
  website?: string;
};

export type FeedbackReceipt = {
  ok: true;
  id: string;
  issue_url?: string | null;
  issue_number?: number | null;
};

let visitPinged = false;
const blePingedDevices = new Set<string>();

export function resetTelemetrySessionGuards(): void {
  visitPinged = false;
  blePingedDevices.clear();
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function pingVisit(
  platform: "desktop" | "web",
  version: string,
  opts?: { apiBase?: string; fetchImpl?: typeof fetch },
): Promise<PublicStats | null> {
  if (visitPinged) return null;
  visitPinged = true;
  const base = opts?.apiBase ?? TELEMETRY_API_BASE;
  const referrer =
    typeof document !== "undefined" && typeof document.referrer === "string"
      ? document.referrer
      : "";
  try {
    const res = await fetchWithTimeout(
      `${base}/api/ping`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "visit",
          platform,
          version,
          referrer,
        }),
      },
      6000,
      opts?.fetchImpl,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.stats as PublicStats) ?? null;
  } catch {
    return null;
  }
}

export async function pingBleConnect(
  platform: "desktop" | "web",
  version: string,
  deviceSig: string,
  opts?: { apiBase?: string; fetchImpl?: typeof fetch },
): Promise<PublicStats | null> {
  const cleanSig = deviceSig.trim() || "unknown";
  if (blePingedDevices.has(cleanSig)) return null;
  blePingedDevices.add(cleanSig);
  const base = opts?.apiBase ?? TELEMETRY_API_BASE;
  try {
    const res = await fetchWithTimeout(
      `${base}/api/ping`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "ble_connect",
          platform,
          version,
          device_sig: cleanSig,
        }),
      },
      6000,
      opts?.fetchImpl,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.stats as PublicStats) ?? null;
  } catch {
    return null;
  }
}

export async function fetchPublicStats(opts?: {
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): Promise<PublicStats | null> {
  const base = opts?.apiBase ?? TELEMETRY_API_BASE;
  try {
    const res = await fetchWithTimeout(
      `${base}/api/stats`,
      { method: "GET" },
      6000,
      opts?.fetchImpl,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.stats as PublicStats) ?? null;
  } catch {
    return null;
  }
}

export async function submitAnonymousFeedback(
  payload: FeedbackPayload,
  opts?: { apiBase?: string; fetchImpl?: typeof fetch },
): Promise<FeedbackReceipt> {
  const base = opts?.apiBase ?? TELEMETRY_API_BASE;
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${base}/api/feedback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      12000,
      opts?.fetchImpl,
    );
  } catch {
    throw new Error("网络连接超时，请检查网络后再试");
  }

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    throw new Error(`服务器返回异常状态 (${res.status})`);
  }

  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || `提交失败 (${res.status})`);
  }

  return {
    ok: true,
    id: String(data.id || "FB-OK"),
    issue_url: data.issue_url ?? null,
    issue_number: data.issue_number ?? null,
  };
}
