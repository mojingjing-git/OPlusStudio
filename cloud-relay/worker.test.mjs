import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import worker from "./worker.mjs";

const secret = "fake-sync-token";
const auth = { Authorization: `Bearer ${secret}` };
const issueNumber = 42;
const issueUrl = "https://example.invalid/issues/42";
const diagnostic = {
  address: "FAKE-DEVICE-ADDRESS",
  device_name: "FAKE-DEVICE-NAME",
  raw: { records: "FAKE-RAW-RECORDS" },
  errors: ["FAKE-ERROR"],
  identity: {
    vid: "1005",
    pid: "2001",
    version_display: "1.37",
    serial: "FAKE-SERIAL",
  },
  support_tier: "verified",
};
const feedback = {
  title: "蓝牙连接后无法读取",
  description: "连接之后只读模式，手柄灯仍然亮着。",
  contact: "test-user@example.invalid",
  category: "compat",
  platform: "desktop",
  app_version: "0.7.3",
  diagnostic,
};
const privateMarkers = [
  feedback.contact, diagnostic.address, diagnostic.device_name,
  diagnostic.raw.records, diagnostic.errors[0], diagnostic.identity.serial,
];
const legacyError = "[最近提示] FAKE-ERROR\n\nFAKE-ERROR-CONTINUATION\n\n补充了一段描述";
const workflow = readFileSync(
  new URL("../.github/workflows/sync-feedback-issues.yml", import.meta.url),
  "utf8",
).split("node - <<'EOF'\n")[1].split("\n          EOF")[0];

function setup(extra = {}) {
  const data = new Map();
  const env = {
    SYNC_SECRET: secret,
    OPLUS_KV: {
      async get(key, type) {
        const item = data.get(key);
        return type === "json" && item !== undefined ? JSON.parse(item) : item ?? null;
      },
      async put(key, value) { data.set(key, value); },
      async list({ prefix, limit }) {
        return { keys: [...data.keys()].filter((key) => key.startsWith(prefix))
          .slice(0, limit).map((name) => ({ name })) };
      },
      async delete(key) { data.delete(key); },
    },
    ...extra,
  };
  const request = (path, init) => worker.fetch(new Request(`https://relay.invalid${path}`, init), env);
  const submit = (body) => request("/api/feedback", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { data, env, request, submit };
}

function assertPrivateRemoved(value) {
  const text = JSON.stringify(value);
  for (const marker of privateMarkers) assert.ok(!text.includes(marker), marker);
}

function assertPublicIssue(issue) {
  assert.equal(issue.title, `[玩家反馈] ${feedback.title}`);
  assertPrivateRemoved(issue);
  assert.match(issue.body, /1005:2001/);
  assert.match(issue.body, /1\.37/);
  assert.match(issue.body, /verified/);
  assert.match(issue.body, /Windows 桌面版/);
}

function issueResponse() {
  return Response.json({ number: issueNumber, html_url: issueUrl }, { status: 201 });
}

async function runSync(fetch) {
  const process = {
    env: {
      FEEDBACK_API_URL: "https://relay.invalid",
      FEEDBACK_SYNC_SECRET: secret,
      GH_TOKEN: "fake-github-token",
      GITHUB_REPOSITORY: "example/test",
    },
    exit(code) { throw Error(`unexpected exit ${code}`); },
  };
  await runInNewContext(workflow, {
    fetch, process, console: { log() {}, error() {} },
  });
  return process.exitCode;
}

test("legacy client: direct post keeps manual content and the compatibility allowlist", async (t) => {
  const local = setup({ GH_ISSUES_TOKEN: "fake-github-token" });
  const send = t.mock.method(globalThis, "fetch", async () => issueResponse());
  const res = await local.submit(feedback);
  assert.equal(res.status, 200);
  const receipt = await res.json();
  assert.equal(receipt.issue_number, issueNumber);
  assert.equal(send.mock.callCount(), 1);
  assert.match(send.mock.calls[0].arguments[0], /^https:\/\/api\.github\.com\//);
  const issue = JSON.parse(send.mock.calls[0].arguments[1].body);
  assertPublicIssue(issue);
  assert.ok(issue.body.includes(feedback.description));
  assert.equal((await local.env.OPLUS_KV.list({ prefix: "inbox:", limit: 10 })).keys.length, 0);
  assertPrivateRemoved([...local.data.values()]);
});

test("legacy queue: scheduled consumer sees the same sanitized public issue and acknowledges it", async () => {
  const local = setup();
  const key = "inbox:legacy";
  await local.env.OPLUS_KV.put(key, JSON.stringify({
    ...feedback, id: "FB-LEGACY", created_at_bj: "2026-11-24 12:00:00",
    description: legacyError,
  }));

  assert.equal((await local.request("/api/inbox/pull")).status, 401);
  let published = 0;
  assert.equal(await runSync(async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === "relay.invalid") {
      const res = await local.request(parsed.pathname, init);
      if (parsed.pathname.endsWith("/pull")) {
        const payload = await res.clone().json();
        assert.equal(payload.items[0].public_issue_version, 1);
        assertPrivateRemoved(payload);
        assert.ok(!JSON.stringify(payload).includes("FAKE-ERROR-CONTINUATION"));
        assert.ok(!Object.hasOwn(payload.items[0], "description"));
      }
      return res;
    }
    assert.equal(parsed.hostname, "api.github.com");
    if (parsed.pathname.endsWith("/labels")) return Response.json({});
    assert.ok(parsed.pathname.endsWith("/issues"));
    const issue = JSON.parse(init.body);
    assertPublicIssue(issue);
    assert.ok(!issue.body.includes("FAKE-ERROR-CONTINUATION"));
    assert.match(issue.body, /未提供可公开的描述/);
    published++;
    return issueResponse();
  }), undefined);
  assert.equal(published, 1);
  assert.equal(local.data.has(key), false);
});

test("legacy prefilled error cannot become a title when no title is supplied", async (t) => {
  const local = setup({ GH_ISSUES_TOKEN: "fake-github-token" });
  const send = t.mock.method(globalThis, "fetch", async () => issueResponse());
  const res = await local.submit({ ...feedback, title: "", description: legacyError, diagnostic: null });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).issue_number, issueNumber);
  const issue = JSON.parse(send.mock.calls[0].arguments[1].body);
  assert.equal(issue.title, "[玩家反馈] 玩家匿名反馈");
  assertPrivateRemoved(issue);
  assert.ok(!issue.body.includes("FAKE-ERROR-CONTINUATION"));
  assert.ok(!issue.body.includes("手柄兼容摘要"));
});

test("fallback queues sanitized data; invalid metadata cannot replace allowed values", async (t) => {
  const local = setup({ GH_ISSUES_TOKEN: "fake-github-token" });
  const send = t.mock.method(globalThis, "fetch", async () => Response.json({}, { status: 503 }));
  const res = await local.submit({
    ...feedback, app_version: "FAKE-APP-TOKEN",
    diagnostic: { ...diagnostic, identity: {
      vid: "FAKE-DEVICE-ADDRESS", pid: "2001", version_display: "FAKE-ERROR",
    }, support_tier: "invalid-support-value" },
  });
  assert.equal((await res.json()).issue_url, null);
  assert.equal(send.mock.callCount(), 1);
  const direct = JSON.parse(send.mock.calls[0].arguments[1].body);
  const [{ markdown, title }] = (await (await local.request("/api/inbox/pull", { headers: auth })).json()).items;
  assert.equal(direct.body, markdown);
  assert.equal(direct.title, `[玩家反馈] ${title}`);
  assertPrivateRemoved(direct);
  assertPrivateRemoved([...local.data.values()]);
  assert.ok(!markdown.includes("手柄兼容摘要"));
  assert.ok(!markdown.includes("FAKE-APP-TOKEN"));
});

test("scheduled consumer refuses stale or incomplete public payloads and does not ack them", async () => {
  const items = [
    { title: "stale", markdown: feedback.contact, description: legacyError },
    { public_issue_version: 1, title: "missing markdown", description: legacyError },
  ];
  let calls = 0;
  assert.equal(await runSync(async (url) => {
    calls++;
    assert.ok(!url.endsWith("/issues") && !url.endsWith("/ack"));
    return Response.json(url.endsWith("/pull") ? { items } : {});
  }), 1);
  assert.equal(calls, 3); // pull and both label requests, no issue writes or acknowledgements
});
