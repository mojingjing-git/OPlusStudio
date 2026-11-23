import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

import { inferDesktopReleaseUrl } from "../src/backend.ts";
import { PollingRateAnalyzer, StickBenchAnalyzer } from "../src/liveInput.ts";
import {
  CURVE_PRESETS,
  TRIGGER_GEARS,
  curveShape,
  curveSideMask,
  evaluateCurveY,
  matchCurvePreset,
  matchTriggerGear,
  projectCurvePreview,
} from "../src/curves.ts";
import { APP_VERSION, type Change, type Input, type Snapshot } from "../src/types.ts";
import {
  NOTIFY,
  SERVICE,
  WRITE,
  type WebBluetoothCharacteristicEvent,
  type WebBluetoothDevice,
  type WebBluetoothRemoteGATTCharacteristic,
  type WebBluetoothRemoteGATTServer,
  type WebBluetoothRemoteGATTService,
  WebBleSession,
  formatWebDeviceAddress,
  setCachedWebDeviceForTest,
} from "../src/web/ble.ts";
import {
  gamepadToXInput,
  identifyRearSlotsWeb,
} from "../src/web/gamepad.ts";
import {
  Layout,
  boundary,
  bridgeHoldChange,
  bytesEqual,
  desiredSetting,
  diagnosticBundle,
  encodeChange,
  encodeForSlot,
  exportProfile,
  form,
  importKeymapAny,
  importProfile,
  makeRecord,
  parseProgram,
  recordFromPayload,
  snapshotActiveSlots,
  snapshotLayout,
  snapshotPreset,
  snapshotRecord,
  snapshotSlotStepLimit,
  supportTier,
  validateKeymapStore,
} from "../src/web/model.ts";
import {
  decodeKeys,
  decodeMacroLimits,
  effectiveGeneration,
  frame,
  fromHex,
  isVerified137,
  parse,
  parseIdentity,
  query,
  toHex,
} from "../src/web/protocol.ts";
import { createMemoryStorage } from "../src/web/storage.ts";
import {
  type Device,
  type Edit,
  apply,
  execute,
  pending,
  persistJournal,
  prepare,
  recoveryEdits,
  rollback,
  undoEdits,
  validateJournal,
} from "../src/web/transaction.ts";

const protocolFixture = JSON.parse(
  fs.readFileSync(
    new URL("../../fixtures/protocol.json", import.meta.url),
    "utf-8",
  ),
);
const macrosFixture = JSON.parse(
  fs.readFileSync(
    new URL("../../fixtures/macros.json", import.meta.url),
    "utf-8",
  ),
);
const snapshotFixtureText = fs.readFileSync(
  new URL("../../fixtures/snapshot.json", import.meta.url),
  "utf-8",
);

function cloneSnapshotFixture(): Snapshot {
  return JSON.parse(snapshotFixtureText) as Snapshot;
}

class MockDevice implements Device {
  public snapshotData: Snapshot;
  public writes: string[] = [];
  public failAt: number | null = null;
  public corruptRead = false;
  public failReconnect = false;
  public swapIdentityOnReconnect = false;
  public reconnectCount = 0;
  public zeroCompactRemapRead = false;

  constructor(initial?: Snapshot) {
    this.snapshotData = initial ?? cloneSnapshotFixture();
  }

  async snapshot(): Promise<Snapshot> {
    return structuredClone(this.snapshotData);
  }

  async read(key: string): Promise<number[]> {
    if (this.corruptRead) {
      this.corruptRead = false;
      return [0];
    }
    const p = snapshotRecord(this.snapshotData, key);
    if (
      this.zeroCompactRemapRead &&
      key === "remapping" &&
      p.slice(1).every((b) => b === 0)
    ) {
      return [0];
    }
    return p;
  }

  async write(key: string, payload: readonly number[]): Promise<void> {
    this.writes.push(key);
    this.snapshotData.raw[key] = recordFromPayload(payload);
    if (this.failAt === this.writes.length) {
      throw new Error("fragment timeout after device changed");
    }
  }

  async reconnect(): Promise<void> {
    this.reconnectCount += 1;
    if (this.failReconnect) {
      throw new Error("GATT reconnect failed");
    }
    if (this.swapIdentityOnReconnect) {
      throw new Error("重连设备身份与原设备不同，已停止恢复");
    }
    // Clear transient fault after reconnecting
    this.failAt = null;
  }
}

function sampleEdits(s: Snapshot): Edit[] {
  return [0, 1, 2].map((i) => ({
    key: `macro_${i}`,
    expected: snapshotRecord(s, `macro_${i}`),
    target: encodeChange({ kind: "hold", keys: [1] }, s),
  }));
}

describe("1. KeyLinker Protocol Golden Vectors & Security Whitelist", () => {
  it("matches all 768 golden frame vectors byte-for-byte", () => {
    assert.equal(protocolFixture.frames.length, 768);
    for (const f of protocolFixture.frames) {
      const payload = fromHex(f.payload);
      const wire = frame(f.opcode, payload, f.serial, f.nonce, f.length);
      assert.equal(toHex(wire), f.wire);
      const pkt = parse(wire);
      assert.equal(pkt.opcode, f.opcode);
      assert.equal(pkt.serial, f.serial);
      assert.deepEqual(pkt.payload, Array.from(payload));
    }
  });

  it("rejects malformed frames, CRC errors, and unauthorized queries", () => {
    for (let n = 0; n < 5; n++) {
      assert.throws(() => parse(new Uint8Array(n)));
    }
    assert.throws(() => parse(new Uint8Array(21)));

    const wire = frame(0x19, [1, 2, 3], 129, 42, null);
    const corrupted = new Uint8Array(wire);
    corrupted[corrupted.length - 1] ^= 1;
    assert.throws(() => parse(corrupted), /CRC/);

    // Query whitelist checks
    assert.throws(() => query(0xb5, [0, 0], 1, 0, false));
    assert.doesNotThrow(() => query(0xb5, [0, 7], 1, 0, true));
    assert.throws(() => query(0xb5, [0, 8], 1, 0, true));
    assert.doesNotThrow(() => query(0xb0, [0, 6], 1, 0, false));
    assert.doesNotThrow(() => query(0xb0, [0, 7], 1, 0, false));
    assert.throws(() => query(0xb0, [0, 8], 1, 0, true));
    assert.throws(() => query(0x1d, [2, 0xdf, 0xab], 1, 0, true));
    assert.throws(() => query(0x16, [3, 0xdf, 0xa9, 2], 1, 0, true));
  });

  it("parses Gen1 6-byte identity frames, Gen2 mode downgrades, and RLE key tables", () => {
    const gen1 = parseIdentity([6, 0x10, 0x05, 0x20, 0x00, 0x01, 0x10]);
    assert.equal(gen1.vid, "1005");
    assert.equal(gen1.pid, "2000");
    assert.equal(gen1.version_display, "1.10");
    assert.equal(effectiveGeneration(gen1), 0);
    assert.equal(isVerified137(gen1), false);

    const oplus137 = parseIdentity([
      7, 0x10, 0x05, 0x20, 0x01, 0x01, 0x37, 0x56,
    ]);
    assert.equal(isVerified137(oplus137), true);
    assert.equal(effectiveGeneration(oplus137), 2);
    assert.equal(oplus137.sensor, 1);

    for (const mode of [0, 7, 8]) {
      assert.equal(
        effectiveGeneration({
          vid: "1005",
          pid: "2001",
          version_display: "1.42",
          mode,
          generation: 2,
          sensor: 0,
        }),
        1,
      );
    }

    assert.deepEqual(decodeMacroLimits([42, 0, 47, 0, 0, 0]), [42, 47, 0]);
    assert.throws(() => decodeMacroLimits([42, 0, 1]));
    assert.throws(() => decodeKeys([2, 255, 0x82]));
  });
});

describe("2. Macro Golden Vectors, Snapshot Roundtrip & Dynamic Model", () => {
  it("matches all 42 macro golden vectors and roundtrips all 6 snapshot slots", () => {
    const s = cloneSnapshotFixture();
    assert.equal(supportTier(s), "verified");
    assert.equal(macrosFixture.length, 42);

    for (const row of macrosFixture) {
      const encoded = encodeChange(row.change as Change, s);
      assert.equal(toHex(encoded), row.payload);
    }

    for (let slot = 0; slot < 6; slot++) {
      const f = form(s, slot);
      const reencoded = encodeChange(f, s);
      assert.deepEqual(reencoded, snapshotRecord(s, `macro_${slot}`));
    }
  });

  it("supports BOM / Snapshot profile import, All-or-Nothing validation, and unknown byte protection", () => {
    const s = cloneSnapshotFixture();
    const p = exportProfile(s, {});
    const bomBytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(JSON.stringify(p)),
    ]);
    assert.deepEqual(importProfile(bomBytes, s), {});
    assert.deepEqual(importProfile(JSON.stringify(s), s), {});

    const bad = structuredClone(p) as any;
    bad.slots[5].slot = 0;
    assert.throws(() => importProfile(JSON.stringify(bad), s), /重复槽位/);

    // Motors: banker's rounding + tail preservation + disabled channel guard
    const origMotors = snapshotRecord(s, "motors");
    const nextMotors = desiredSetting(s, "motors", {
      levels: [50, 30, 0, 100],
    });
    assert.equal(nextMotors[1], 128);
    assert.equal(nextMotors[2], 76); // roundTiesEven(30 * 255 / 100 = 76.5) === 76!
    assert.deepEqual(nextMotors.slice(5), origMotors.slice(5));

    const tamperedMotors = [...nextMotors];
    tamperedMotors[5] ^= 1;
    assert.throws(() => boundary(s, "motors", origMotors, tamperedMotors));

    // Single-channel motor update preserves disabled channels & non-exact % values
    const sPartialMotor = cloneSnapshotFixture();
    sPartialMotor.identity.version_display = "1.40";
    sPartialMotor.capabilities = makeRecord([3, 3, 0x03, 0, 63, 1, 11, 0, 192, 0]);
    sPartialMotor.raw.motors = makeRecord([
      0x20, 0x20, 0x20, 0x20, 0xaa, 0xbb, 0xcc, 0xdd,
    ]);
    const origPartial = snapshotRecord(sPartialMotor, "motors");
    const ch0Only = desiredSetting(sPartialMotor, "motors", {
      channel: 0,
      level: 50,
    });
    assert.equal(ch0Only[1], 128);
    assert.deepEqual(ch0Only.slice(2), origPartial.slice(2));

    // Lighting: preserves data4/data5/light & rejects unsupported zone 2
    const origLight = snapshotRecord(s, "lighting");
    const nextLight = desiredSetting(s, "lighting", {
      zone: 1,
      rgb: "#123456",
    });
    assert.deepEqual(nextLight.slice(7, 10), [0x12, 0x34, 0x56]);
    for (let i = 0; i < 25; i++) {
      if (i < 7 || i >= 10) assert.equal(nextLight[i], origLight[i]);
    }
    assert.throws(() =>
      desiredSetting(s, "lighting", { zone: 2, rgb: "#ffffff" }),
    );

    // Remapping: forbids 93/94 as new non-zero source, allows reset & target
    assert.throws(() =>
      desiredSetting(s, "remapping", { source: 93, target: 1 }),
    );
    assert.throws(() =>
      desiredSetting(s, "remapping", { source: 94, target: 2 }),
    );
    assert.doesNotThrow(() =>
      desiredSetting(s, "remapping", { source: 93, target: 93 }),
    );
    assert.doesNotThrow(() =>
      desiredSetting(s, "remapping", { source: 11, target: 93 }),
    );
  });

  it("handles 4-slot / 8-slot dynamic macro_limits (up to 47 steps), remap_targets, and cross-firmware Hold translation", () => {
    const s4 = cloneSnapshotFixture();
    s4.identity.pid = "2002";
    s4.capabilities = makeRecord([3, 3, 15, 0, 0x0f, 0x03, 11, 0x02, 192, 0]);
    delete s4.raw.macro_4;
    delete s4.raw.macro_5;
    s4.decoded.macro_limits = [47, 8, 42, 42, 0, 0, 0, 0];
    s4.decoded.remap_targets = [1, 2, 93, 94];

    assert.equal(supportTier(s4), "compatible");
    assert.deepEqual(snapshotActiveSlots(s4), [0, 1, 2, 3]);
    assert.equal(snapshotSlotStepLimit(s4, 0), 47);
    assert.equal(snapshotSlotStepLimit(s4, 1), 8);

    const longSeq = [
      ...Array.from({ length: 22 }, () => "A:10/10"),
      "B:10/0",
    ].join(", ");
    const longMacro: Change = {
      kind: "macro",
      sequence: longSeq,
      loop_ms: 0,
      trigger: 0,
    };
    assert.doesNotThrow(() => encodeForSlot(longMacro, s4, 0));
    assert.throws(() => encodeForSlot(longMacro, s4, 1));
    assert.doesNotThrow(() =>
      desiredSetting(s4, "remapping", { source: 1, target: 2 }),
    );
    assert.throws(() =>
      desiredSetting(s4, "remapping", { source: 1, target: 5 }),
    );

    // Cross-firmware reordered macro_keys + extended KEY_200 + Hold(duration_ms=0) + changekey=0
    const src = cloneSnapshotFixture();
    src.identity.version_display = "1.20";
    src.decoded.macro_keys = [
      1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 93, 94, 200, 18,
    ];
    const srcLayout = new Layout(src.decoded.macro_keys);
    assert.deepEqual(srcLayout.names(srcLayout.mask(["KEY_200", "A"])), [
      "A",
      "KEY_200",
    ]);

    for (let slot = 0; slot < 6; slot++) {
      src.raw[`macro_${slot}`] = recordFromPayload(
        encodeChange({ kind: "hold", keys: [1] }, src),
      );
    }
    src.raw.macro_0 = recordFromPayload(
      encodeForSlot({ kind: "hold", keys: [93, 11, 12] }, src, 0),
    );
    src.raw.macro_1 = recordFromPayload(
      encodeForSlot(
        {
          kind: "macro",
          sequence: "A+LS_UP:50/25, B:30/0",
          loop_ms: 100,
          trigger: 1,
        },
        src,
        1,
      ),
    );

    const exported = JSON.stringify(exportProfile(src, {}));

    const dst = cloneSnapshotFixture();
    dst.identity.version_display = "1.45";
    dst.capabilities = makeRecord([3, 3, 15, 0, 63, 0, 11, 0, 192, 0]);
    delete dst.decoded.remap_keys;
    delete dst.raw.remap_keys;
    delete dst.raw.remapping;
    assert.equal(supportTier(dst), "compatible");

    const imported = importProfile(exported, dst);
    const slot0Bytes = encodeForSlot(imported[0], dst, 0);
    assert.deepEqual(
      slot0Bytes,
      encodeForSlot({ kind: "hold", keys: [93, 11, 12] }, dst, 0),
    );
    const parsed0 = parseProgram(slot0Bytes, snapshotLayout(dst));
    assert.equal(parsed0.steps.length, 1);
    assert.equal(parsed0.steps[0].duration_ms, 0);

    const slot1Bytes = encodeForSlot(imported[1], dst, 1);
    assert.deepEqual(
      slot1Bytes,
      encodeForSlot(
        {
          kind: "macro",
          sequence: "A+LS_UP:50/25, B:30/0",
          loop_ms: 100,
          trigger: 1,
        },
        dst,
        1,
      ),
    );
  });
});

describe("3. Transactional Engine, Rollback, Crash Recovery & Firmware 1.42", () => {
  it("restores all attempted writes in reverse order on partial write failure", async () => {
    for (const at of [1, 2, 3]) {
      const m = new MockDevice();
      m.failAt = at;
      const store = createMemoryStorage();
      await assert.rejects(() =>
        execute(m, store, "save", sampleEdits(cloneSnapshotFixture())),
      );
      const baseline = cloneSnapshotFixture();
      for (let i = 0; i < 6; i++) {
        assert.deepEqual(
          snapshotRecord(m.snapshotData, `macro_${i}`),
          snapshotRecord(baseline, `macro_${i}`),
        );
      }
      const expectedReverse = Array.from({ length: at }, (_, i) => i)
        .reverse()
        .map((i) => `macro_${i}`);
      assert.deepEqual(m.writes.slice(at), expectedReverse);
      assert.equal((await pending(store)).length, 0);
    }
  });

  it("rolls back on readback mismatch, supports GATT reconnect retry, and keeps undo transactional", async () => {
    const m = new MockDevice();
    m.corruptRead = true;
    const store = createMemoryStorage();
    await assert.rejects(() =>
      execute(m, store, "save", sampleEdits(cloneSnapshotFixture())),
    );

    const receipt = await execute(
      m,
      store,
      "save",
      sampleEdits(cloneSnapshotFixture()),
    );
    const savedSnap = structuredClone(m.snapshotData);

    // Undo fails mid-way AND first rollback write fails -> reconnects once and completes rollback!
    const baseLen = m.writes.length;
    let rollbackFailedOnce = false;
    const origWrite = m.write.bind(m);
    m.write = async (key: string, payload: readonly number[]) => {
      if (m.writes.length === baseLen + 1) {
        // 2nd undo write fails
        m.writes.push(key);
        throw new Error("GATT disconnected during undo");
      }
      if (!rollbackFailedOnce && m.writes.length >= baseLen + 2) {
        rollbackFailedOnce = true;
        throw new Error("still disconnected before reconnect");
      }
      return origWrite(key, payload);
    };

    await assert.rejects(() =>
      execute(m, store, "undo", undoEdits(receipt.journal)),
    );
    assert.equal(m.reconnectCount, 1);
    for (let i = 0; i < 6; i++) {
      assert.deepEqual(
        snapshotRecord(m.snapshotData, `macro_${i}`),
        snapshotRecord(savedSnap, `macro_${i}`),
      );
    }
  });

  it("normalizes non-16-key [0] remapping readbacks dynamically", async () => {
    const s = cloneSnapshotFixture();
    s.identity.version_display = "1.50";
    s.decoded.remap_keys = [1, 2, 3, 4, 5, 6, 11, 12, 13, 14];
    s.raw.remapping = makeRecord(new Array<number>(10).fill(0));
    assert.equal(supportTier(s), "compatible");

    const target = desiredSetting(s, "remapping", { source: 1, target: 2 });
    assert.equal(target.length, 11);
    const expected = snapshotRecord(s, "remapping");

    const dev = new MockDevice(s);
    dev.zeroCompactRemapRead = true;
    const store = createMemoryStorage();

    const saved = await execute(dev, store, "save", [
      { key: "remapping", expected, target },
    ]);
    const undone = await execute(dev, store, "undo", undoEdits(saved.journal));
    assert.equal(undone.journal.state, "completed");
  });

  it("supports firmware 1.42 Compatible writes, crash journal recovery, and refuses unknown external edits", async () => {
    const m = new MockDevice();
    m.snapshotData.identity.version_display = "1.42";
    assert.equal(supportTier(m.snapshotData), "compatible");
    assert.equal(Object.keys(snapshotPreset(m.snapshotData)).length, 6);

    const store = createMemoryStorage();
    const [j] = await prepare(m, store, "save", [
      {
        key: "macro_0",
        expected: snapshotRecord(m.snapshotData, "macro_0"),
        target: encodeForSlot({ kind: "hold", keys: [93, 11, 12] }, m.snapshotData, 0),
      },
    ]);
    j.records[0].attempted = true;
    j.records[0].state = "write_intent";
    await persistJournal(store, j);
    await m.write("macro_0", j.records[0].target);

    const found = await pending(store);
    assert.equal(found.length, 1);

    // Rejects unknown external modification!
    const externallyModified = structuredClone(m.snapshotData);
    externallyModified.raw.macro_0 = recordFromPayload(
      encodeForSlot({ kind: "hold", keys: [2] }, externallyModified, 0),
    );
    await assert.rejects(
      () => recoveryEdits(store, found[0], externallyModified),
      /存在未知外部修改/,
    );

    // Rejects tampered backup SHA-256 or path traversal
    const badPath = structuredClone(found[0]);
    badPath.backup = "../unsafe.json";
    await assert.rejects(() => validateJournal(store, badPath));

    // Recovers cleanly when device matches journal target
    const recEdits = await recoveryEdits(store, found[0], m.snapshotData);
    assert.equal(recEdits.length, 1);
    const receipt = await execute(m, store, "recovery", recEdits);
    assert.deepEqual(
      snapshotRecord(receipt.snapshot, "macro_0"),
      snapshotRecord(cloneSnapshotFixture(), "macro_0"),
    );

    // O+ full-open mode: O+ controller (by 1005:2001 or "致动O+" name) stays writable even on mode 7 or missing macro_2!
    const oplusPartial = cloneSnapshotFixture();
    oplusPartial.address = "致动O+_CB4EC9 [5Bj2Es5idu]";
    oplusPartial.decoded.device_name = "致动O+_CB4EC9";
    delete oplusPartial.raw.macro_2;
    assert.equal(supportTier(oplusPartial), "verified");
    for (let slot = 0; slot < 6; slot++) {
      assert.doesNotThrow(() => form(oplusPartial, slot));
    }

    const oplusNamedCustom = cloneSnapshotFixture();
    oplusNamedCustom.address = "致动O+_TEST [abc123]";
    oplusNamedCustom.identity.pid = "9999";
    oplusNamedCustom.identity.mode = 7;
    oplusNamedCustom.capabilities = makeRecord([]);
    oplusNamedCustom.raw = {};
    oplusNamedCustom.decoded = { device_name: "致动O+_TEST" };
    assert.equal(supportTier(oplusNamedCustom), "compatible");
    assert.deepEqual(snapshotActiveSlots(oplusNamedCustom), [0, 1, 2, 3, 4, 5]);

    // Non-O+ Gen1 controller (PID 2000, mode 7) still blocks writes and exports diagnostic bundle
    m.snapshotData.identity.pid = "2000";
    m.snapshotData.identity.mode = 7;
    assert.equal(supportTier(m.snapshotData), "read_only");
    const diag = diagnosticBundle(m.snapshotData);
    assert.equal(diag.support_tier, "read_only");
    assert.equal(diag.effective_generation, 1);
    await assert.rejects(() =>
      prepare(m, store, "save", [
        {
          key: "motors",
          expected: snapshotRecord(m.snapshotData, "motors"),
          target: snapshotRecord(m.snapshotData, "motors"),
        },
      ]),
    );
  });
});

describe("4. Keymap Validation, 0.4.0 Migration, W3C Gamepad & Simulated WebBLE GATT", () => {
  it("validates keymap boundaries (F8 forbidden, wheel/wait hold_ms=0) and migrates 0.4.0 profile.json", () => {
    // Reject F8
    assert.throws(
      () =>
        validateKeymapStore({
          schema: 1,
          active_profile_id: "p1",
          trigger_threshold: 64,
          stick_deadzone: 16000,
          profiles: [
            {
              id: "p1",
              name: "测试",
              rules: [
                {
                  id: "r1",
                  name: "非法急停键",
                  enabled: true,
                  rear_slot: null,
                  trigger: ["A"],
                  action: { kind: "hold", keys: ["F8"] },
                },
              ],
            },
          ],
        }),
      /F8/,
    );

    // Pure wheel hold_ms=0 allowed; normal key hold_ms=0 rejected; pure wait 0/0 rejected
    const validWheelStore = validateKeymapStore({
      schema: 1,
      active_profile_id: "p1",
      trigger_threshold: 64,
      stick_deadzone: 16000,
      profiles: [
        {
          id: "p1",
          name: "滚轮与等待",
          rules: [
            {
              id: "r1",
              name: "纯滚轮脉冲",
              enabled: true,
              rear_slot: 0,
              trigger: ["Back", "LS", "RS"],
              action: {
                kind: "macro",
                steps: [
                  { keys: ["WheelUp"], hold_ms: 0, gap_ms: 40 },
                  { keys: [], hold_ms: 50, gap_ms: 0 },
                ],
                trigger_mode: "hold_loop",
                loop_ms: 0,
              },
            },
          ],
        },
      ],
    });
    assert.equal(validWheelStore.profiles[0].rules.length, 1);

    assert.throws(() =>
      validateKeymapStore({
        schema: 1,
        active_profile_id: "p1",
        trigger_threshold: 64,
        stick_deadzone: 16000,
        profiles: [
          {
            id: "p1",
            name: "错误按住时间",
            rules: [
              {
                id: "r1",
                name: "零毫秒按键",
                enabled: true,
                rear_slot: null,
                trigger: ["A"],
                action: {
                  kind: "macro",
                  steps: [{ keys: ["Space"], hold_ms: 0, gap_ms: 50 }],
                  trigger_mode: "once",
                  loop_ms: 0,
                },
              },
            ],
          },
        ],
      }),
    );

    // Migrate legacy 0.4.0 profile.json
    const legacy04 = {
      version: 1,
      name: "0.4.0 老玩家配置",
      mappings: {
        "LX-": "A",
        LB: "shift",
      },
      macros: {
        RB: [
          { key: "1", hold_ms: 50, after_ms: 30 },
          { key: "Space", hold_ms: 80, after_ms: 0 },
        ],
      },
    };
    const migrated = importKeymapAny(JSON.stringify(legacy04));
    assert.equal(migrated.name, "0.4.0 老玩家配置");
    assert.equal(migrated.rules.length, 3);
    assert.deepEqual(migrated.rules[0].trigger, ["LXNeg"]);
    assert.deepEqual(migrated.rules[1].action, {
      kind: "hold",
      keys: ["LShift"],
    });

    // Bridge hold change encoding
    const s = cloneSnapshotFixture();
    const bridge = bridgeHoldChange(0, ["Back", "LS", "RS"], s);
    assert.deepEqual(bridge, { kind: "hold", keys: [93, 11, 12] });
  });

  it("maps W3C Gamepad API axes (inverting Y axis) and buttons accurately, and runs guided slot identification", async () => {
    const buttons = Array.from({ length: 16 }, () => ({
      pressed: false,
      value: 0,
    }));
    buttons[0] = { pressed: true, value: 1 }; // A -> 0x1000
    buttons[4] = { pressed: true, value: 1 }; // LB -> 0x0100
    buttons[6] = { pressed: true, value: 0.5 }; // LT -> 128
    buttons[7] = { pressed: true, value: 1.0 }; // RT -> 255
    buttons[8] = { pressed: true, value: 1 }; // Back -> 0x0020
    buttons[12] = { pressed: true, value: 1 }; // Up -> 0x0001

    // W3C axes[1] = -1.0 (stick pushed UP) -> XInput ly = +32767!
    // W3C axes[3] = +1.0 (stick pushed DOWN) -> XInput ry = -32767!
    const converted = gamepadToXInput({
      index: 0,
      connected: true,
      buttons,
      axes: [-0.5, -1.0, 0.0, 1.0],
    });
    assert.equal(converted.buttons, 0x1000 | 0x0100 | 0x0020 | 0x0001);
    assert.equal(converted.left_trigger, 128);
    assert.equal(converted.right_trigger, 255);
    assert.equal(converted.lx, Math.round(-0.5 * 32767));
    assert.equal(converted.ly, 32767);
    assert.ok(Object.is(converted.rx, 0));
    assert.equal(converted.ry, -32767);

    // Test guided rear-slot identification (4-slot pad) with automatic rollback
    const s4 = cloneSnapshotFixture();
    s4.capabilities = makeRecord([3, 3, 15, 0, 0x0f, 1, 11, 0, 192, 0]);
    delete s4.raw.macro_4;
    delete s4.raw.macro_5;
    const dev = new MockDevice(s4);
    const store = createMemoryStorage();

    // Simulate physical user pressing slot 3, 2, 1, 0 in sequence (mapping to M1, M2, M3, M4!)
    const markerMasks = [0x0000, 0x8000, 0x0000, 0x4000, 0x0000, 0x2000, 0x0000, 0x1000, 0x0000];
    let phaseIdx = 0;
    let phaseEnteredAt = Date.now();
    const fakeReadInputs = (): Input[] => {
      if (Date.now() - phaseEnteredAt >= 50 && phaseIdx < markerMasks.length - 1) {
        phaseIdx += 1;
        phaseEnteredAt = Date.now();
      }
      return [
        {
          slot: 0,
          buttons: markerMasks[phaseIdx],
          left_trigger: 0,
          right_trigger: 0,
          lx: 0,
          ly: 0,
          rx: 0,
          ry: 0,
        },
      ];
    };

    const labels = await identifyRearSlotsWeb(
      dev,
      store,
      () => false,
      () => {},
      fakeReadInputs,
      5,
    );
    assert.deepEqual(labels, {
      3: "M1",
      2: "M2",
      1: "M3",
      0: "M4",
    });
    // Original onboard macro records restored!
    for (let slot = 0; slot < 4; slot++) {
      assert.deepEqual(
        snapshotRecord(dev.snapshotData, `macro_${slot}`),
        snapshotRecord(s4, `macro_${slot}`),
      );
    }

    // Verify GitHub Pages URL inference
    assert.equal(
      inferDesktopReleaseUrl({
        hostname: "player.github.io",
        pathname: "/oplus-studio/index.html",
      }),
      "https://github.com/player/oplus-studio/releases/latest",
    );
    assert.equal(
      inferDesktopReleaseUrl({
        hostname: "localhost",
        pathname: "/",
      }),
      null,
    );
  });

  it("drives WebBleSession end-to-end over simulated Web Bluetooth GATT frames", async () => {
    const snap = cloneSnapshotFixture();
    const notifyTarget = new EventTarget();
    let connected = false;

    const notifyChar: WebBluetoothRemoteGATTCharacteristic = Object.assign(
      notifyTarget,
      {
        uuid: NOTIFY,
        properties: { notify: true },
        value: null as DataView | null,
        async startNotifications() {
          return notifyChar;
        },
        async stopNotifications() {
          return notifyChar;
        },
      },
    );

    const emitReply = (serial: number, payloadBytes: number[]) => {
      const replyWire = frame(0x19, payloadBytes, serial, 7, null);
      const ab = new ArrayBuffer(replyWire.byteLength);
      new Uint8Array(ab).set(replyWire);
      (notifyChar as any).value = new DataView(ab);
      const ev = new Event(
        "characteristicvaluechanged",
      ) as WebBluetoothCharacteristicEvent;
      notifyChar.dispatchEvent(ev);
    };

    const pagedReply = (serial: number, page: number, fullRecordBytes: number[]) => {
      if (page === 0) {
        const firstChunk = fullRecordBytes.slice(0, 14);
        emitReply(serial, [fullRecordBytes.length, ...firstChunk]);
      } else {
        const start = 14 + (page - 1) * 15;
        emitReply(serial, fullRecordBytes.slice(start, start + 15));
      }
    };

    const recordStore: Record<string, number[]> = {
      name: Array.from(new TextEncoder().encode("致动O+_123456")),
      caps: fromHex(snap.capabilities.hex) as unknown as number[],
      all_keys: Array.from(fromHex(snap.raw.all_keys!.hex)),
      remap_keys: Array.from(fromHex(snap.raw.remap_keys!.hex)),
      macro_keys: Array.from(fromHex(snap.raw.macro_keys!.hex)),
      sticks: Array.from(fromHex(snap.raw.sticks!.hex)),
      triggers: Array.from(fromHex(snap.raw.triggers!.hex)),
      motors: Array.from(fromHex(snap.raw.motors!.hex)),
      remapping: Array.from(fromHex(snap.raw.remapping!.hex)),
      lighting: Array.from(fromHex(snap.raw.lighting!.hex)),
      macro_0: Array.from(fromHex(snap.raw.macro_0!.hex)),
      macro_1: Array.from(fromHex(snap.raw.macro_1!.hex)),
      macro_2: Array.from(fromHex(snap.raw.macro_2!.hex)),
      macro_3: Array.from(fromHex(snap.raw.macro_3!.hex)),
      macro_4: Array.from(fromHex(snap.raw.macro_4!.hex)),
      macro_5: Array.from(fromHex(snap.raw.macro_5!.hex)),
    };
    recordStore.caps = Array.from(fromHex(snap.capabilities.hex));

    const writeAssembler: Record<string, number[]> = {};

    const writeChar: WebBluetoothRemoteGATTCharacteristic = Object.assign(
      new EventTarget(),
      {
        uuid: WRITE,
        properties: { write: true },
        async startNotifications() {
          return writeChar;
        },
        async stopNotifications() {
          return writeChar;
        },
        async writeValueWithResponse(buf: BufferSource) {
          const bytes =
            buf instanceof ArrayBuffer
              ? new Uint8Array(buf)
              : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
          const plain = parse(bytes);
          const rawPlain = (await import("../src/web/protocol.ts")).unscramble(bytes);
          const lengthField = rawPlain[1];

          setTimeout(() => {
            if (plain.opcode === 0x91) {
              emitReply(plain.serial, [7, 0x10, 0x05, 0x20, 0x01, 0x01, 0x37, 0x56]);
            } else if (plain.opcode === 0x90) {
              pagedReply(plain.serial, plain.payload[0], recordStore.name);
            } else if (plain.opcode === 0xb0) {
              const [page, kind] = plain.payload;
              const map: Record<number, string> = {
                1: "caps",
                2: "all_keys",
                3: "remap_keys",
                5: "macro_keys",
              };
              pagedReply(plain.serial, page, recordStore[map[kind]]);
            } else if (plain.opcode === 0xb1) {
              pagedReply(plain.serial, plain.payload[0], recordStore.sticks);
            } else if (plain.opcode === 0xb2) {
              pagedReply(plain.serial, plain.payload[0], recordStore.triggers);
            } else if (plain.opcode === 0xb3) {
              pagedReply(plain.serial, plain.payload[0], recordStore.motors);
            } else if (plain.opcode === 0xb6) {
              pagedReply(plain.serial, plain.payload[0], recordStore.remapping);
            } else if (plain.opcode === 0xb7) {
              pagedReply(plain.serial, plain.payload[0], recordStore.lighting);
            } else if (plain.opcode === 0xb5) {
              const [page, slot] = plain.payload;
              pagedReply(plain.serial, page, recordStore[`macro_${slot}`]);
            } else if (
              plain.opcode === 0x31 ||
              plain.opcode === 0x32 ||
              plain.opcode === 0x35 ||
              plain.opcode === 0x37
            ) {
              const chunkIdx = (plain.serial >>> 3) & 15;
              const key =
                plain.opcode === 0x35
                  ? `macro_${(lengthField >>> 5) & 7}`
                  : plain.opcode === 0x31
                    ? "sticks"
                    : plain.opcode === 0x32
                      ? "triggers"
                      : "lighting";
              if (chunkIdx === 0) writeAssembler[key] = [];
              writeAssembler[key].push(...plain.payload);
              const expectedTotal = writeAssembler[key][0] + 1;
              if (writeAssembler[key].length === expectedTotal) {
                recordStore[key] = writeAssembler[key].slice(1);
              }
              emitReply(plain.serial, [0]);
            }
          }, 1);
        },
      },
    );

    const gattService: WebBluetoothRemoteGATTService = {
      uuid: SERVICE,
      async getCharacteristic(uuid: string) {
        if (uuid === WRITE) return writeChar;
        if (uuid === NOTIFY) return notifyChar;
        throw new Error("unknown char");
      },
    };

    const gattServer: WebBluetoothRemoteGATTServer = {
      get connected() {
        return connected;
      },
      async connect() {
        connected = true;
        return gattServer;
      },
      disconnect() {
        connected = false;
      },
      async getPrimaryService(uuid: string) {
        assert.equal(uuid, SERVICE);
        return gattService;
      },
    };

    const fakeBtDevice: WebBluetoothDevice = Object.assign(new EventTarget(), {
      id: "123456ABCDEF",
      name: "致动O+_123456",
      gatt: gattServer,
    });

    const session = await WebBleSession.connectDevice(fakeBtDevice, {
      chunkDelayMs: 0,
      requestTimeoutMs: 1000,
    });
    try {
      const readSnap = await session.snapshot();
      assert.equal(supportTier(readSnap), "verified");
      assert.equal(readSnap.decoded.device_name, "致动O+_123456");

      // Execute multi-chunk lighting write + macro_0 write with readback verification!
      const store = createMemoryStorage();
      const lightTarget = desiredSetting(readSnap, "lighting", {
        zone: 0,
        rgb: "#00aaff",
      });
      const macroTarget = encodeForSlot(
        { kind: "hold", keys: [93, 11, 12] },
        readSnap,
        0,
      );
      const receipt = await execute(session, store, "save", [
        {
          key: "lighting",
          expected: snapshotRecord(readSnap, "lighting"),
          target: lightTarget,
        },
        {
          key: "macro_0",
          expected: snapshotRecord(readSnap, "macro_0"),
          target: macroTarget,
        },
      ]);
      assert.equal(receipt.journal.state, "completed");
      assert.ok(
        bytesEqual(snapshotRecord(receipt.snapshot, "lighting"), lightTarget),
      );
      assert.ok(
        bytesEqual(snapshotRecord(receipt.snapshot, "macro_0"), macroTarget),
      );

      // Verify WebBLE 0x31 (WRITE_STICK) & 0x32 (WRITE_TRIGGER) single-packet 15-byte payload + undo roundtrip!
      const stickTarget = desiredSetting(receipt.snapshot, "sticks", {
        side: 0,
        inner: 8,
        outer_raw: 8,
        point1: [35, 35],
        point2: [136, 204],
        invert_x: false,
        invert_y: true,
        swap: false,
      });
      const triggerTarget = desiredSetting(receipt.snapshot, "triggers", {
        side: 1,
        inner: 4,
        outer_raw: 34,
        point1: [142, 142],
        point2: [220, 157],
      });
      const curveReceipt = await execute(session, store, "save", [
        {
          key: "sticks",
          expected: snapshotRecord(receipt.snapshot, "sticks"),
          target: stickTarget,
        },
        {
          key: "triggers",
          expected: snapshotRecord(receipt.snapshot, "triggers"),
          target: triggerTarget,
        },
      ]);
      assert.equal(curveReceipt.journal.state, "completed");
      assert.ok(
        bytesEqual(snapshotRecord(curveReceipt.snapshot, "sticks"), stickTarget),
      );
      assert.ok(
        bytesEqual(
          snapshotRecord(curveReceipt.snapshot, "triggers"),
          triggerTarget,
        ),
      );

      const curveUndo = await execute(
        session,
        store,
        "undo",
        undoEdits(curveReceipt.journal),
      );
      assert.equal(curveUndo.journal.state, "completed");
      assert.ok(
        bytesEqual(
          snapshotRecord(curveUndo.snapshot, "sticks"),
          snapshotRecord(readSnap, "sticks"),
        ),
      );
      assert.ok(
        bytesEqual(
          snapshotRecord(curveUndo.snapshot, "triggers"),
          snapshotRecord(readSnap, "triggers"),
        ),
      );
    } finally {
      await session.close();
    }
  });
});

describe("5. v0.7.0 Stick & Trigger Curves, Capability Side Gate & Fritsch-Carlson Spline", () => {
  it("preserves opposite channel 7 bytes and high flags (0xF8 / trigger flags), and rejects invalid curves or disabled sides", async () => {
    const s = cloneSnapshotFixture();
    s.raw.sticks = makeRecord([
      6, 8, 85, 85, 170, 170, 0xa8, // Left stick with unknown high bits 0xA8
      9, 12, 35, 35, 136, 204, 0x50, // Right stick
    ]);
    s.raw.triggers = makeRecord([
      4, 2, 85, 85, 170, 170, 0x5a, // Left trigger with flags 0x5A
      20, 40, 142, 142, 220, 157, 0x33, // Right trigger
    ]);
    const origSticks = snapshotRecord(s, "sticks");
    const origTriggers = snapshotRecord(s, "triggers");

    // 1. Single-side stick edit preserves Right 7 bytes & Left 0xA8 high flag bits
    const nextSticks = desiredSetting(s, "sticks", {
      side: 0,
      inner: 10,
      outer_raw: 15,
      point1: [35, 35],
      point2: [136, 204],
      invert_x: true,
      invert_y: false,
      swap: true,
    });
    assert.deepEqual(nextSticks.slice(1, 8), [
      10,
      15,
      35,
      35,
      136,
      204,
      0xa8 | 0x01 | 0x04,
    ]);
    assert.deepEqual(nextSticks.slice(8, 15), origSticks.slice(8, 15));
    assert.doesNotThrow(() => boundary(s, "sticks", origSticks, nextSticks));

    // 2. Single-side trigger edit preserves Left 7 bytes & Right 0x33 flags byte
    const nextTriggers = desiredSetting(s, "triggers", {
      side: 1,
      inner: 30,
      outer_raw: 60,
      point1: [67, 67],
      point2: [72, 106],
    });
    assert.deepEqual(nextTriggers.slice(1, 8), origTriggers.slice(1, 8));
    assert.deepEqual(nextTriggers.slice(8, 15), [30, 60, 67, 67, 72, 106, 0x33]);
    assert.doesNotThrow(() =>
      boundary(s, "triggers", origTriggers, nextTriggers),
    );

    // 3. Reject inner + outer_raw >= max_progress and p1_x > p2_x
    for (const badStick of [
      {
        side: 0,
        inner: 60,
        outer_raw: 40,
        point1: [85, 85],
        point2: [170, 170],
        invert_x: false,
        invert_y: false,
        swap: false,
      },
      {
        side: 0,
        inner: 92,
        outer_raw: 8,
        point1: [85, 85],
        point2: [170, 170],
        invert_x: false,
        invert_y: false,
        swap: false,
      },
      {
        side: 0,
        inner: 6,
        outer_raw: 8,
        point1: [171, 85],
        point2: [170, 170],
        invert_x: false,
        invert_y: false,
        swap: false,
      },
    ]) {
      assert.throws(() => desiredSetting(s, "sticks", badStick));
    }

    for (const badTrig of [
      { side: 0, inner: 140, outer_raw: 60, point1: [85, 85], point2: [170, 170] },
      { side: 1, inner: 200, outer_raw: 0, point1: [85, 85], point2: [170, 170] },
      { side: 1, inner: 4, outer_raw: 34, point1: [120, 100], point2: [119, 200] },
    ]) {
      assert.throws(() => desiredSetting(s, "triggers", badTrig));
    }

    // 4. boundary() rejects tampered high flags on sticks (0xF8) and ANY flags change on triggers
    const tamperedStickFlags = [...nextSticks];
    tamperedStickFlags[7] ^= 0x08;
    assert.throws(() =>
      boundary(s, "sticks", origSticks, tamperedStickFlags),
    );

    const tamperedTrigFlags = [...nextTriggers];
    tamperedTrigFlags[14] ^= 0x01;
    assert.throws(() =>
      boundary(s, "triggers", origTriggers, tamperedTrigFlags),
    );

    // 5. Capability single-side gate: bit 1 (0x02) = Left, bit 0 (0x01) = Right!
    assert.equal(curveSideMask(0), 0x02);
    assert.equal(curveSideMask(1), 0x01);

    const sLeftOnly = structuredClone(s);
    sLeftOnly.identity.version_display = "1.46";
    sLeftOnly.capabilities = makeRecord([0x02, 0x02, 15, 0, 63, 1, 11, 0, 192, 0]);
    assert.doesNotThrow(() =>
      desiredSetting(sLeftOnly, "sticks", {
        side: 0,
        inner: 12,
        outer_raw: 8,
        point1: [85, 85],
        point2: [170, 170],
        invert_x: false,
        invert_y: false,
        swap: false,
      }),
    );
    assert.throws(() =>
      desiredSetting(sLeftOnly, "sticks", {
        side: 1,
        inner: 12,
        outer_raw: 8,
        point1: [85, 85],
        point2: [170, 170],
        invert_x: false,
        invert_y: false,
        swap: false,
      }),
    );
    assert.doesNotThrow(() =>
      desiredSetting(sLeftOnly, "triggers", {
        side: 0,
        inner: 4,
        outer_raw: 34,
        point1: [85, 85],
        point2: [170, 170],
      }),
    );
    assert.throws(() =>
      desiredSetting(sLeftOnly, "triggers", {
        side: 1,
        inner: 4,
        outer_raw: 34,
        point1: [85, 85],
        point2: [170, 170],
      }),
    );
    assert.throws(() =>
      boundary(sLeftOnly, "triggers", origTriggers, nextTriggers),
    );
  });

  it("matches KeyLinker Fritsch-Carlson monotone cubic spline, 5 curve presets, and 4 trigger gears", () => {
    assert.equal(CURVE_PRESETS.length, 5);
    assert.equal(TRIGGER_GEARS.length, 4);
    assert.equal(matchCurvePreset([85, 85], [170, 170]), "default");
    assert.equal(matchCurvePreset([67, 67], [72, 106]), "fine");
    assert.equal(matchCurvePreset([50, 80], [170, 170]), null);
    assert.equal(matchTriggerGear(0, 0), "zero");
    assert.equal(matchTriggerGear(4, 34), "small");
    assert.equal(matchTriggerGear(20, 40), "medium");
    assert.equal(matchTriggerGear(30, 60), "large");
    assert.equal(matchTriggerGear(4, 2), null);

    // Linear preset sits strictly on y == x
    for (const [x, y] of curveShape([85, 85], [170, 170], 33)) {
      assert.ok(Math.abs(x - y) < 1e-6);
    }

    // Monotone presets pass through exact knots without out-of-range overshoot
    for (const preset of CURVE_PRESETS) {
      assert.ok(
        Math.abs(
          evaluateCurveY(preset.point1, preset.point2, preset.point1[0]) -
            preset.point1[1],
        ) < 1e-6,
      );
      assert.ok(
        Math.abs(
          evaluateCurveY(preset.point1, preset.point2, preset.point2[0]) -
            preset.point2[1],
        ) < 1e-6,
      );
      const pts = curveShape(preset.point1, preset.point2, 65);
      for (const [, y] of pts) {
        assert.ok(y >= 0 && y <= 255);
      }
    }
  });
});

describe("6. v0.7.1 Audit Regressions: Wrong-Device Guard, Durable IDB, Cross-Tab Lock, Legacy Undo, BLE Timeout & WCAG", () => {
  function stickEdit(snapshot: Snapshot, inner: number): Edit {
    const expected = [...snapshotRecord(snapshot, "sticks")];
    const target = desiredSetting(snapshot, "sticks", {
      side: 0,
      inner,
      outer_raw: 8,
      point1: [85, 85],
      point2: [170, 170],
      invert_x: false,
      invert_y: false,
      swap: false,
    });
    return { key: "sticks", expected, target };
  }

  function stickSetting(inner: number) {
    return {
      feature: "stick_curve" as const,
      side: 0,
      inner,
      outer_raw: 8,
      point1: [85, 85] as [number, number],
      point2: [170, 170] as [number, number],
      invert_x: false,
      invert_y: false,
      swap: false,
    };
  }

  function fakePad(bt?: { id: string; name?: string }) {
    const state = cloneSnapshotFixture();
    if (bt) {
      state.address = formatWebDeviceAddress(bt as WebBluetoothDevice);
    }
    const writes: { key: string; payload: number[] }[] = [];
    return {
      state,
      writes,
      address: state.address,
      snapshot: async () => structuredClone(state),
      read: async (key: string) => [...snapshotRecord(state, key)],
      write: async (key: string, payload: readonly number[]) => {
        writes.push({ key, payload: [...payload] });
        state.raw[key] = recordFromPayload(payload);
      },
      close: async () => {},
    };
  }

  it("restores legacy out-of-editor-range curves cleanly across save, undo, and crash recovery", async () => {
    const dev = fakePad();
    const legacy = [...snapshotRecord(dev.state, "sticks")];
    legacy[1] = 92; // inner=92, outer_raw=8 -> sum 100
    legacy[3] = 0; // P1.x == 0
    dev.state.raw.sticks = recordFromPayload(legacy);
    assert.equal(supportTier(dev.state), "verified");

    const store = createMemoryStorage();
    const receipt = await execute(dev, store, "save", [stickEdit(dev.state, 6)]);
    assert.equal(receipt.journal.state, "completed");
    assert.equal(snapshotRecord(dev.state, "sticks")[1], 6);

    const undone = await execute(dev, store, "undo", undoEdits(receipt.journal));
    assert.equal(undone.journal.state, "completed");
    assert.deepEqual(snapshotRecord(dev.state, "sticks"), legacy);

    // Crash recovery path also restores legacy original bytes!
    const savedAgain = await execute(dev, store, "save", [stickEdit(dev.state, 8)]);
    savedAgain.journal.state = "writing";
    savedAgain.journal.records[0].attempted = true;
    savedAgain.journal.records[0].state = "write_intent";
    await persistJournal(store, savedAgain.journal);

    const [journal] = await pending(store);
    assert.ok(journal);
    const recovery = await recoveryEdits(store, journal, dev.state);
    assert.equal(recovery.length, 1);
    const recovered = await execute(dev, store, "recovery", recovery);
    assert.deepEqual(snapshotRecord(recovered.snapshot, "sticks"), legacy);
  });

  it("enforces fixed (0,0)/(255,255) spline endpoints and zero output inside deadzone", () => {
    const dev = fakePad();
    assert.throws(() =>
      desiredSetting(dev.state, "sticks", {
        ...stickSetting(6),
        point1: [0, 170],
        point2: [170, 220],
      }),
    );
    assert.throws(() =>
      desiredSetting(dev.state, "sticks", {
        ...stickSetting(6),
        point1: [85, 85],
        point2: [255, 220],
      }),
    );
    assert.throws(() =>
      desiredSetting(dev.state, "sticks", {
        ...stickSetting(6),
        point1: [120, 90],
        point2: [120, 180],
      }),
    );

    // Even when rendering a legacy read-only curve with P1=(0,170), origin & deadzone output are strictly 0!
    assert.equal(evaluateCurveY([0, 170], [170, 220], 0), 0);
    assert.equal(evaluateCurveY([0, 170], [170, 220], 255), 255);
    const pts = curveShape([0, 170], [170, 220], 33);
    assert.deepEqual(pts[0], [0, 0]);
    assert.deepEqual(pts[pts.length - 1], [255, 255]);

    const centered = projectCurvePreview(0, 6, 8, 100, [0, 170], [170, 220]);
    assert.equal(centered.outPct, 0);
    assert.equal(centered.zoneLabel, "死区内");

    const insideDz = projectCurvePreview(0.05, 6, 8, 100, [35, 200], [170, 240]);
    assert.equal(insideDz.outPct, 0);
    assert.equal(insideDz.zoneLabel, "死区内");

    const fullTravel = projectCurvePreview(0.95, 6, 8, 100, [35, 200], [170, 240]);
    assert.equal(fullTravel.outPct, 100);
    assert.equal(fullTravel.zoneLabel, "满行程");
  });

  it("refuses to write to a different authorized controller when baseline controller disappears", async () => {
    const a = { id: "fixture-A-001", name: "fixture A" };
    const b = { id: "fixture-B-002", name: "fixture B" };
    const padA = fakePad(a);
    const padB = fakePad(b);
    let permitted = [a];
    const bluetooth = {
      getDevices: async () => permitted,
      requestDevice: async () => b,
    };
    Object.defineProperty(globalThis.navigator, "bluetooth", {
      value: bluetooth,
      configurable: true,
    });
    const realConnect = WebBleSession.connectDevice;
    let failReadOfB = true;
    (WebBleSession as any).connectDevice = async (device: unknown) => {
      if (device === a) return padA;
      if (failReadOfB) throw new Error("fixture B connection failed");
      return padB;
    };
    try {
      const { webInvoke } = await import("../src/web/runtime.ts?guard-wrong-device");
      const view = await webInvoke("run", {
        request: { action: "read", address: padA.address },
      });
      assert.equal(view.snapshot.address, padA.address);

      permitted = [b];
      await assert.rejects(
        webInvoke("run", {
          request: { action: "read", address: "", forcePicker: true },
        }),
        /fixture B connection failed/,
      );
      failReadOfB = false;

      // Must reject saving A's draft onto B! Neither A nor B may receive writes!
      await assert.rejects(
        webInvoke("run", {
          request: { action: "save", changes: {}, settings: [stickSetting(8)] },
        }),
        /未找到原目标手柄|不一致/,
      );
      assert.equal(padA.writes.length, 0);
      assert.equal(padB.writes.length, 0);
    } finally {
      WebBleSession.connectDevice = realConnect;
      setCachedWebDeviceForTest(null);
      delete (globalThis.navigator as any).bluetooth;
    }
  });

  it("blocks concurrent two-tab writes on the same controller via cross-tab device lock and conflict detection", async () => {
    const bt = { id: "shared-pad-001", name: "shared pad" };
    const dev = fakePad(bt);
    const baseWrite = dev.write;
    const slowDev = {
      ...dev,
      write: async (key: string, target: readonly number[]) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await baseWrite(key, target);
      },
    };
    const realConnect = WebBleSession.connectDevice;
    (WebBleSession as any).connectDevice = async () => slowDev;
    Object.defineProperty(globalThis.navigator, "bluetooth", {
      value: { getDevices: async () => [bt], requestDevice: async () => bt },
      configurable: true,
    });
    try {
      const tabA = (await import("../src/web/runtime.ts?tab-lock-A")).webInvoke;
      const tabB = (await import("../src/web/runtime.ts?tab-lock-B")).webInvoke;
      await tabA("run", { request: { action: "read", address: dev.address } });
      await tabB("run", { request: { action: "read", address: dev.address } });

      const outcomes = await Promise.allSettled([
        tabA("run", {
          request: { action: "save", changes: {}, settings: [stickSetting(8)] },
        }),
        tabB("run", {
          request: { action: "save", changes: {}, settings: [stickSetting(9)] },
        }),
      ]);
      const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal(dev.writes.length, 1);
      assert.equal(snapshotRecord(dev.state, "sticks")[1], 8);

      // Even after Tab A releases the lock, Tab B's stale baseline (expected=6) is rejected by prepare()!
      await assert.rejects(
        tabB("run", {
          request: { action: "save", changes: {}, settings: [stickSetting(9)] },
        }),
        /已被其他软件修改/,
      );
      assert.equal(dev.writes.length, 1);
    } finally {
      WebBleSession.connectDevice = realConnect;
      setCachedWebDeviceForTest(null);
      delete (globalThis.navigator as any).bluetooth;
    }
  });

  it("blocks hardware writes when IndexedDB fails to open while still allowing read-only kv fallback", async () => {
    (globalThis as any).indexedDB = {
      open() {
        const request: any = {};
        queueMicrotask(() => {
          request.error = new DOMException(
            "Browser storage unavailable",
            "SecurityError",
          );
          request.onerror?.();
        });
        return request;
      },
    };
    try {
      const { webStorage: deniedStorage } = await import(
        "../src/web/storage.ts?denied-idb-v071"
      );
      // Ephemeral kv browsing works
      await deniedStorage.put("kv", "theme-test", { ok: true });
      assert.deepEqual(await deniedStorage.get("kv", "theme-test"), { ok: true });

      // Hardware write MUST reject before touching the controller!
      const dev = fakePad();
      await assert.rejects(
        execute(dev, deniedStorage, "save", [stickEdit(dev.state, 8)]),
        /IndexedDB/,
      );
      assert.equal(dev.writes.length, 0);
      assert.equal(snapshotRecord(dev.state, "sticks")[1], 6);
    } finally {
      delete (globalThis as any).indexedDB;
    }
  });

  it("cleans up timed-out WebBLE request waiters so subsequent replies succeed", async () => {
    let dropped = false;
    const notifier = Object.assign(new EventTarget(), {
      value: null as DataView | null,
      startNotifications: async () => notifier,
      stopNotifications: async () => notifier,
    });
    const writer = {
      properties: { write: true },
      async writeValueWithResponse(bytes: BufferSource) {
        const buf =
          bytes instanceof ArrayBuffer
            ? new Uint8Array(bytes)
            : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const request = parse(buf);
        if (request.opcode === 0xb3 && !dropped) {
          dropped = true;
          return;
        }
        const payload =
          request.opcode === 0x91
            ? [7, 0x10, 5, 0x20, 1, 1, 0x37, 0x56]
            : [0];
        const reply = Uint8Array.from(
          frame(0x19, payload, request.serial, 42, null),
        );
        notifier.value = new DataView(reply.buffer);
        queueMicrotask(() =>
          notifier.dispatchEvent(new Event("characteristicvaluechanged")),
        );
      },
    };
    const gatt = {
      connected: false,
      async connect() {
        this.connected = true;
        return this;
      },
      disconnect() {
        this.connected = false;
      },
      async getPrimaryService() {
        return {
          async getCharacteristic(uuid: string) {
            if (uuid === WRITE) return writer;
            assert.equal(uuid, NOTIFY);
            return notifier;
          },
        };
      },
    };
    const session = await WebBleSession.connectDevice(
      { id: "timeout-fixture", gatt } as unknown as WebBluetoothDevice,
      { requestTimeoutMs: 40, chunkDelayMs: 0 },
    );
    try {
      await assert.rejects(session.read("motors"), /响应超时/);
      const remapping = await session.read("remapping");
      assert.deepEqual(remapping, [0]);
    } finally {
      await session.close();
    }
  });

  it("prevents GATT operation already in progress when notifications arrive before writeValueWithResponse settles", async () => {
    const fixtureSnap = cloneSnapshotFixture();
    let gattBusy = false;
    const notifier = Object.assign(new EventTarget(), {
      value: null as DataView | null,
      startNotifications: async () => notifier,
      stopNotifications: async () => notifier,
    });
    const writer = {
      properties: { write: true },
      async writeValueWithResponse(bytes: BufferSource) {
        if (gattBusy) {
          throw new Error("GATT operation already in progress.");
        }
        gattBusy = true;
        const buf =
          bytes instanceof ArrayBuffer
            ? new Uint8Array(bytes)
            : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const req = parse(buf);
        const page = req.payload[0] ?? 0;
        let full: number[] = [0];
        if (req.opcode === 0x91) {
          full = [7, 0x10, 0x05, 0x20, 0x01, 0x01, 0x37, 0x56];
        } else if (req.opcode === 0x90) {
          const nameBytes = Array.from(new TextEncoder().encode("致动O+_CB4EC9"));
          full = [nameBytes.length, ...nameBytes];
        } else if (req.opcode === 0xb0) {
          const kind = req.payload[1];
          const rec =
            kind === 1
              ? fixtureSnap.capabilities
              : kind === 2
                ? fixtureSnap.raw.all_keys!
                : kind === 3
                  ? fixtureSnap.raw.remap_keys!
                  : fixtureSnap.raw.macro_keys!;
          const rawBytes = Array.from(fromHex(rec.hex));
          full = [rec.declared, ...rawBytes];
        } else if (req.opcode === 0xb1) {
          full = snapshotRecord(fixtureSnap, "sticks");
        } else if (req.opcode === 0xb2) {
          full = snapshotRecord(fixtureSnap, "triggers");
        } else if (req.opcode === 0xb3) {
          full = snapshotRecord(fixtureSnap, "motors");
        } else if (req.opcode === 0xb6) {
          full = snapshotRecord(fixtureSnap, "remapping");
        } else if (req.opcode === 0xb7) {
          full = snapshotRecord(fixtureSnap, "lighting");
        } else if (req.opcode === 0xb5) {
          full = snapshotRecord(fixtureSnap, `macro_${req.payload[1]}`);
        }
        const slice =
          req.opcode === 0x91
            ? full
            : full.slice(page * 15, (page + 1) * 15);
        const reply = Uint8Array.from(frame(0x19, slice, req.serial, 9, null));
        notifier.value = new DataView(reply.buffer);
        // Fire notification IMMEDIATELY before writeValueWithResponse resolves (exact Chromium WinRT BLE order!)
        notifier.dispatchEvent(new Event("characteristicvaluechanged"));
        await new Promise((resolve) => setTimeout(resolve, 6));
        gattBusy = false;
      },
    };
    const gatt = {
      connected: false,
      async connect() {
        this.connected = true;
        return this;
      },
      disconnect() {
        this.connected = false;
      },
      async getPrimaryService() {
        return {
          async getCharacteristic(uuid: string) {
            if (uuid === WRITE) return writer;
            return notifier;
          },
        };
      },
    };
    const session = await WebBleSession.connectDevice(
      {
        id: "5Bj2Es5idu",
        name: "致动O+_CB4EC9",
        gatt,
      } as unknown as WebBluetoothDevice,
      { requestTimeoutMs: 500, chunkDelayMs: 0 },
    );
    try {
      const snap = await session.snapshot();
      assert.equal(snap.errors.length, 0);
      assert.equal(supportTier(snap), "verified");
      assert.equal(session.canWrite, true);
      for (let slot = 0; slot < 6; slot++) {
        assert.ok(snap.raw[`macro_${slot}`]);
      }
    } finally {
      await session.close();
    }
  });

  it("strips diagnostic trace from pre-write backups, accepts >256 KiB keymap imports, and meets WCAG 4.5:1 + version parity", async () => {
    // 1. Oversized trace in snapshot.extra is stripped from backup so pending() succeeds
    const dev = fakePad();
    dev.state.extra = {
      trace: Array.from({ length: 800 }, () => ({
        direction: "rx",
        opcode: 0x19,
        serial: 0,
        payload: "00".repeat(16),
        wire: "00".repeat(20),
      })),
    };
    const store = createMemoryStorage();
    const [journal] = await prepare(dev, store, "save", [stickEdit(dev.state, 8)]);
    journal.state = "writing";
    journal.records[0].attempted = true;
    await persistJournal(store, journal);
    assert.equal((await pending(store)).length, 1);

    // 2. 40-rule x 64-step KeymapStore (>256 KiB) imports cleanly
    const bigStore = {
      schema: 1,
      active_profile_id: "default",
      controller_slot: null,
      trigger_threshold: 64,
      stick_deadzone: 16000,
      profiles: [
        {
          id: "default",
          name: "大体积宏方案",
          rules: Array.from({ length: 40 }, (_, idx) => ({
            id: `rule-${idx}`,
            name: `Macro ${idx}`,
            enabled: false,
            rear_slot: null,
            trigger: ["A"],
            action: {
              kind: "macro",
              steps: Array.from({ length: 64 }, () => ({
                keys: ["A"],
                hold_ms: 100,
                gap_ms: 100,
              })),
              trigger_mode: "once",
              loop_ms: 0,
            },
          })),
        },
      ],
    };
    const bigJson = JSON.stringify(bigStore, null, 2);
    assert.ok(Buffer.byteLength(bigJson, "utf8") > 256 * 1024);
    const importedBig = importKeymapAny(bigJson);
    assert.equal(importedBig.rules.length, 40);

    // 3. WCAG 2.2 AA (>= 4.5:1) contrast check on all --accent-fill-* stops vs #ffffff in style.css
    const cssText = fs.readFileSync(
      new URL("../src/style.css", import.meta.url),
      "utf-8",
    );
    const relLum = (hex: string): number => {
      const clean = hex.replace("#", "");
      const vals = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
      const [r, g, b] = vals.map((c) =>
        c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
      );
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrastWithWhite = (hex: string): number =>
      1.05 / (relLum(hex) + 0.05);

    const fillMatches = [
      ...cssText.matchAll(
        /--accent-fill-(?:top|bot|hover-top|hover-bot):\s*(#[0-9a-fA-F]{6})/g,
      ),
    ];
    assert.ok(fillMatches.length >= 8);
    for (const [, hex] of fillMatches) {
      const ratio = contrastWithWhite(hex);
      assert.ok(
        ratio >= 4.5,
        `Expected ${hex} contrast with #ffffff >= 4.5:1, got ${ratio.toFixed(2)}:1`,
      );
    }

    // 4. Version parity across APP_VERSION, package.json, Cargo.toml, tauri.conf.json, windows.manifest
    const uiPkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    );
    const tauriConf = JSON.parse(
      fs.readFileSync(
        new URL("../../app/tauri.conf.json", import.meta.url),
        "utf-8",
      ),
    );
    const cargoToml = fs.readFileSync(
      new URL("../../Cargo.toml", import.meta.url),
      "utf-8",
    );
    const winManifest = fs.readFileSync(
      new URL("../../app/windows.manifest", import.meta.url),
      "utf-8",
    );
    assert.equal(uiPkg.version, APP_VERSION);
    assert.equal(tauriConf.version, APP_VERSION);
    assert.match(cargoToml, new RegExp(`^version\\s*=\\s*"${APP_VERSION.replace(/\./g, "\\.")}"`, "m"));
    assert.match(winManifest, new RegExp(`version="${APP_VERSION.replace(/\./g, "\\.")}\\.0"`));
  });

  it("computes 36-sector circularity RMS error, resting drift, and polling rate Hz with zero heap churn", () => {
    const bench = new StickBenchAnalyzer();
    // Perfect unit circle across all 36 sectors -> ~0.0% RMS circularity error
    for (let deg = 0; deg < 360; deg += 5) {
      const rad = (deg * Math.PI) / 180;
      bench.push(Math.cos(rad), Math.sin(rad));
    }
    assert.equal(bench.coveredCount, 36);
    assert.ok(bench.avgErrorPct !== null && bench.avgErrorPct < 0.05);
    assert.match(bench.buildSvgPath(108, 108, 84), /^M.*Z$/);

    // Settle back with 2.5% drift after deflection
    for (let i = 0; i < 15; i++) {
      bench.push(0.015, -0.02);
    }
    assert.ok(Math.abs(bench.restDriftPct - 2.5) < 0.05);

    const rate = new PollingRateAnalyzer();
    for (let i = 0; i < 20; i++) {
      rate.push({
        slot: 0,
        buttons: 0,
        left_trigger: 0,
        right_trigger: 0,
        lx: i * 100,
        ly: 0,
        rx: 0,
        ry: 0,
        fx: i * 0.01,
        fy: 0,
        frx: 0,
        fry: 0,
        flt: 0,
        frt: 0,
        sampleTs: 1000 + i * 4, // 4ms interval = 250 Hz, 0.0ms jitter
        id: "Test Pad",
        actuator: null,
      });
    }
    const stats = rate.stats();
    assert.ok(stats);
    assert.equal(stats.hz, 250);
    assert.ok(stats.jitterMs < 0.01);
  });
});
