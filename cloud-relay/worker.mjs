/**
 * O+ Studio Telemetry & Zero-Login Feedback Relay Worker
 * Hosted on Cloudflare Workers (`https://oplus.20000102.online`) with KV (`OPLUS_KV`).
 */

const ALLOWED_ORIGINS = new Set([
  "https://mojingjing-git.github.io",
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "http://localhost:5173",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "tauri://localhost",
]);

const MAX_BODY_BYTES = 65536;

function corsHeaders(origin) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://mojingjing-git.github.io";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

async function readBoundedJson(request, maxBytes = MAX_BODY_BYTES) {
  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > maxBytes) {
    throw new Error("请求体积超出 64 KiB 上限");
  }
  if (!request.body) {
    throw new Error("请求体为空");
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("请求体积超出 64 KiB 上限");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8").decode(merged));
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyBearerSecret(authHeader, expectedSecret) {
  if (!expectedSecret || !authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const provided = authHeader.slice(7).trim();
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode("oplus-hmac-compare-v1"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const expectedMac = await crypto.subtle.sign("HMAC", key, enc.encode(expectedSecret));
  return crypto.subtle.verify("HMAC", key, expectedMac, enc.encode(provided));
}

function utcDayString() {
  // Use UTC+8 Beijing date so daily stats match user's local calendar day
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  return bj.toISOString().slice(0, 10);
}

function normalizeReferrer(rawRef) {
  if (!rawRef || typeof rawRef !== "string") return "direct";
  try {
    const host = new URL(rawRef).hostname.toLowerCase().replace(/^www\./, "");
    if (!host || host === "mojingjing-git.github.io" || host.endsWith(".localhost")) {
      return "direct";
    }
    return host.slice(0, 64);
  } catch {
    return "direct";
  }
}

async function loadStatsSummary(kv) {
  const raw = await kv.get("stats:summary", "json");
  return (
    raw || {
      total_pv: 0,
      total_uv: 0,
      web_uv: 0,
      desktop_uv: 0,
      ble_connects: 0,
      feedback_total: 0,
      referrers: {},
      versions: {},
      days: {},
    }
  );
}

async function saveStatsSummary(kv, stats) {
  // Keep last 60 days in summary.days so JSON stays compact
  const dayKeys = Object.keys(stats.days || {}).sort();
  while (dayKeys.length > 60) {
    const oldest = dayKeys.shift();
    if (oldest) delete stats.days[oldest];
  }
  await kv.put("stats:summary", JSON.stringify(stats));
}

function publicStatsView(stats, day) {
  const todayEntry = stats.days?.[day] || { uv: 0, pv: 0, ble: 0 };
  return {
    total_uv: stats.total_uv || 0,
    total_pv: stats.total_pv || 0,
    today_uv: todayEntry.uv || 0,
    web_uv: stats.web_uv || 0,
    desktop_uv: stats.desktop_uv || 0,
    ble_connects: stats.ble_connects || 0,
    feedback_total: stats.feedback_total || 0,
  };
}

function formatIssueMarkdown(item) {
  const catLabel =
    item.category === "compat"
      ? "手柄连接 / 兼容反馈"
      : item.category === "feature"
        ? "功能建议"
        : "问题反馈 (Bug)";
  const lines = [
    `> 本 Issue 由 **O+ Studio 免登录反馈通道** 自动收集（回执号：\`${item.id}\`）`,
    "",
    "| 项目 | 信息 |",
    "| :--- | :--- |",
    `| **反馈类型** | ${catLabel} |`,
    `| **运行形态** | ${item.platform === "desktop" ? "Windows 桌面版" : "在线网页驱动"} (\`v${item.app_version}\`) |`,
    `| **提交者称呼 / 联系方式** | ${item.contact ? item.contact.replace(/[|\r\n]/g, " ") : "匿名玩家"} |`,
    `| **提交时间 (UTC+8)** | ${item.created_at_bj} |`,
    "",
    "### 问题描述",
    "",
    item.description,
  ];

  if (item.diagnostic) {
    const idObj = item.diagnostic.identity || {};
    lines.push(
      "",
      "### 手柄设备摘要",
      `- **名称 / 标识**：\`${String(item.diagnostic.device_name || item.diagnostic.address || "未知")}\``,
      `- **VID:PID / 固件**：\`${idObj.vid || "?"}:${idObj.pid || "?"}\` · 固件 \`${idObj.version_display || "?"}\` (mode ${idObj.mode ?? "?"} / gen ${idObj.generation ?? "?"})`,
      `- **支持分级**：\`${item.diagnostic.support_tier || "unknown"}\``,
      "",
      "<details>",
      "<summary>点击展开完整 oplus-diagnostic-v1 诊断快照 JSON</summary>",
      "",
      "```json",
      JSON.stringify(item.diagnostic, null, 2).slice(0, 45000),
      "```",
      "</details>",
    );
  }
  return lines.join("\n");
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const kv = env.OPLUS_KV;

    try {
      if (request.method === "GET" && (path === "/" || path === "/health")) {
        return jsonResponse({ ok: true, service: "oplus-telemetry" }, 200, origin);
      }

      if (request.method === "GET" && path === "/api/stats") {
        const day = utcDayString();
        const stats = await loadStatsSummary(kv);
        const isAdmin = await verifyBearerSecret(
          request.headers.get("Authorization"),
          env.SYNC_SECRET,
        );
        if (isAdmin) {
          return jsonResponse({ ok: true, day, stats }, 200, origin);
        }
        return jsonResponse({ ok: true, stats: publicStatsView(stats, day) }, 200, origin);
      }

      if (request.method === "POST" && path === "/api/ping") {
        const body = await readBoundedJson(request, 4096);
        const event = body?.event === "ble_connect" ? "ble_connect" : "visit";
        const platform = body?.platform === "desktop" ? "desktop" : "web";
        const version = String(body?.version || "unknown").slice(0, 16);
        const refHost = normalizeReferrer(body?.referrer);

        const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
        const ua = (request.headers.get("User-Agent") || "").slice(0, 120);
        const visitorId = (await sha256Hex(`oplus-uv-v1:${ip}:${ua}:${platform}`)).slice(0, 20);
        const day = utcDayString();

        const stats = await loadStatsSummary(kv);
        if (!stats.days) stats.days = {};
        if (!stats.referrers) stats.referrers = {};
        if (!stats.versions) stats.versions = {};
        if (!stats.days[day]) stats.days[day] = { uv: 0, pv: 0, ble: 0 };

        const work = async () => {
          if (event === "visit") {
            stats.total_pv = (stats.total_pv || 0) + 1;
            stats.days[day].pv = (stats.days[day].pv || 0) + 1;

            const allKey = `uv:all:${visitorId}`;
            const dayKey = `uv:day:${day}:${visitorId}`;
            const [seenAll, seenDay] = await Promise.all([
              kv.get(allKey),
              kv.get(dayKey),
            ]);

            if (!seenAll) {
              await kv.put(allKey, "1", { expirationTtl: 86400 * 365 });
              stats.total_uv = (stats.total_uv || 0) + 1;
              if (platform === "desktop") {
                stats.desktop_uv = (stats.desktop_uv || 0) + 1;
              } else {
                stats.web_uv = (stats.web_uv || 0) + 1;
              }
              stats.referrers[refHost] = (stats.referrers[refHost] || 0) + 1;
              stats.versions[version] = (stats.versions[version] || 0) + 1;
            }
            if (!seenDay) {
              await kv.put(dayKey, "1", { expirationTtl: 86400 * 3 });
              stats.days[day].uv = (stats.days[day].uv || 0) + 1;
            }
          } else if (event === "ble_connect") {
            const devSig = String(body?.device_sig || visitorId).slice(0, 40);
            const bleHash = (await sha256Hex(`oplus-ble:${visitorId}:${devSig}`)).slice(0, 20);
            const bleKey = `ble:seen:${bleHash}`;
            const seenBle = await kv.get(bleKey);
            if (!seenBle) {
              await kv.put(bleKey, "1", { expirationTtl: 86400 * 365 });
              stats.ble_connects = (stats.ble_connects || 0) + 1;
            }
            stats.days[day].ble = (stats.days[day].ble || 0) + 1;
          }
          await saveStatsSummary(kv, stats);
        };

        await work();
        return jsonResponse({ ok: true, stats: publicStatsView(stats, day) }, 200, origin);
      }

      if (request.method === "POST" && path === "/api/feedback") {
        const body = await readBoundedJson(request, MAX_BODY_BYTES);
        // Honeypot check against automated bots
        if (body?.website) {
          return jsonResponse({ ok: true, id: "FB-IGNORED" }, 200, origin);
        }

        const title = String(body?.title || "").trim().slice(0, 100);
        const description = String(body?.description || "").trim().slice(0, 6000);
        const contact = String(body?.contact || "").trim().slice(0, 80);
        const category = ["bug", "compat", "feature"].includes(body?.category)
          ? body.category
          : "bug";
        const platform = body?.platform === "desktop" ? "desktop" : "web";
        const appVersion = String(body?.app_version || "0.7.3").slice(0, 20);

        if (title.length < 2 && description.length < 4) {
          return jsonResponse({ ok: false, error: "请简单填写问题标题或现象描述" }, 400, origin);
        }

        const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
        const ipHash = (await sha256Hex(`oplus-rl:${ip}`)).slice(0, 20);
        const rlKey = `rl:fb:${ipHash}`;
        const prevCount = Number((await kv.get(rlKey)) || "0");
        if (prevCount >= 4) {
          return jsonResponse(
            { ok: false, error: "提交过于频繁，请半小时后再试" },
            429,
            origin,
          );
        }
        await kv.put(rlKey, String(prevCount + 1), { expirationTtl: 1800 });

        const day = utcDayString().replace(/-/g, "");
        const randHex = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
        const id = `FB-${day}-${randHex}`;
        const bjIso = new Date(Date.now() + 8 * 3600 * 1000)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19);

        const finalTitle =
          title.length >= 2
            ? title
            : description.split(/\r?\n/)[0].slice(0, 50) || "玩家匿名反馈";

        const record = {
          id,
          category,
          title: finalTitle,
          description: description || finalTitle,
          contact,
          platform,
          app_version: appVersion,
          created_at: new Date().toISOString(),
          created_at_bj: bjIso,
          diagnostic:
            body?.diagnostic && typeof body.diagnostic === "object"
              ? body.diagnostic
              : null,
        };

        let issueUrl = null;
        let issueNumber = null;

        // If GH_ISSUES_TOKEN is configured, create the GitHub Issue immediately in <1s
        if (env.GH_ISSUES_TOKEN) {
          try {
            const ghResp = await fetch(
              "https://api.github.com/repos/mojingjing-git/OPlusStudio/issues",
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${env.GH_ISSUES_TOKEN}`,
                  Accept: "application/vnd.github+json",
                  "User-Agent": "OPlusStudio-Feedback-Relay/1.0",
                  "X-GitHub-Api-Version": "2022-11-28",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  title: `[玩家反馈] ${record.title}`,
                  body: formatIssueMarkdown(record),
                }),
              },
            );
            if (ghResp.ok) {
              const ghJson = await ghResp.json();
              issueUrl = ghJson.html_url || null;
              issueNumber = ghJson.number || null;
            }
          } catch {
            // Fall back cleanly to inbox queue if GitHub API is unreachable
          }
        }

        if (!issueUrl) {
          await kv.put(`inbox:${Date.now()}-${id}`, JSON.stringify(record), {
            expirationTtl: 86400 * 90,
          });
        }
        await kv.put(
          `feedback:${id}`,
          JSON.stringify({ ...record, issue_url: issueUrl, issue_number: issueNumber }),
          { expirationTtl: 86400 * 180 },
        );

        const stats = await loadStatsSummary(kv);
        stats.feedback_total = (stats.feedback_total || 0) + 1;
        await saveStatsSummary(kv, stats);

        console.log(
          JSON.stringify({
            event: "feedback_received",
            id,
            category,
            platform,
            synced_immediately: Boolean(issueUrl),
          }),
        );

        return jsonResponse(
          {
            ok: true,
            id,
            issue_url: issueUrl,
            issue_number: issueNumber,
          },
          200,
          origin,
        );
      }

      if (request.method === "GET" && path === "/api/inbox/pull") {
        const authed = await verifyBearerSecret(
          request.headers.get("Authorization"),
          env.SYNC_SECRET,
        );
        if (!authed) {
          return jsonResponse({ ok: false, error: "Unauthorized" }, 401, origin);
        }
        const list = await kv.list({ prefix: "inbox:", limit: 25 });
        const items = [];
        for (const k of list.keys) {
          const val = await kv.get(k.name, "json");
          if (val) {
            items.push({
              kv_key: k.name,
              ...val,
              markdown: formatIssueMarkdown(val),
            });
          }
        }
        return jsonResponse({ ok: true, items }, 200, origin);
      }

      if (request.method === "POST" && path === "/api/inbox/ack") {
        const authed = await verifyBearerSecret(
          request.headers.get("Authorization"),
          env.SYNC_SECRET,
        );
        if (!authed) {
          return jsonResponse({ ok: false, error: "Unauthorized" }, 401, origin);
        }
        const body = await readBoundedJson(request, 8192);
        const acked = Array.isArray(body?.acked) ? body.acked : [];
        for (const entry of acked) {
          if (typeof entry?.kv_key === "string" && entry.kv_key.startsWith("inbox:")) {
            await kv.delete(entry.kv_key);
          }
          if (typeof entry?.id === "string" && entry.issue_url) {
            const existing = await kv.get(`feedback:${entry.id}`, "json");
            if (existing) {
              existing.issue_url = entry.issue_url;
              existing.issue_number = entry.issue_number || null;
              await kv.put(`feedback:${entry.id}`, JSON.stringify(existing), {
                expirationTtl: 86400 * 180,
              });
            }
          }
        }
        return jsonResponse({ ok: true, deleted: acked.length }, 200, origin);
      }

      return jsonResponse({ ok: false, error: "Not Found" }, 404, origin);
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "worker_error",
          path,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      return jsonResponse(
        { ok: false, error: e instanceof Error ? e.message : "请求处理失败" },
        400,
        origin,
      );
    }
  },
};
