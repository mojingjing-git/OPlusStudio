import { useEffect, useRef, useState } from "react";
import {
  inferDesktopReleaseUrl,
  invoke,
  isTauriRuntime,
} from "./backend";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronUp,
  Gamepad2,
  Info,
  Keyboard,
  MousePointerClick,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  BRIDGE_PRESETS,
  type Change,
  type Input,
  type KbStep,
  type KbTriggerMode,
  type KeymapProfile,
  type KeymapRule,
  type KeymapStore,
  OUTPUT_GROUPS,
  type OutputToken,
  PAD_BUTTONS,
  type PadButton,
  type RunnerSnapshot,
  type View,
  codeToOutputToken,
  defaultSlotLabel,
  isPadButtonActive,
  isWheelToken,
  outputLabel,
  padButtonLabel,
  padButtonToOnboardKey,
} from "./types";

type CaptureTarget =
  | { mode: "hold" }
  | { mode: "step"; stepIndex: number };

function newId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function sameNumberSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

function checkRuleBridgeState(
  rule: KeymapRule,
  view: View | null,
  stagedChanges: Record<string, Change>,
): "no_ble" | "unsupported" | "synced_board" | "synced_draft" | "needs_sync" {
  if (rule.rear_slot === null || rule.rear_slot === undefined) {
    return "unsupported";
  }
  if (!view) return "no_ble";
  if (
    view.support_tier === "read_only" ||
    !view.active_slots.includes(rule.rear_slot)
  ) {
    return "unsupported";
  }
  const onboardKeys: number[] = [];
  for (const b of rule.trigger) {
    const code = padButtonToOnboardKey(b);
    if (code === null) return "unsupported";
    if (!onboardKeys.includes(code)) onboardKeys.push(code);
  }
  const macroKeys = view.snapshot.decoded.macro_keys || [];
  if (
    !onboardKeys.every(
      (k) => k !== 18 && k !== 19 && macroKeys.includes(k),
    )
  ) {
    return "unsupported";
  }
  const draft = stagedChanges[rule.rear_slot];
  if (draft) {
    if (draft.kind === "hold" && sameNumberSet(draft.keys, onboardKeys)) {
      return "synced_draft";
    }
    return "needs_sync";
  }
  const form = view.forms[rule.rear_slot];
  if (form && form.kind === "hold" && sameNumberSet(form.keys, onboardKeys)) {
    return "synced_board";
  }
  return "needs_sync";
}

function describeAction(rule: KeymapRule): string {
  if (rule.action.kind === "hold") {
    return "按住 " + rule.action.keys.map(outputLabel).join(" + ");
  }
  const modeText =
    rule.action.trigger_mode === "once"
      ? "单次"
      : rule.action.trigger_mode === "hold_loop"
        ? "按住循环"
        : "切换循环";
  return `顺序宏 · ${rule.action.steps.length} 步 · ${modeText}`;
}

function runnerStateText(runner: RunnerSnapshot): string {
  if (!runner.enabled) {
    return runner.last_panic ? "已由 F8 紧急停止" : "已停止";
  }
  switch (runner.state) {
    case "paused_ble":
      return "蓝牙配置期间自动暂停";
    case "paused_recording":
      return "按键录入期间自动暂停";
    case "no_controller":
      return "等待 XInput 手柄接入";
    case "wait_neutral":
      return "请先松开手柄按键解锁";
    case "active":
      return runner.active_rules.length
        ? `正在执行：${runner.active_rules.join("、")}`
        : "执行中";
    default:
      return "监听中";
  }
}

function KeyCaptureModal({
  onSelect,
  onClose,
}: {
  onSelect: (token: OutputToken) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [f8Warn, setF8Warn] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
    void invoke("keymap_set_recording", { recording: true }).catch(() => {});
    return () => {
      void invoke("keymap_set_recording", { recording: false }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const mapped = codeToOutputToken(e.code);
      if (mapped === "F8") {
        setF8Warn(true);
        return;
      }
      if (mapped) {
        onSelect(mapped);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onSelect]);

  return (
    <dialog
      ref={ref}
      className="capture-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>录入键盘或鼠标输出</h2>
        <button className="icon" aria-label="关闭录入窗口" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="capture-box">
        <Keyboard size={36} />
        <strong>请直接按下任意物理键盘按键</strong>
        <span>
          基于物理键位码识别，不受中文输入法影响；自动区分左右 Ctrl / Shift /
          Alt / Win 与小键盘回车。
        </span>
      </div>
      {f8Warn && (
        <p className="field-error" role="alert">
          F8 为全局紧急停止保留键，不能作为映射或宏输出，请按其他按键。
        </p>
      )}
      <div className="capture-mouse-section">
        <span className="subtle">
          <MousePointerClick size={15} /> 或直接选择鼠标动作：
        </span>
        <div className="capture-mouse-grid">
          {[
            ["MouseLeft", "鼠标左键"],
            ["MouseRight", "鼠标右键"],
            ["MouseMiddle", "鼠标中键"],
            ["MouseX1", "侧键 X1"],
            ["MouseX2", "侧键 X2"],
            ["WheelUp", "滚轮向上"],
            ["WheelDown", "滚轮向下"],
          ].map(([tok, label]) => (
            <button
              key={tok}
              type="button"
              onClick={() => onSelect(tok)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          取消
        </button>
      </div>
    </dialog>
  );
}

export default function KeymapPage({
  store,
  runner,
  view,
  stagedChanges,
  inputs,
  onStoreUpdate,
  onRunnerUpdate,
  onStageBoardChange,
  onError,
  onNotice,
  onModalChange,
}: {
  store: KeymapStore;
  runner: RunnerSnapshot;
  view: View | null;
  stagedChanges: Record<string, Change>;
  inputs: Input[];
  onStoreUpdate: (next: KeymapStore) => void;
  onRunnerUpdate: (next: RunnerSnapshot) => void;
  onStageBoardChange: (slot: number, change: Change, label: string) => void;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
  onModalChange: (open: boolean) => void;
}) {
  const isTauri = isTauriRuntime();
  const desktopReleaseUrl = !isTauri ? inferDesktopReleaseUrl() : null;
  const activeProfile: KeymapProfile =
    store.profiles.find((p) => p.id === store.active_profile_id) ||
    store.profiles[0];
  const [selectedRuleId, setSelectedRuleId] = useState<string>(
    activeProfile?.rules[0]?.id || "",
  );
  const [captureTarget, setCaptureTarget] = useState<CaptureTarget | null>(
    null,
  );
  const [nameDialog, setNameDialog] = useState<{
    mode: "create" | "rename";
    value: string;
  } | null>(null);
  const [desktopGuideOpen, setDesktopGuideOpen] = useState(false);
  const [showCustomChord, setShowCustomChord] = useState(false);
  const [showThresholds, setShowThresholds] = useState(false);
  const [pickAddToken, setPickAddToken] = useState<OutputToken>("Space");

  useEffect(() => {
    onModalChange(Boolean(captureTarget || nameDialog || desktopGuideOpen));
    return () => onModalChange(false);
  }, [captureTarget, nameDialog, desktopGuideOpen, onModalChange]);

  useEffect(() => {
    if (!activeProfile) return;
    if (!activeProfile.rules.some((r) => r.id === selectedRuleId)) {
      setSelectedRuleId(activeProfile.rules[0]?.id || "");
      setShowCustomChord(false);
    }
  }, [activeProfile, selectedRuleId]);

  const selectedRule =
    activeProfile?.rules.find((r) => r.id === selectedRuleId) || null;

  const livePad =
    store.controller_slot !== null && store.controller_slot !== undefined
      ? inputs.find((p) => p.slot === store.controller_slot)
      : inputs[0];

  const availableRearSlots: number[] =
    view && view.support_tier !== "read_only" && view.active_slots.length > 0
      ? view.active_slots
      : [0, 1, 2, 3, 4, 5];

  const rearLabel = (slot: number) =>
    (view && view.labels[slot]) || defaultSlotLabel(slot, availableRearSlots);

  const persistStore = async (next: KeymapStore) => {
    onError("");
    try {
      const res = await invoke<{ keymap: KeymapStore; runner: RunnerSnapshot }>(
        "keymap_save_store",
        { store: next },
      );
      onStoreUpdate(res.keymap);
      onRunnerUpdate(res.runner);
      return true;
    } catch (e) {
      onError(String(e));
      return false;
    }
  };

  const updateProfile = (patchFn: (p: KeymapProfile) => KeymapProfile) => {
    const next: KeymapStore = {
      ...store,
      profiles: store.profiles.map((p) =>
        p.id === activeProfile.id ? patchFn(p) : p,
      ),
    };
    void persistStore(next);
  };

  const updateRule = (ruleId: string, patchFn: (r: KeymapRule) => KeymapRule) => {
    updateProfile((p) => ({
      ...p,
      rules: p.rules.map((r) => (r.id === ruleId ? patchFn(r) : r)),
    }));
  };

  const toggleEngine = async () => {
    onError("");
    try {
      const snap = await invoke<RunnerSnapshot>("keymap_set_enabled", {
        enabled: !runner.enabled,
      });
      onRunnerUpdate(snap);
    } catch (e) {
      onError(String(e));
    }
  };

  const dismissWarning = async () => {
    try {
      const snap = await invoke<RunnerSnapshot>("keymap_dismiss_warning");
      onRunnerUpdate(snap);
    } catch {}
  };

  const addRearRule = () => {
    const usedSlots = new Set(
      activeProfile.rules
        .filter((r) => r.enabled && r.rear_slot !== null && r.rear_slot !== undefined)
        .map((r) => r.rear_slot as number),
    );
    const slot =
      availableRearSlots.find((s) => !usedSlots.has(s)) ??
      availableRearSlots[0] ??
      0;
    const preset = BRIDGE_PRESETS[slot] || BRIDGE_PRESETS[0];
    // Avoid colliding with an already enabled rule using the same trigger
    const conflict = activeProfile.rules.some(
      (r) =>
        r.enabled &&
        r.trigger.length === preset.trigger.length &&
        preset.trigger.every((b) => r.trigger.includes(b)),
    );
    const id = newId("rule");
    const rule: KeymapRule = {
      id,
      name: `背键 ${rearLabel(slot)} 映射`,
      enabled: !conflict,
      rear_slot: slot,
      trigger: [...preset.trigger],
      action: { kind: "hold", keys: ["Space"] },
    };
    setSelectedRuleId(id);
    setShowCustomChord(false);
    updateProfile((p) => ({ ...p, rules: [...p.rules, rule] }));
    if (conflict) {
      onNotice("该背键暗号已有启用规则，新规则已先设为暂停以避免触发冲突。");
    }
  };

  const addStandardRule = () => {
    const candidates: PadButton[] = [
      "LS",
      "RS",
      "LB",
      "RB",
      "Back",
      "Up",
      "Down",
      "Left",
      "Right",
      "A",
      "B",
      "X",
      "Y",
    ];
    const usedSingle = new Set(
      activeProfile.rules
        .filter((r) => r.enabled && r.trigger.length === 1)
        .map((r) => r.trigger[0]),
    );
    const chosen = candidates.find((b) => !usedSingle.has(b)) || "LS";
    const conflict = usedSingle.has(chosen);
    const id = newId("rule");
    const rule: KeymapRule = {
      id,
      name: `${padButtonLabel(chosen)} → 键盘映射`,
      enabled: !conflict,
      rear_slot: null,
      trigger: [chosen],
      action: { kind: "hold", keys: ["F1"] },
    };
    setSelectedRuleId(id);
    setShowCustomChord(false);
    updateProfile((p) => ({ ...p, rules: [...p.rules, rule] }));
  };

  const syncBridgeToDraft = async (rule: KeymapRule) => {
    if (rule.rear_slot === null || rule.rear_slot === undefined) return;
    onError("");
    try {
      const change = await invoke<Change>("keymap_sync_bridge", {
        slot: rule.rear_slot,
        trigger: rule.trigger,
      });
      const label = rearLabel(rule.rear_slot);
      onStageBoardChange(rule.rear_slot, change, label);
      onNotice(
        `已将 ${label} 的触发暗号（${rule.trigger.map(padButtonLabel).join(" + ")}）生成到背键草稿，点击底部“保存到手柄”即可写入。`,
      );
    } catch (e) {
      onError(String(e));
    }
  };

  const syncAllUnsyncedBridges = async () => {
    if (!view || view.support_tier === "read_only") return;
    let count = 0;
    for (const r of activeProfile.rules) {
      if (
        r.enabled &&
        r.rear_slot !== null &&
        r.rear_slot !== undefined &&
        checkRuleBridgeState(r, view, stagedChanges) === "needs_sync"
      ) {
        try {
          const change = await invoke<Change>("keymap_sync_bridge", {
            slot: r.rear_slot,
            trigger: r.trigger,
          });
          onStageBoardChange(r.rear_slot, change, rearLabel(r.rear_slot));
          count += 1;
        } catch (e) {
          onError(String(e));
          return;
        }
      }
    }
    if (count > 0) {
      onNotice(
        `已同步 ${count} 个背键暗号到待保存草稿，请点击底部“保存到手柄 (Ctrl+S)”写入手柄。`,
      );
    }
  };

  const unsyncedCount =
    view && view.support_tier !== "read_only"
      ? activeProfile.rules.filter(
          (r) =>
            r.enabled &&
            checkRuleBridgeState(r, view, stagedChanges) === "needs_sync",
        ).length
      : 0;

  const handleCapturedToken = (tok: OutputToken) => {
    if (!selectedRule || !captureTarget) {
      setCaptureTarget(null);
      return;
    }
    if (captureTarget.mode === "hold" && selectedRule.action.kind === "hold") {
      const cur = selectedRule.action.keys;
      if (!cur.includes(tok) && cur.length < 6) {
        updateRule(selectedRule.id, (r) => ({
          ...r,
          action: { kind: "hold", keys: [...cur, tok] },
        }));
      }
    } else if (
      captureTarget.mode === "step" &&
      selectedRule.action.kind === "macro"
    ) {
      const idx = captureTarget.stepIndex;
      const steps = selectedRule.action.steps.map((s, i) => {
        if (i !== idx) return s;
        if (s.keys.includes(tok) || s.keys.length >= 6) return s;
        const nextKeys = [...s.keys, tok];
        const needsHold = nextKeys.some((k) => !isWheelToken(k));
        return {
          ...s,
          keys: nextKeys,
          hold_ms: needsHold && s.hold_ms === 0 ? 60 : s.hold_ms,
        };
      });
      updateRule(selectedRule.id, (r) =>
        r.action.kind === "macro"
          ? { ...r, action: { ...r.action, steps } }
          : r,
      );
    }
    setCaptureTarget(null);
  };

  return (
    <div className="keymap-page">
      {/* Top Engine Control Bar */}
      <section className="panel keymap-topbar">
        <div className="engine-main">
          {isTauri ? (
            <>
              <button
                type="button"
                className={
                  runner.enabled
                    ? "engine-toggle active"
                    : "engine-toggle primary"
                }
                onClick={toggleEngine}
              >
                <Power size={18} />
                {runner.enabled ? "停止键盘宏引擎" : "开启键盘宏引擎"}
              </button>
              <div className="engine-status">
                <strong>
                  <span
                    className={
                      "dot " +
                      (runner.enabled && !runner.paused_reason
                        ? "online pulse"
                        : runner.paused_reason
                          ? "pending"
                          : "")
                    }
                  />
                  {runnerStateText(runner)}
                </strong>
                <small>
                  全局急停热键：<code>F8</code>
                  （立即停止循环并释放全部键鼠按键）
                </small>
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                className="engine-toggle primary"
                onClick={() => {
                  if (desktopReleaseUrl) {
                    window.open(
                      desktopReleaseUrl,
                      "_blank",
                      "noopener,noreferrer",
                    );
                  } else {
                    setDesktopGuideOpen(true);
                  }
                }}
              >
                <ArrowDownToLine size={18} />
                下载 Windows 桌面版运行宏
              </button>
              <div className="engine-status">
                <strong>
                  <span className="dot online" />
                  网页端支持在线编排方案与蓝牙写入背键暗号
                </strong>
                <small>
                  浏览器沙箱无法向外部游戏发送全局按键；在线编好的方案与已烧录的背键暗号可直接配合免安装桌面版使用{" "}
                  <button
                    type="button"
                    className="inline-link-btn"
                    onClick={() => setDesktopGuideOpen(true)}
                  >
                    查看联动说明
                  </button>
                </small>
              </div>
            </>
          )}
        </div>
        <div className="engine-controls">
          <label className="inline-field">
            <span>手柄槽位</span>
            <select
              aria-label="XInput 手柄槽位选择"
              value={
                store.controller_slot === null ||
                store.controller_slot === undefined
                  ? "auto"
                  : String(store.controller_slot)
              }
              onChange={(e) => {
                const v = e.target.value;
                void persistStore({
                  ...store,
                  controller_slot: v === "auto" ? null : Number(v),
                });
              }}
            >
              <option value="auto">
                自动（当前
                {livePad ? `槽位 ${livePad.slot + 1} 在线` : "未连接"}）
              </option>
              {[0, 1, 2, 3].map((s) => (
                <option key={s} value={s}>
                  固定槽位 {s + 1}
                  {inputs.some((p) => p.slot === s) ? "（在线）" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="mini"
            onClick={() => setShowThresholds((v) => !v)}
          >
            灵敏度阈值
          </button>
        </div>
        {showThresholds && (
          <div className="threshold-bar">
            <label>
              扳机触发阈值（10–240，当前 {store.trigger_threshold}）
              <input
                type="range"
                min="10"
                max="240"
                value={store.trigger_threshold}
                onChange={(e) =>
                  void persistStore({
                    ...store,
                    trigger_threshold: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              摇杆八向触发死区（4000–30000，当前 {store.stick_deadzone}）
              <input
                type="range"
                min="4000"
                max="30000"
                step="500"
                value={store.stick_deadzone}
                onChange={(e) =>
                  void persistStore({
                    ...store,
                    stick_deadzone: Number(e.target.value),
                  })
                }
              />
            </label>
          </div>
        )}
      </section>

      {runner.injection_warning && (
        <div className="message warning-banner" role="alert">
          <ShieldAlert size={18} />
          <span>{runner.injection_warning}</span>
          <button
            type="button"
            className="icon"
            aria-label="关闭注入受阻提示"
            onClick={dismissWarning}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {runner.last_panic && !runner.enabled && (
        <div className="message warning-banner" role="status">
          <AlertTriangle size={18} />
          <span>
            已响应 <strong>F8 紧急停止</strong>，所有模拟按键与循环宏已全部释放。确认安全后可重新开启引擎。
          </span>
          <button
            type="button"
            className="icon"
            aria-label="关闭急停提示"
            onClick={dismissWarning}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Profile Management Bar */}
      <section className="panel profile-bar">
        <div className="profile-select-group">
          <label className="inline-field">
            <span>当前方案</span>
            <select
              aria-label="切换键盘宏方案"
              value={activeProfile.id}
              onChange={(e) =>
                void persistStore({
                  ...store,
                  active_profile_id: e.target.value,
                })
              }
            >
              {store.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{p.rules.length} 条规则）
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="mini"
            onClick={() => setNameDialog({ mode: "create", value: "" })}
          >
            <Plus size={15} /> 新建方案
          </button>
          <button
            type="button"
            className="mini"
            onClick={() =>
              setNameDialog({ mode: "rename", value: activeProfile.name })
            }
          >
            <Pencil size={14} /> 重命名
          </button>
          {store.profiles.length > 1 && (
            <button
              type="button"
              className="mini"
              onClick={() => {
                const remaining = store.profiles.filter(
                  (p) => p.id !== activeProfile.id,
                );
                void persistStore({
                  ...store,
                  active_profile_id: remaining[0].id,
                  profiles: remaining,
                });
              }}
            >
              <Trash2 size={14} /> 删除方案
            </button>
          )}
        </div>
        <div className="profile-io-group">
          <button
            type="button"
            className="mini"
            onClick={async () => {
              onError("");
              try {
                const res = await invoke<{
                  keymap: KeymapStore;
                  runner: RunnerSnapshot;
                  message: string;
                }>("keymap_import");
                onStoreUpdate(res.keymap);
                onRunnerUpdate(res.runner);
                onNotice(res.message);
              } catch (e) {
                if (String(e) !== "已取消导入") onError(String(e));
              }
            }}
          >
            <ArrowDownToLine size={15} /> 导入方案（兼容 0.4.0）
          </button>
          <button
            type="button"
            className="mini"
            onClick={async () => {
              onError("");
              try {
                const res = await invoke<{ message: string }>("keymap_export", {
                  profileId: activeProfile.id,
                });
                onNotice(res.message);
              } catch (e) {
                if (String(e) !== "已取消导出") onError(String(e));
              }
            }}
          >
            <ArrowUpFromLine size={15} /> 导出方案
          </button>
        </div>
      </section>

      {/* Main Two-Column Rule List & Rule Detail Editor */}
      <div className="keymap-layout">
        <section className="panel keymap-rules">
          <div className="section-heading">
            <h2>映射规则</h2>
            <span className="subtle">
              {isTauri ? "自动保存在电脑本地" : "自动保存在浏览器本地"}
            </span>
          </div>
          <div className="quick-bind-bar">
            <button type="button" className="secondary" onClick={addRearRule}>
              <Sparkles size={16} />+ 绑定背键（M1–RK）
            </button>
            <button type="button" onClick={addStandardRule}>
              <Gamepad2 size={16} />+ 绑定普通键 / 组合键
            </button>
          </div>

          {unsyncedCount > 0 && (
            <div className="sync-banner">
              <span>
                检测到 {unsyncedCount} 条背键规则的板载暗号尚未同步到手柄
              </span>
              <button
                type="button"
                className="mini primary"
                onClick={syncAllUnsyncedBridges}
              >
                <RefreshCw size={14} /> 一键同步到背键草稿
              </button>
            </div>
          )}

          {activeProfile.rules.length === 0 ? (
            <div className="empty-small">
              <Keyboard size={42} />
              <h3>当前方案暂无规则</h3>
              <p>
                点击上方“+ 绑定背键（M1–RK）”或“+ 绑定普通键 /
                组合键”，无需连接蓝牙即可通过 USB / 2.4G 使用电脑端键盘宏。
              </p>
            </div>
          ) : (
            <div className="rule-list">
              {activeProfile.rules.map((r) => {
                const syncState = checkRuleBridgeState(r, view, stagedChanges);
                return (
                  <div
                    key={r.id}
                    className={
                      "rule-card " +
                      (selectedRule?.id === r.id ? "selected " : "") +
                      (!r.enabled ? "disabled" : "")
                    }
                    onClick={() => {
                      setSelectedRuleId(r.id);
                      setShowCustomChord(false);
                    }}
                  >
                    <div className="rule-card-top">
                      <strong>{r.name}</strong>
                      <input
                        type="checkbox"
                        className="ios-switch"
                        aria-label={`启用规则 ${r.name}`}
                        checked={r.enabled}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) =>
                          updateRule(r.id, (cur) => ({
                            ...cur,
                            enabled: e.target.checked,
                          }))
                        }
                      />
                    </div>
                    <div className="rule-card-meta">
                      {r.rear_slot !== null && r.rear_slot !== undefined && (
                        <span className="bridge-badge">
                          背键 {rearLabel(r.rear_slot)}
                        </span>
                      )}
                      <span className="trigger-summary">
                        {r.trigger.map(padButtonLabel).join(" + ")}
                      </span>
                      <span>→</span>
                      <span className="output-summary">{describeAction(r)}</span>
                    </div>
                    {r.rear_slot !== null && r.rear_slot !== undefined && (
                      <div className="rule-sync-row">
                        {syncState === "synced_board" && (
                          <span className="sync-tag ok">
                            <Check size={13} /> 板载暗号已就绪
                          </span>
                        )}
                        {syncState === "synced_draft" && (
                          <span className="sync-tag draft">
                            已在草稿中 · 待保存到手柄
                          </span>
                        )}
                        {syncState === "needs_sync" && (
                          <button
                            type="button"
                            className="mini"
                            onClick={(e) => {
                              e.stopPropagation();
                              void syncBridgeToDraft(r);
                            }}
                          >
                            同步暗号到背键草稿
                          </button>
                        )}
                        {syncState === "no_ble" && (
                          <span className="sync-tag muted">
                            未连蓝牙 · 若背键已设暗号可直接用
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Right Column: Rule Detail Editor */}
        <section className="panel keymap-editor">
          {!selectedRule ? (
            <div className="empty-small">
              <MousePointerClick size={42} />
              <h3>选择或创建一条映射规则</h3>
              <p>左侧选择规则后，可在此配置触发组合、物理键盘录入与多步顺序宏。</p>
            </div>
          ) : (
            <>
              <div className="editor-title">
                <div className="rule-title-edit">
                  <p className="eyebrow">编辑电脑端规则</p>
                  <input
                    aria-label="规则名称"
                    value={selectedRule.name}
                    maxLength={60}
                    onChange={(e) =>
                      updateRule(selectedRule.id, (r) => ({
                        ...r,
                        name: e.target.value,
                      }))
                    }
                  />
                </div>
                <button
                  type="button"
                  className="icon"
                  aria-label="删除此规则"
                  title="删除此规则"
                  onClick={() => {
                    updateProfile((p) => ({
                      ...p,
                      rules: p.rules.filter((r) => r.id !== selectedRule.id),
                    }));
                  }}
                >
                  <Trash2 size={18} />
                </button>
              </div>

              {/* Step 1: Trigger Source */}
              <div className="keymap-section">
                <div className="section-label">
                  <span>1. 手柄触发源</span>
                  <span>
                    {livePad ? `槽位 ${livePad.slot + 1} 实时高亮` : "等待手柄输入"}
                  </span>
                </div>
                <div className="segmented">
                  <button
                    type="button"
                    className={
                      selectedRule.rear_slot !== null &&
                      selectedRule.rear_slot !== undefined
                        ? "active"
                        : ""
                    }
                    onClick={() => {
                      const slot = availableRearSlots[0] ?? 0;
                      const preset = BRIDGE_PRESETS[slot] || BRIDGE_PRESETS[0];
                      setShowCustomChord(false);
                      updateRule(selectedRule.id, (r) => ({
                        ...r,
                        rear_slot: slot,
                        trigger: [...preset.trigger],
                      }));
                    }}
                  >
                    实体背键暗号桥接
                  </button>
                  <button
                    type="button"
                    className={
                      selectedRule.rear_slot === null ||
                      selectedRule.rear_slot === undefined
                        ? "active"
                        : ""
                    }
                    onClick={() =>
                      updateRule(selectedRule.id, (r) => ({
                        ...r,
                        rear_slot: null,
                      }))
                    }
                  >
                    普通按键 / 组合键
                  </button>
                </div>

                {selectedRule.rear_slot !== null &&
                selectedRule.rear_slot !== undefined ? (
                  <div className="bridge-config">
                    <div className="rear-slot-pills">
                      {availableRearSlots.map((slot) => (
                        <button
                          key={slot}
                          type="button"
                          className={
                            selectedRule.rear_slot === slot ? "selected" : ""
                          }
                          onClick={() => {
                            const preset =
                              BRIDGE_PRESETS[slot] || BRIDGE_PRESETS[0];
                            updateRule(selectedRule.id, (r) => ({
                              ...r,
                              rear_slot: slot,
                              name: r.name.startsWith("背键 ")
                                ? `背键 ${rearLabel(slot)} 映射`
                                : r.name,
                              trigger: [...preset.trigger],
                            }));
                          }}
                        >
                          {rearLabel(slot)}
                        </button>
                      ))}
                    </div>
                    <div className="bridge-detail">
                      <span>
                        当前板载暗号：
                        <strong>
                          {selectedRule.trigger.map(padButtonLabel).join(" + ")}
                        </strong>
                      </span>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="mini"
                          onClick={() => setShowCustomChord((v) => !v)}
                        >
                          {showCustomChord ? "收起自定义暗号" : "自定义暗号按键"}
                        </button>
                        {view &&
                          view.support_tier !== "read_only" &&
                          checkRuleBridgeState(
                            selectedRule,
                            view,
                            stagedChanges,
                          ) === "needs_sync" && (
                            <button
                              type="button"
                              className="mini primary"
                              onClick={() => void syncBridgeToDraft(selectedRule)}
                            >
                              同步暗号到背键草稿
                            </button>
                          )}
                      </div>
                    </div>
                  </div>
                ) : null}

                {(selectedRule.rear_slot === null ||
                  selectedRule.rear_slot === undefined ||
                  showCustomChord) && (
                  <div className="pad-trigger-grid">
                    {PAD_BUTTONS.filter((b) =>
                      selectedRule.rear_slot !== null &&
                      selectedRule.rear_slot !== undefined
                        ? padButtonToOnboardKey(b.id) !== null
                        : true,
                    ).map((b) => {
                      const chosen = selectedRule.trigger.includes(b.id);
                      const live = isPadButtonActive(
                        livePad,
                        b.id,
                        store.trigger_threshold,
                        store.stick_deadzone,
                      );
                      return (
                        <button
                          key={b.id}
                          type="button"
                          aria-pressed={chosen}
                          className={
                            (chosen ? "selected " : "") +
                            (live ? "live-pressed" : "")
                          }
                          onClick={() => {
                            const has = selectedRule.trigger.includes(b.id);
                            const next = has
                              ? selectedRule.trigger.filter((x) => x !== b.id)
                              : selectedRule.trigger.length < 4
                                ? [...selectedRule.trigger, b.id]
                                : selectedRule.trigger;
                            if (next.length >= 1) {
                              updateRule(selectedRule.id, (r) => ({
                                ...r,
                                trigger: next,
                              }));
                            }
                          }}
                        >
                          {b.label}
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="boundary-note">
                  <Info size={15} />
                  <span>
                    物理边界说明：Windows XInput
                    不会屏蔽手柄原生按键事件（游戏仍会收到所按的手柄键）。背键通过三键冷门暗号触发电脑键鼠，引擎在按住期间独占该组合按钮，叠加正面方向键不会串触发其他背键；使用电脑键盘宏时请保持本软件在后台运行。
                  </span>
                </div>
              </div>

              {/* Step 2: Output Action */}
              <div className="keymap-section">
                <div className="section-label">
                  <span>2. 电脑键鼠动作</span>
                  <span>支持修饰键引用计数</span>
                </div>
                <div className="segmented">
                  <button
                    type="button"
                    className={
                      selectedRule.action.kind === "hold" ? "active" : ""
                    }
                    onClick={() =>
                      updateRule(selectedRule.id, (r) => ({
                        ...r,
                        action: { kind: "hold", keys: ["Space"] },
                      }))
                    }
                  >
                    按住映射
                  </button>
                  <button
                    type="button"
                    className={
                      selectedRule.action.kind === "macro" ? "active" : ""
                    }
                    onClick={() =>
                      updateRule(selectedRule.id, (r) => ({
                        ...r,
                        action: {
                          kind: "macro",
                          steps: [{ keys: ["Q"], hold_ms: 80, gap_ms: 50 }],
                          trigger_mode: "once",
                          loop_ms: 0,
                        },
                      }))
                    }
                  >
                    键盘顺序宏
                  </button>
                </div>

                {selectedRule.action.kind === "hold" ? (
                  <div className="hold-output-editor">
                    <div className="token-chips">
                      {selectedRule.action.keys.map((tok) => (
                        <span key={tok} className="token-chip">
                          {outputLabel(tok)}
                          {selectedRule.action.kind === "hold" &&
                            selectedRule.action.keys.length > 1 && (
                              <button
                                type="button"
                                className="icon small"
                                aria-label={`移除 ${outputLabel(tok)}`}
                                onClick={() =>
                                  updateRule(selectedRule.id, (r) =>
                                    r.action.kind === "hold"
                                      ? {
                                          ...r,
                                          action: {
                                            kind: "hold",
                                            keys: r.action.keys.filter(
                                              (k) => k !== tok,
                                            ),
                                          },
                                        }
                                      : r,
                                  )
                                }
                              >
                                <X size={13} />
                              </button>
                            )}
                        </span>
                      ))}
                    </div>
                    <div className="token-add-bar">
                      <button
                        type="button"
                        className="secondary"
                        disabled={selectedRule.action.keys.length >= 6}
                        onClick={() => setCaptureTarget({ mode: "hold" })}
                      >
                        <Keyboard size={16} /> 点击录入物理按键
                      </button>
                      <select
                        aria-label="选择要添加的输出按键"
                        value={pickAddToken}
                        onChange={(e) => setPickAddToken(e.target.value)}
                      >
                        {OUTPUT_GROUPS.map((g) => (
                          <optgroup key={g.group} label={g.group}>
                            {g.items.map(([val, lbl]) => (
                              <option key={val} value={val}>
                                {lbl}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={
                          selectedRule.action.keys.length >= 6 ||
                          selectedRule.action.keys.includes(pickAddToken)
                        }
                        onClick={() =>
                          updateRule(selectedRule.id, (r) =>
                            r.action.kind === "hold"
                              ? {
                                  ...r,
                                  action: {
                                    kind: "hold",
                                    keys: [...r.action.keys, pickAddToken],
                                  },
                                }
                              : r,
                          )
                        }
                      >
                        <Plus size={15} /> 添加
                      </button>
                    </div>
                    <p className="hint">
                      最多同时组合 6 个键鼠按键（例如 左 Ctrl + 左 Shift +
                      Tab），松开触发键时自动先释放普通键、后释放修饰键。
                    </p>
                  </div>
                ) : (
                  <div className="kb-macro-editor">
                    <div className="kb-step-list">
                      {selectedRule.action.steps.map((step, i) => {
                        const steps =
                          selectedRule.action.kind === "macro"
                            ? selectedRule.action.steps
                            : [];
                        const patchStep = (patch: Partial<KbStep>) =>
                          updateRule(selectedRule.id, (r) =>
                            r.action.kind === "macro"
                              ? {
                                  ...r,
                                  action: {
                                    ...r.action,
                                    steps: r.action.steps.map((s, j) =>
                                      i === j ? { ...s, ...patch } : s,
                                    ),
                                  },
                                }
                              : r,
                          );
                        const pureWaitOrWheel =
                          step.keys.length === 0 ||
                          step.keys.every(isWheelToken);
                        return (
                          <div className="kb-step-row" key={i}>
                            <div className="kb-step-keys">
                              <span className="step-index">#{i + 1}</span>
                              {step.keys.length === 0 ? (
                                <span className="token-chip wait-chip">
                                  纯等待步骤
                                </span>
                              ) : (
                                step.keys.map((tok) => (
                                  <span key={tok} className="token-chip">
                                    {outputLabel(tok)}
                                    {step.keys.length > 1 && (
                                      <button
                                        type="button"
                                        className="icon small"
                                        aria-label={`移除第 ${i + 1} 步按键 ${outputLabel(tok)}`}
                                        onClick={() =>
                                          patchStep({
                                            keys: step.keys.filter(
                                              (k) => k !== tok,
                                            ),
                                          })
                                        }
                                      >
                                        <X size={12} />
                                      </button>
                                    )}
                                  </span>
                                ))
                              )}
                              {step.keys.length < 6 && (
                                <button
                                  type="button"
                                  className="mini"
                                  onClick={() =>
                                    setCaptureTarget({
                                      mode: "step",
                                      stepIndex: i,
                                    })
                                  }
                                >
                                  + 录入按键
                                </button>
                              )}
                            </div>
                            <div className="kb-step-timings">
                              <label>
                                {step.keys.length === 0 ? "等待 ms" : "按住 ms"}
                                <input
                                  type="number"
                                  min={
                                    step.keys.length === 0
                                      ? step.gap_ms > 0
                                        ? 0
                                        : 1
                                      : pureWaitOrWheel
                                        ? 0
                                        : 1
                                  }
                                  max={30000}
                                  value={step.hold_ms}
                                  onChange={(e) =>
                                    patchStep({
                                      hold_ms: Math.max(
                                        pureWaitOrWheel ? 0 : 1,
                                        Math.min(30000, Number(e.target.value)),
                                      ),
                                    })
                                  }
                                />
                              </label>
                              <label>
                                间隔 ms
                                <input
                                  type="number"
                                  min={0}
                                  max={30000}
                                  value={step.gap_ms}
                                  onChange={(e) =>
                                    patchStep({
                                      gap_ms: Math.max(
                                        0,
                                        Math.min(30000, Number(e.target.value)),
                                      ),
                                    })
                                  }
                                />
                              </label>
                              <div className="step-actions">
                                <button
                                  type="button"
                                  className="icon small"
                                  aria-label={`上移第 ${i + 1} 步`}
                                  disabled={i === 0}
                                  onClick={() => {
                                    const next = [...steps];
                                    [next[i - 1], next[i]] = [
                                      next[i],
                                      next[i - 1],
                                    ];
                                    updateRule(selectedRule.id, (r) =>
                                      r.action.kind === "macro"
                                        ? {
                                            ...r,
                                            action: {
                                              ...r.action,
                                              steps: next,
                                            },
                                          }
                                        : r,
                                    );
                                  }}
                                >
                                  <ChevronUp size={15} />
                                </button>
                                <button
                                  type="button"
                                  className="icon small"
                                  aria-label={`下移第 ${i + 1} 步`}
                                  disabled={i === steps.length - 1}
                                  onClick={() => {
                                    const next = [...steps];
                                    [next[i + 1], next[i]] = [
                                      next[i],
                                      next[i + 1],
                                    ];
                                    updateRule(selectedRule.id, (r) =>
                                      r.action.kind === "macro"
                                        ? {
                                            ...r,
                                            action: {
                                              ...r.action,
                                              steps: next,
                                            },
                                          }
                                        : r,
                                    );
                                  }}
                                >
                                  <ChevronDown size={15} />
                                </button>
                                <button
                                  type="button"
                                  className="icon small"
                                  aria-label={`删除第 ${i + 1} 步`}
                                  disabled={steps.length <= 1}
                                  onClick={() =>
                                    updateRule(selectedRule.id, (r) =>
                                      r.action.kind === "macro"
                                        ? {
                                            ...r,
                                            action: {
                                              ...r.action,
                                              steps: r.action.steps.filter(
                                                (_, j) => j !== i,
                                              ),
                                            },
                                          }
                                        : r,
                                    )
                                  }
                                >
                                  <Trash2 size={15} />
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="row-actions">
                      <button
                        type="button"
                        className="text-button"
                        disabled={selectedRule.action.steps.length >= 64}
                        onClick={() =>
                          updateRule(selectedRule.id, (r) =>
                            r.action.kind === "macro"
                              ? {
                                  ...r,
                                  action: {
                                    ...r.action,
                                    steps: [
                                      ...r.action.steps,
                                      { keys: ["E"], hold_ms: 80, gap_ms: 50 },
                                    ],
                                  },
                                }
                              : r,
                          )
                        }
                      >
                        <Plus size={15} /> 添加按键步
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        disabled={selectedRule.action.steps.length >= 64}
                        onClick={() =>
                          updateRule(selectedRule.id, (r) =>
                            r.action.kind === "macro"
                              ? {
                                  ...r,
                                  action: {
                                    ...r.action,
                                    steps: [
                                      ...r.action.steps,
                                      { keys: [], hold_ms: 100, gap_ms: 0 },
                                    ],
                                  },
                                }
                              : r,
                          )
                        }
                      >
                        <Plus size={15} /> 添加纯等待步
                      </button>
                    </div>

                    <div className="two-fields">
                      <label>
                        循环触发模式
                        <select
                          value={selectedRule.action.trigger_mode}
                          onChange={(e) =>
                            updateRule(selectedRule.id, (r) =>
                              r.action.kind === "macro"
                                ? {
                                    ...r,
                                    action: {
                                      ...r.action,
                                      trigger_mode: e.target
                                        .value as KbTriggerMode,
                                    },
                                  }
                                : r,
                            )
                          }
                        >
                          <option value="once">按下执行一次</option>
                          <option value="hold_loop">
                            按住循环（松手立即停止并释放）
                          </option>
                          <option value="toggle_loop">
                            按下切换循环（再次按下停止）
                          </option>
                        </select>
                      </label>
                      <label>
                        每轮循环额外间隔（ms）
                        <input
                          type="number"
                          min={0}
                          max={30000}
                          value={selectedRule.action.loop_ms}
                          onChange={(e) =>
                            updateRule(selectedRule.id, (r) =>
                              r.action.kind === "macro"
                                ? {
                                    ...r,
                                    action: {
                                      ...r.action,
                                      loop_ms: Math.max(
                                        0,
                                        Math.min(30000, Number(e.target.value)),
                                      ),
                                    },
                                  }
                                : r,
                            )
                          }
                        />
                      </label>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {captureTarget && (
        <KeyCaptureModal
          onSelect={handleCapturedToken}
          onClose={() => setCaptureTarget(null)}
        />
      )}

      {nameDialog && (
        <ProfileNameModal
          title={nameDialog.mode === "create" ? "新建键盘宏方案" : "重命名方案"}
          initialValue={nameDialog.value}
          onClose={() => setNameDialog(null)}
          onConfirm={(val) => {
            const trimmed = val.trim();
            if (!trimmed) return;
            if (nameDialog.mode === "create") {
              const id = newId("profile");
              void persistStore({
                ...store,
                active_profile_id: id,
                profiles: [
                  ...store.profiles,
                  { id, name: trimmed, rules: [] },
                ],
              });
            } else {
              updateProfile((p) => ({ ...p, name: trimmed }));
            }
            setNameDialog(null);
          }}
        />
      )}

      {desktopGuideOpen && (
        <DesktopMacroGuideModal
          releaseUrl={desktopReleaseUrl}
          onClose={() => setDesktopGuideOpen(false)}
        />
      )}
    </div>
  );
}

function DesktopMacroGuideModal({
  releaseUrl,
  onClose,
}: {
  releaseUrl: string | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>在电脑游戏中运行键盘宏</h2>
        <button className="icon" aria-label="关闭窗口" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <p>
        出于现代浏览器安全沙箱限制，任何网页都无法在后台向全屏 PC 游戏直接发送全局键盘/鼠标事件（Windows{" "}
        <code>SendInput</code>）。网页驱动与桌面版采用同源无缝协同设计：
      </p>
      <ol className="guide-steps">
        <li>
          <strong>网页端蓝牙烧录暗号</strong>：在本页绑定背键规则后，点击“同步暗号到背键草稿”并按底部“保存到手柄”，即可通过
          Web Bluetooth 将三键暗号写入手柄闪存。
        </li>
        <li>
          <strong>导出在线编好的方案</strong>：点击方案栏“导出方案”保存{" "}
          <code>.json</code> 配置文件。
        </li>
        <li>
          <strong>免安装桌面版后台运行</strong>：下载解压{" "}
          <code>OPlusStudio-Windows-x64.zip</code>，运行{" "}
          <code>OPlusStudio.Native.exe</code> 导入方案并点击“开启键盘宏引擎”，即可通过
          USB / 2.4G 低延迟触发键鼠宏（内置 <code>F8</code> 全局紧急停止）。
        </li>
      </ol>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          知道了
        </button>
        {releaseUrl && (
          <button
            type="button"
            className="primary"
            onClick={() => {
              window.open(releaseUrl, "_blank", "noopener,noreferrer");
              onClose();
            }}
          >
            <ArrowDownToLine size={16} />
            前往 GitHub Releases 下载桌面版
          </button>
        )}
      </div>
    </dialog>
  );
}

function ProfileNameModal({
  title,
  initialValue,
  onClose,
  onConfirm,
}: {
  title: string;
  initialValue: string;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [val, setVal] = useState(initialValue);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button className="icon" aria-label="关闭窗口" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <label>
        方案名称（1–60 字）
        <input
          autoFocus
          value={val}
          maxLength={60}
          placeholder="例如：黑神话悟空 / 桌面快捷键"
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && val.trim()) {
              e.preventDefault();
              onConfirm(val);
            }
          }}
        />
      </label>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="primary"
          disabled={!val.trim()}
          onClick={() => onConfirm(val)}
        >
          确定
        </button>
      </div>
    </dialog>
  );
}
