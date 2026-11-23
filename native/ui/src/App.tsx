import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getCachedWebDeviceSummary,
  invoke,
  isTauriRuntime,
  isWebBluetoothSupported,
  listen,
} from "./backend";
import {
  Gamepad2,
  Keyboard,
  Crosshair,
  SlidersHorizontal,
  Activity,
  FolderArchive,
  ArrowDownToLine,
  ArrowUpFromLine,
  RefreshCw,
  Save,
  Undo2,
  Sun,
  Moon,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Check,
  ArrowRight,
  Bluetooth,
  Settings2,
  X,
  LoaderCircle,
  ScanLine,
  FileSpreadsheet,
  MessageSquarePlus,
  Users,
} from "lucide-react";
import CurvesPage from "./CurvesPage";
import FeedbackModal from "./FeedbackModal";
import InputTesterPage from "./InputTesterPage";
import KeymapPage from "./KeymapPage";
import {
  type PublicStats,
  fetchPublicStats,
  pingBleConnect,
  pingVisit,
} from "./telemetry";
import {
  APP_VERSION,
  type View,
  type Change,
  type Program,
  type Candidate,
  type Input,
  type Journal,
  type KeymapStore,
  type RunnerSnapshot,
  DEFAULT_MACRO_KEYS,
  LABELS_OPLUS_6,
  defaultSlotLabel,
  token,
  name,
  names,
  describe,
} from "./types";

type Row = { keys: string[]; hold: number; gap: number };
type Confirm = {
  title: string;
  body: ReactNode;
  label: string;
  resolve: (v: boolean) => void;
};

const empty: Program = { steps: [], loop_ms: 0, trigger: 0 };

const defaultKeymapStore: KeymapStore = {
  schema: 1,
  active_profile_id: "default",
  controller_slot: null,
  trigger_threshold: 64,
  stick_deadzone: 16000,
  profiles: [{ id: "default", name: "默认方案", rules: [] }],
};

const defaultRunner: RunnerSnapshot = {
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

function Dialog({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
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
        close();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button className="icon" aria-label="关闭对话框" onClick={close}>
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

function parseRows(c: Change, fallbackKey: string): Row[] {
  if (c.kind !== "macro") return [{ keys: [fallbackKey], hold: 100, gap: 60 }];
  return c.sequence
    .split(",")
    .filter(Boolean)
    .map((group) => {
      const [k, t = "100/60"] = group.trim().split(":");
      const [h, g = "60"] = t.split("/");
      return { keys: k.split("+"), hold: Number(h), gap: Number(g) };
    });
}

function buildMacroTokens(macroKeys: number[]): [string, string][] {
  const digital = macroKeys.filter((k) => k !== 18 && k !== 19);
  const out: [string, string][] = digital.map((k) => [token(k), name(k)]);
  for (const [stickCode, prefix] of [
    [18, "LS"],
    [19, "RS"],
  ] as const) {
    if (macroKeys.includes(stickCode)) {
      const dirs = [
        "UP",
        "UP_RIGHT",
        "RIGHT",
        "DOWN_RIGHT",
        "DOWN",
        "DOWN_LEFT",
        "LEFT",
        "UP_LEFT",
      ];
      const arrows = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"];
      dirs.forEach((d, i) => {
        out.push([`${prefix}_${d}`, `${prefix} ${arrows[i]}`]);
      });
    }
  }
  out.push(["WAIT", "等待"]);
  return out;
}

function MacroEditor({
  change,
  macroKeys,
  stepLimit,
  onChange,
}: {
  change: Change;
  macroKeys: number[];
  stepLimit: number;
  onChange: (c: Change) => void;
}) {
  const macroTokens = buildMacroTokens(macroKeys);
  const firstToken = macroTokens[0]?.[0] || "A";
  const rows = parseRows(change, firstToken);
  const loop = change.kind === "macro" ? change.loop_ms : 0;
  const trigger = change.kind === "macro" ? change.trigger : 0;
  const update = (next: Row[], l = loop, t = trigger) =>
    onChange({
      kind: "macro",
      sequence: next
        .map((r) => `${r.keys.join("+")}:${r.hold}/${r.gap}`)
        .join(", "),
      loop_ms: l,
      trigger: t,
    });
  const edit = (i: number, patch: Partial<Row>) =>
    update(rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  return (
    <>
      <div className="section-label">
        <span>执行顺序</span>
        <span>时间单位 ms</span>
      </div>
      <div className="macro-table">
        <div className="macro-head">
          <span>按键 / 组合</span>
          <span>按住</span>
          <span>间隔</span>
          <span />
        </div>
        {rows.map((row, i) => (
          <div className="macro-row" key={i}>
            <div className="macro-keys">
              {row.keys.map((k, j) => (
                <select
                  key={j}
                  aria-label={`第 ${i + 1} 步第 ${j + 1} 个按键`}
                  value={k}
                  onChange={(e) =>
                    edit(i, {
                      keys: row.keys.map((v, n) =>
                        n === j ? e.target.value : v,
                      ),
                    })
                  }
                >
                  {macroTokens.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              ))}
              <div className="row-actions">
                <button
                  className="mini"
                  onClick={() =>
                    edit(i, {
                      keys: [...row.keys, macroTokens[1]?.[0] || firstToken],
                    })
                  }
                >
                  ＋组合
                </button>
                {row.keys.length > 1 && (
                  <button
                    className="mini"
                    onClick={() => edit(i, { keys: row.keys.slice(0, -1) })}
                  >
                    移除末键
                  </button>
                )}
              </div>
            </div>
            <input
              type="number"
              min="5"
              max="10000"
              step="5"
              aria-label={`第 ${i + 1} 步按住时间`}
              value={row.hold}
              onChange={(e) => edit(i, { hold: Number(e.target.value) })}
            />
            <input
              type="number"
              min="0"
              max="10000"
              step="5"
              aria-label={`第 ${i + 1} 步间隔时间`}
              value={row.gap}
              onChange={(e) => edit(i, { gap: Number(e.target.value) })}
            />
            <div className="step-actions">
              <button
                className="icon small"
                aria-label={`上移第 ${i + 1} 步`}
                disabled={!i}
                onClick={() => {
                  const n = [...rows];
                  [n[i - 1], n[i]] = [n[i], n[i - 1]];
                  update(n);
                }}
              >
                <ChevronUp size={16} />
              </button>
              <button
                className="icon small"
                aria-label={`下移第 ${i + 1} 步`}
                disabled={i === rows.length - 1}
                onClick={() => {
                  const n = [...rows];
                  [n[i + 1], n[i]] = [n[i], n[i + 1]];
                  update(n);
                }}
              >
                <ChevronDown size={16} />
              </button>
              <button
                className="icon small"
                aria-label={`删除第 ${i + 1} 步`}
                disabled={rows.length === 1}
                onClick={() => update(rows.filter((_, j) => j !== i))}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <button
        className="text-button"
        onClick={() =>
          update([...rows, { keys: [firstToken], hold: 100, gap: 60 }])
        }
      >
        <Plus size={16} />
        添加一步
      </button>
      <div className="two-fields">
        <label>
          触发方式
          <select
            value={trigger}
            onChange={(e) => update(rows, loop, Number(e.target.value))}
          >
            <option value={0}>按住执行</option>
            <option value={1}>按下切换</option>
          </select>
        </label>
        <label>
          循环间隔（ms）
          <input
            type="number"
            min="0"
            max="20000"
            step="5"
            value={loop}
            onChange={(e) => update(rows, Number(e.target.value))}
          />
        </label>
      </div>
      <p className="hint">
        0 表示不循环。时间精度 5 ms，当前槽位最多 {stepLimit} 条按下 / 松开记录。
      </p>
    </>
  );
}

function Controller({
  selected,
  onSelect,
  labels,
  linkedSlots,
}: {
  selected: number;
  onSelect: (i: number) => void;
  labels: Record<string, string>;
  linkedSlots: Set<number>;
}) {
  return (
    <svg
      className="controller"
      viewBox="0 0 560 238"
      role="img"
      aria-label="手柄背键示意图，位置用于选择槽位"
    >
      <defs>
        <linearGradient id="padBodyGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="var(--pad-grad-top)" />
          <stop offset="55%" stopColor="var(--pad-grad-mid)" />
          <stop offset="100%" stopColor="var(--pad-grad-bot)" />
        </linearGradient>
        <linearGradient id="padRimGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--pad-rim-bright)" />
          <stop offset="50%" stopColor="var(--pad-rim-mid)" />
          <stop offset="100%" stopColor="var(--pad-rim-dim)" />
        </linearGradient>
        <linearGradient id="paddleActiveGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="var(--accent-bright)" />
          <stop offset="100%" stopColor="var(--accent)" />
        </linearGradient>
        <filter id="padDropShadow" x="-12%" y="-12%" width="124%" height="130%">
          <feDropShadow
            dx="0"
            dy="10"
            stdDeviation="10"
            floodColor="#0b192e"
            floodOpacity="0.16"
          />
        </filter>
        <filter id="paddleGlow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow
            dx="0"
            dy="4"
            stdDeviation="6"
            floodColor="var(--accent)"
            floodOpacity="0.42"
          />
        </filter>
      </defs>

      {/* Top Trigger Bumper Shoulders */}
      <path
        className="shell-bumper"
        d="M158 43 Q198 25 242 29 L236 44 Q194 42 162 52 Z M402 43 Q362 25 318 29 L324 44 Q366 42 398 52 Z"
      />

      {/* Sculpted Glass Controller Rear Shell */}
      <path
        className="shell"
        filter="url(#padDropShadow)"
        d="M154 46 Q280 18 406 46 Q454 57 471 108 L493 184 Q501 222 466 218 Q441 215 413 179 L382 145 H178 L147 179 Q119 215 94 218 Q59 222 67 184 L89 108 Q106 57 154 46Z"
      />

      {/* Specular Top Edge Highlight Arc */}
      <path
        className="shell-specular"
        d="M112 72 Q132 50 160 45 Q280 20 400 45 Q428 50 448 72"
      />

      {/* Ergonomic Grip Seam Contours */}
      <path
        className="shell-line"
        d="M181 52 C173 88 167 116 164 146 M379 52 C387 88 393 116 396 146 M198 73 Q280 55 362 73 M232 145 L238 132 H322 L328 145"
      />

      {/* Center Glass Emblem */}
      <rect
        x="252"
        y="79"
        width="56"
        height="28"
        rx="14"
        className="diagram-emblem"
      />
      <text x="280" y="98" textAnchor="middle" className="diagram-brand">
        O+
      </text>

      {/* Six Interactive Rear Paddles */}
      {[
        [176, 90],
        [384, 90],
        [191, 134],
        [369, 134],
        [236, 171],
        [324, 171],
      ].map(([x, y], i) => {
        const isActive = selected === i;
        const isLinked = linkedSlots.has(i);
        return (
          <g
            key={i}
            className={
              "diagram-key" +
              (isActive ? " active" : "") +
              (isLinked ? " linked" : "")
            }
            filter={isActive ? "url(#paddleGlow)" : undefined}
            onClick={() => onSelect(i)}
          >
            <rect x={x - 31} y={y - 16} width="62" height="32" rx="16" />
            <path
              className="paddle-shine"
              d={`M${x - 21} ${y - 14.5} H${x + 21}`}
            />
            <text x={x} y={y + 4.5} textAnchor="middle">
              {labels[i] || LABELS_OPLUS_6[i]}
            </text>
            {isLinked && !isActive && (
              <circle cx={x + 21} cy={y - 8} r="3.2" className="paddle-dot" />
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default function App() {
  const [view, setView] = useState<View | null>(null),
    [changes, setChanges] = useState<Record<string, Change>>({}),
    [settings, setSettings] = useState<any[]>([]),
    [selected, setSelected] = useState(0),
    [page, setPage] = useState("rear"),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState("连接手柄，读取当前板载配置"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [undoable, setUndoable] = useState(false),
    [address, setAddress] = useState(""),
    [devices, setDevices] = useState<Candidate[]>([]),
    [connect, setConnect] = useState(false),
    [confirm, setConfirm] = useState<Confirm | null>(null),
    [input, setInput] = useState<Input[]>([]),
    [recovery, setRecovery] = useState<Journal[]>([]),
    [recoveryPreview, setRecoveryPreview] = useState<any>(null),
    [identifying, setIdentifying] = useState(false),
    [naming, setNaming] = useState(false),
    [labelDraft, setLabelDraft] = useState<Record<string, string>>({}),
    [conflict, setConflict] = useState(false),
    [keymapStore, setKeymapStore] = useState<KeymapStore>(defaultKeymapStore),
    [runnerSnapshot, setRunnerSnapshot] =
      useState<RunnerSnapshot>(defaultRunner),
    [keymapModalOpen, setKeymapModalOpen] = useState(false),
    [feedbackOpen, setFeedbackOpen] = useState(false),
    [publicStats, setPublicStats] = useState<PublicStats | null>(null),
    [previewSlot, setPreviewSlot] = useState<number | null>(null),
    [onlineSlot, setOnlineSlot] = useState<number | null>(null);

  const [theme, setTheme] = useState(localStorage.getItem("theme") || "light"),
    [scale, setScale] = useState(localStorage.getItem("scale") || "100");
  const [preview, setPreview] = useState<Program | null>(null),
    [validation, setValidation] = useState("");

  const isTauri = isTauriRuntime();
  const webBleSupported = isTauri || isWebBluetoothSupported();
  const cachedWebDevice = !isTauri ? getCachedWebDeviceSummary() : null;
  const isReadOnly = view?.support_tier === "read_only";
  const activeSlots = view?.active_slots || [];
  const macroKeys = view?.snapshot.decoded.macro_keys || DEFAULT_MACRO_KEYS;
  const dirty = isReadOnly ? 0 : Object.keys(changes).length + settings.length;
  const current =
    view && !isReadOnly ? changes[selected] || view.forms[selected] : null;
  const anyModalOpen =
    connect ||
    Boolean(confirm) ||
    identifying ||
    naming ||
    Boolean(recoveryPreview) ||
    keymapModalOpen ||
    feedbackOpen;

  const activeKeymapProfile =
    keymapStore.profiles.find((p) => p.id === keymapStore.active_profile_id) ||
    keymapStore.profiles[0];

  const ask = (title: string, body: ReactNode, label = "继续") =>
    new Promise<boolean>((resolve) =>
      setConfirm({ title, body, label, resolve }),
    );

  const call = useCallback(async (request: any) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      return await invoke<any>("run", { request });
    } catch (e) {
      const msg = String(e);
      if (
        msg !== "已取消导入" &&
        msg !== "已取消导出" &&
        msg !== "已取消备份" &&
        msg !== "已取消导出诊断包" &&
        msg !== "已取消设备选择"
      ) {
        setError(msg);
      }
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const install = (v: View) => {
    setView(v);
    setAddress(v.snapshot.address);
    setRecovery(v.recoveries);
    setChanges({});
    setSettings([]);
    setConflict(false);
    setPreview(null);
    if (v.active_slots.length > 0 && !v.active_slots.includes(selected)) {
      setSelected(v.active_slots[0]);
    }
    localStorage.removeItem("draft:" + v.snapshot.address);
    void pingBleConnect(
      isTauri ? "desktop" : "web",
      APP_VERSION,
      `${v.snapshot.identity.vid}:${v.snapshot.identity.pid}:${v.snapshot.address}`,
    ).then((s) => {
      if (s) setPublicStats(s);
    });
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.fontSize = `${Number(scale) * 0.16}px`;
    localStorage.setItem("scale", scale);
  }, [scale]);

  useEffect(() => {
    invoke<any>("initial")
      .then((v) => {
        setAddress(v.address || "");
        setRecovery(v.recoveries || []);
        if (v.keymap) setKeymapStore(v.keymap);
        if (v.runner) setRunnerSnapshot(v.runner);
      })
      .catch(() => {});
    pingVisit(isTauri ? "desktop" : "web", APP_VERSION).then((s) => {
      if (s) setPublicStats(s);
      else void fetchPublicStats().then((f) => f && setPublicStats(f));
    });
    const unlisten = listen<string>("status", (e) => setStatus(e.payload)).catch(
      () => () => {},
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, [isTauri]);

  // Poll macro runner state gently only in Tauri desktop, updating React state only on actual change
  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    let lastJson = "";
    const pollRunner = () => {
      invoke<RunnerSnapshot>("runner_state")
        .then((r) => {
          if (!alive) return;
          const nextJson = JSON.stringify(r);
          if (nextJson !== lastJson) {
            lastJson = nextJson;
            setRunnerSnapshot(r);
          }
        })
        .catch(() => {});
    };
    pollRunner();
    const timer = setInterval(pollRunner, 400);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [isTauri]);

  // Poll inputs into React state ONLY when KeymapPage is open, quantized to threshold crossings so analog stick movement never causes re-render storms
  useEffect(() => {
    if (page !== "keymap") return;
    let alive = true;
    let lastSig = "";
    const trigThresh = keymapStore.trigger_threshold || 64;
    const stickDz = keymapStore.stick_deadzone || 16000;
    const quantize = (list: Input[]) =>
      list
        .map(
          (p) =>
            `${p.slot}:${p.buttons}:${p.left_trigger >= trigThresh ? 1 : 0}:${p.right_trigger >= trigThresh ? 1 : 0}:${Math.abs(p.lx) >= stickDz ? Math.sign(p.lx) : 0}:${Math.abs(p.ly) >= stickDz ? Math.sign(p.ly) : 0}:${Math.abs(p.rx) >= stickDz ? Math.sign(p.rx) : 0}:${Math.abs(p.ry) >= stickDz ? Math.sign(p.ry) : 0}`,
        )
        .join("|");

    const pollKeymapInputs = () => {
      invoke<Input[]>("inputs")
        .then((v) => {
          if (!alive) return;
          const sig = quantize(v);
          if (sig !== lastSig) {
            lastSig = sig;
            setInput(v);
          }
        })
        .catch(() => {});
    };
    pollKeymapInputs();
    const timer = setInterval(pollKeymapInputs, 75);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [page, keymapStore.trigger_threshold, keymapStore.stick_deadzone]);

  // Lightweight online-slot presence check (updates React state ONLY on plug/unplug or slot switch, 0 re-renders during stick movement!)
  useEffect(() => {
    let alive = true;
    const preferred = previewSlot ?? keymapStore.controller_slot ?? null;
    const checkPresence = () => {
      invoke<Input[]>("inputs")
        .then((list) => {
          if (!alive) return;
          const hit =
            (preferred !== null
              ? list.find((p) => p.slot === preferred)
              : undefined) || list[0];
          const next = hit ? hit.slot : null;
          setOnlineSlot((prev) => (prev === next ? prev : next));
        })
        .catch(() => {});
    };
    checkPresence();
    const timer = setInterval(checkPresence, 600);
    window.addEventListener("gamepadconnected", checkPresence);
    window.addEventListener("gamepaddisconnected", checkPresence);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("gamepadconnected", checkPresence);
      window.removeEventListener("gamepaddisconnected", checkPresence);
    };
  }, [previewSlot, keymapStore.controller_slot]);

  useEffect(() => {
    if (!view || view.support_tier === "read_only") return;
    const key = "draft:" + view.snapshot.address;
    if (dirty)
      localStorage.setItem(
        key,
        JSON.stringify({ changes, settings, raw: view.snapshot.raw }),
      );
    else localStorage.removeItem(key);
  }, [changes, settings, view, dirty]);

  useEffect(() => {
    setValidation("");
    setPreview(null);
    if (!view || isReadOnly || !current || busy) return;
    let alive = true;
    const t = setTimeout(
      () =>
        invoke<any>("preview", { slot: selected, change: current })
          .then((v) => {
            if (alive) setPreview(v.program);
          })
          .catch((e) => {
            if (alive) setValidation(String(e));
          }),
      120,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [current, view, isReadOnly, selected, busy]);

  const read = async (
    addr = address,
    pickerOpts?: { forcePicker?: boolean; showAll?: boolean },
  ) => {
    if (
      dirty &&
      !(await ask(
        "重新读取手柄配置？",
        "当前草稿会被清除。可以先导出草稿，留待稍后继续。",
        "重新读取",
      ))
    )
      return;
    const saved = addr ? localStorage.getItem("draft:" + addr) : null;
    const v: View | null = await call({
      action: "read",
      address: addr,
      ...pickerOpts,
    });
    if (v) {
      const effectiveSaved =
        saved || localStorage.getItem("draft:" + v.snapshot.address);
      install(v);
      setConnect(false);
      setStatus(
        v.support_tier === "read_only"
          ? "已进入只读诊断模式"
          : `配置已读取，共 ${v.active_slots.length} 个背键槽位`,
      );
      if (effectiveSaved && v.support_tier !== "read_only") {
        try {
          const d = JSON.parse(effectiveSaved);
          if (
            await ask(
              "继续上次的编辑？",
              "发现这只手柄的本地草稿。恢复后仍需点击保存，才会写入手柄。",
              "恢复草稿",
            )
          ) {
            setChanges(d.changes || {});
            setSettings(d.settings || []);
            const affected = [
              ...Object.keys(d.changes || {}).map((i) => "macro_" + i),
              ...(d.settings || []).map((s: any) =>
                s.feature === "motor_channel"
                  ? "motors"
                  : s.feature === "stick_curve"
                    ? "sticks"
                    : s.feature === "trigger_curve"
                      ? "triggers"
                      : s.feature,
              ),
            ];
            const changed = affected.some(
              (key: string) => d.raw?.[key]?.hex !== v.snapshot.raw[key]?.hex,
            );
            setConflict(changed);
          }
        } catch {}
      }
    }
  };

  const save = async () => {
    if (!view || isReadOnly || !dirty || conflict || validation) return;
    const details = (
      <>
        <p>以下更改将写入手柄，并自动备份、回读核对。</p>
        <ul>
          {Object.entries(changes).map(([i, c]) => (
            <li key={i}>
              {view.labels[i] || defaultSlotLabel(Number(i), activeSlots)}：
              {c.kind === "hold"
                ? "按住 " + c.keys.map(name).join(" + ")
                : c.kind === "macro"
                  ? "顺序宏"
                  : "导入的记录"}
            </li>
          ))}
          {settings.map((s, idx) => (
            <li key={`setting-${idx}`}>{describeStagedSetting(s)}</li>
          ))}
        </ul>
      </>
    );
    if (!(await ask("保存到手柄", details, "保存并核对"))) return;
    const v = await call({ action: "save", changes, settings });
    if (v) {
      install(v);
      setUndoable(true);
      setStatus("保存完成，所有写入已回读核对");
      setNotice("已保存到手柄。现在可以撤销本次保存。");
    }
  };

  const undo = async () => {
    if (
      dirty &&
      !(await ask(
        "撤销上次保存？",
        "撤销成功后，当前草稿会被清除。",
        "撤销保存",
      ))
    )
      return;
    const v = await call({ action: "undo" });
    if (v) {
      install(v);
      setUndoable(false);
      setStatus("已撤销，原始配置回读一致");
      setNotice("已恢复上次保存之前的配置。");
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Suppress global Ctrl+S / Ctrl+R while recording keys or inside any modal dialog!
      if (anyModalOpen) return;
      if (e.ctrlKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (busy) return;
        if (dirty) {
          void save();
        } else if (page === "keymap") {
          setNotice(
            "电脑端键盘宏规则已实时自动保存在本地；底部保存按钮仅用于待写入手柄蓝牙的板载草稿。",
          );
        }
      }
      if (e.ctrlKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        if (!busy && address) void read();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const edit = (c: Change) => {
    setChanges((old) => ({ ...old, [selected]: c }));
  };

  const stageSetting = (s: any) => {
    setSettings((old) => [
      ...old.filter(
        (v) =>
          !(
            v.feature === s.feature &&
            (s.feature === "remapping"
              ? v.source === s.source
              : s.feature === "lighting"
                ? v.zone === s.zone
                : s.feature === "motor_channel"
                  ? v.channel === s.channel
                  : s.feature === "stick_curve" || s.feature === "trigger_curve"
                    ? v.side === s.side
                    : true)
          ),
      ),
      s,
    ]);
  };

  const unstageSetting = (feature: string, side?: number) => {
    setSettings((old) =>
      old.filter(
        (v) =>
          !(
            v.feature === feature &&
            (side === undefined || v.side === side)
          ),
      ),
    );
  };

  const identify = async () => {
    if (!view || isReadOnly || !activeSlots.length) return;
    if (
      !(await ask(
        `识别 ${activeSlots.length} 个实体背键`,
        `会临时设置 ${activeSlots.length} 个数字按键标记。请依次按提示按实体背键并松开；完成、取消或超时后自动恢复原始配置。`,
        "开始识别",
      ))
    )
      return;
    setIdentifying(true);
    const v = await call({ action: "identify" });
    setIdentifying(false);
    if (v) {
      const saved = changes;
      install(v);
      setChanges(saved);
      setStatus(`${activeSlots.length} 个背键已识别，原始配置已恢复`);
    }
  };

  const exported = async () => {
    const v = await call({ action: "export", changes });
    if (v) setNotice(v.message);
  };

  const imported = async () => {
    const v = await call({ action: "import" });
    if (v) {
      setChanges((old) => ({ ...old, ...v.changes }));
      setNotice("已导入为草稿，检查后点击保存到手柄。");
      setPage("rear");
    }
  };

  const exportDiagnostic = async () => {
    const v = await call({ action: "diagnostic" });
    if (v) setNotice(v.message);
  };

  const preferredSlot = previewSlot ?? keymapStore.controller_slot ?? null;
  const program = preview || (view ? view.programs[selected] || empty : empty);
  const isClassicSixSlot =
    activeSlots.length === 6 && activeSlots.every((s, idx) => s === idx);
  const holdKeys = macroKeys.filter((k) => k !== 18 && k !== 19);

  const titles: { [k: string]: [string, string] } = {
    rear: ["背键工作区", "把常用手柄动作或电脑端暗号，放在顺手的背键位置。"],
    keymap: [
      "键盘宏映射",
      "将背键暗号或任意手柄组合键映射为电脑键盘、鼠标与多步顺序宏。",
    ],
    curves: [
      "摇杆与扳机",
      "调节板载左右摇杆内外死区、响应曲线、轴向反转与扳机行程档位。",
    ],
    settings: ["手柄设置", "按设备能力动态调整振动强度、标准按键与 RGB 灯区。"],
    input: [
      "实时输入",
      "满帧率测量左右摇杆圆度与松手漂移、扳机压感峰值、采样回报率与全按键留痕。",
    ],
    tools: ["配置与工具", "管理配置文件、兼容诊断包、背键名称与恢复中心。"],
  };

  const tierBadge = view
    ? view.support_tier === "verified"
      ? ["已实测型号", "tier-verified"]
      : view.support_tier === "compatible"
        ? ["动态兼容", "tier-compatible"]
        : ["只读模式", "tier-readonly"]
    : null;

  const linkedSlotSet = new Set(
    (activeKeymapProfile?.rules || [])
      .filter((r) => r.enabled && r.rear_slot !== null && r.rear_slot !== undefined)
      .map((r) => r.rear_slot as number),
  );

  return (
    <div className="app">
      {/* Luminous Ambient Wallpaper Mesh Behind Liquid Glass Surfaces */}
      <div className="ambient-canvas" aria-hidden="true">
        <span className="orb orb-1" />
        <span className="orb orb-2" />
        <span className="orb orb-3" />
        <span className="orb orb-4" />
      </div>

      <aside className="sidebar">
        <div className="brand">
          <span className="brand-orb" aria-hidden="true">
            O<span>+</span>
          </span>
          <div className="brand-copy">
            <strong>Studio</strong>
            <small>致动全系与键鼠宏</small>
          </div>
        </div>
        <div className="nav-label">工作空间</div>
        <nav>
          {[
            ["rear", "背键工作区", Gamepad2],
            ["keymap", "键盘宏映射", Keyboard],
            ["curves", "摇杆与扳机", Crosshair],
            ["settings", "手柄设置", SlidersHorizontal],
            ["input", "实时输入", Activity],
            ["tools", "配置与工具", FolderArchive],
          ].map(([id, label, Icon]: any) => (
            <button
              key={id}
              className={page === id ? "active" : ""}
              aria-current={page === id ? "page" : undefined}
              onClick={() => setPage(id)}
            >
              <Icon size={18} />
              {label}
              {id === "keymap" && runnerSnapshot.enabled && (
                <span className="nav-live-dot" title="键盘宏引擎运行中" />
              )}
              {id === "tools" && recovery.length > 0 && (
                <span className="count">{recovery.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="scope">
            <span
              className={
                "scope-dot " +
                (page === "keymap" && runnerSnapshot.enabled ? "pulse" : "")
              }
            />
            {page === "keymap" ? (
              <>
                电脑本地映射<small>实时生效 · 需保持后台运行</small>
              </>
            ) : (
              <>
                板载配置<small>保存后脱离软件随手柄使用</small>
              </>
            )}
          </div>
          <button
            className="sidebar-feedback-btn"
            onClick={() => setFeedbackOpen(true)}
          >
            <MessageSquarePlus size={17} /> 问题反馈 · 免登录
          </button>
          <button
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}{" "}
            {theme === "light" ? "深色外观" : "浅色外观"}
          </button>
          <label className="scale-label">
            界面字号
            <select value={scale} onChange={(e) => setScale(e.target.value)}>
              {[100, 115, 130, 150].map((v) => (
                <option key={v} value={v}>
                  {v}%
                </option>
              ))}
            </select>
          </label>
          <small className="version">
            O+ Studio {APP_VERSION} · {isTauri ? "Rust" : "Web Driver"}
            {publicStats && publicStats.total_uv > 0
              ? ` · ${publicStats.total_uv} 人已使用`
              : ""}
          </small>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">
              {page === "keymap"
                ? "O+ / 电脑本地映射 · 需保持后台运行"
                : "O+ / 板载配置"}
            </p>
            <h1>{titles[page][0]}</h1>
          </div>
          <div className="connection">
            <div>
              <strong>
                <span className={"dot " + (view ? "online" : "")} />
                {view
                  ? view.snapshot.decoded.device_name || "致动手柄"
                  : "尚未读取蓝牙配置"}
                {tierBadge && (
                  <span className={`tier-badge ${tierBadge[1]}`}>
                    {tierBadge[0]}
                  </span>
                )}
              </strong>
              <small>
                {view
                  ? `${view.snapshot.identity.vid}:${view.snapshot.identity.pid} · 固件 ${view.snapshot.identity.version_display}`
                  : "USB / 2.4G 可直接使用电脑键盘宏"}
              </small>
            </div>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => (address ? void read() : setConnect(true))}
            >
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Bluetooth size={17} />
              )}
              {view ? "重新读取" : "连接并读取"}
            </button>
            <button
              className="icon"
              disabled={busy}
              aria-label="选择其他设备"
              title="选择其他设备"
              onClick={() => setConnect(true)}
            >
              <Settings2 size={18} />
            </button>
          </div>
        </header>

        <main>
          <div className="page-intro">
            <p>{titles[page][1]}</p>
            <span className="input-state">
              <span className={"dot " + (onlineSlot !== null ? "online" : "")} />
              {onlineSlot !== null
                ? `${isTauri ? "XInput" : "手柄"} 槽位 ${onlineSlot + 1} 在线`
                : isTauri
                  ? "暂无 XInput 输入"
                  : "按手柄任意键唤醒输入"}
            </span>
          </div>

          {!isTauri && !webBleSupported && (
            <div className="message web-ble-banner" role="status">
              <Bluetooth size={18} />
              <span>
                当前浏览器暂不支持 <strong>Web Bluetooth 蓝牙直连</strong>（如
                Firefox / Safari）。请使用桌面版{" "}
                <strong>Microsoft Edge</strong> 或{" "}
                <strong>Google Chrome</strong>{" "}
                开启板载配置读写；当前仍可正常使用实时输入检测与键盘宏方案编辑。
              </span>
            </div>
          )}

          {runnerSnapshot.load_error && (
            <div className="message error" role="alert">
              <strong>键盘宏文件未覆盖</strong>
              <span>{runnerSnapshot.load_error}</span>
              <button
                className="icon"
                aria-label="关闭加载提示"
                onClick={() => {
                  invoke<RunnerSnapshot>("keymap_dismiss_warning")
                    .then((r) => setRunnerSnapshot(r))
                    .catch(() => {});
                }}
              >
                <X size={16} />
              </button>
            </div>
          )}

          {error && (
            <div className="message error" role="alert">
              <strong>操作未完成</strong>
              <span>{error}</span>
              <button className="mini" onClick={() => setFeedbackOpen(true)}>
                免登录上报
              </button>
              <button
                className="icon"
                aria-label="关闭错误"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}

          {notice && (
            <div className="message success" role="status">
              <Check size={18} />
              <span>{notice}</span>
              <button
                className="icon"
                aria-label="关闭提示"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          )}

          {conflict && (
            <div className="message error" role="alert">
              手柄当前配置与草稿来源不同。请导出草稿，重新读取后比较；当前禁止保存。
            </div>
          )}

          {page === "keymap" ? (
            <KeymapPage
              store={keymapStore}
              runner={runnerSnapshot}
              view={view}
              stagedChanges={changes}
              inputs={input}
              onStoreUpdate={setKeymapStore}
              onRunnerUpdate={setRunnerSnapshot}
              onStageBoardChange={(slot, change) =>
                setChanges((old) => ({ ...old, [slot]: change }))
              }
              onError={setError}
              onNotice={setNotice}
              onModalChange={setKeymapModalOpen}
            />
          ) : !view && page !== "input" && page !== "tools" ? (
            <section className="empty">
              <div className="empty-controller">
                <Gamepad2 size={72} strokeWidth={1} />
              </div>
              <p className="eyebrow">UNIVERSAL ZD O+ STUDIO</p>
              <h2>先读懂你的手柄</h2>
              <p>
                开机后退出手机 KeyLinker，通过蓝牙连接读取当前动态能力与板载配置。
                <br />
                若仅使用 USB / 2.4G 接收器，也可直接进入“键盘宏映射”。
              </p>
              <div className="empty-actions">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => (address ? void read() : setConnect(true))}
                >
                  <Bluetooth size={18} />
                  {busy ? "正在读取…" : "蓝牙连接并读取配置"}
                </button>
                <button
                  className="secondary"
                  onClick={() => setPage("keymap")}
                >
                  <Keyboard size={18} />
                  免蓝牙使用电脑键盘宏
                </button>
              </div>
              <button className="text-button" onClick={() => setConnect(true)}>
                查找或切换蓝牙手柄 <ArrowRight size={16} />
              </button>
            </section>
          ) : view &&
            isReadOnly &&
            (page === "rear" || page === "curves" || page === "settings") ? (
            <section className="panel readonly-panel">
              <div className="section-heading">
                <h2>只读兼容诊断模式</h2>
                <span className="pill pending">禁止写入</span>
              </div>
              <p>
                已安全连接设备{" "}
                <strong>
                  {view.snapshot.decoded.device_name || view.snapshot.address}
                </strong>{" "}
                （<code>{view.snapshot.identity.vid}:{view.snapshot.identity.pid}</code>，固件{" "}
                <code>{view.snapshot.identity.version_display}</code>，mode{" "}
                {view.snapshot.identity.mode} / gen{" "}
                {view.snapshot.identity.generation}）。因协议代际或描述符超出已确认的第二代安全约束，板载写入已自动锁定。
              </p>
              {view.snapshot.errors && view.snapshot.errors.length > 0 && (
                <ul className="readonly-reasons">
                  {view.snapshot.errors.map((e, idx) => (
                    <li key={idx}>{e}</li>
                  ))}
                </ul>
              )}
              <div className="row-actions">
                <button
                  className="primary"
                  onClick={() => setFeedbackOpen(true)}
                >
                  <MessageSquarePlus size={18} />
                  免登录一键上传兼容诊断
                </button>
                <button disabled={busy} onClick={exportDiagnostic}>
                  <FileSpreadsheet size={18} />
                  导出设备兼容诊断包
                </button>
                <button onClick={() => setPage("keymap")}>
                  <Keyboard size={18} />
                  前往电脑端键盘宏映射
                </button>
              </div>
            </section>
          ) : page === "rear" && view ? (
            activeSlots.length === 0 ? (
              <section className="panel">
                <h2>此型号未启用板载背键宏槽</h2>
                <p className="hint">
                  设备能力描述符显示宏槽位掩码为 0。你仍可在“手柄设置”中修改支持的配置，或在“键盘宏映射”中绑定普通手柄组合键。
                </p>
              </section>
            ) : (
              <div className="rear-layout">
                <section className="selection">
                  <div className="section-heading">
                    <h2>选择背键</h2>
                    <span className="subtle">
                      {activeSlots.length} 个已启用背键槽
                    </span>
                  </div>
                  {isClassicSixSlot && (
                    <Controller
                      selected={selected}
                      onSelect={setSelected}
                      labels={view.labels}
                      linkedSlots={linkedSlotSet}
                    />
                  )}
                  <div className="rear-grid">
                    {activeSlots.map((slot) => {
                      const c = changes[slot];
                      const linkedKbRule = activeKeymapProfile?.rules.find(
                        (r) => r.enabled && r.rear_slot === slot,
                      );
                      const summary =
                        c?.kind === "hold"
                          ? "按住 " + c.keys.map(name).join(" + ")
                          : c?.kind === "macro"
                            ? "顺序宏 · 草稿"
                            : describe(view.programs[slot], macroKeys);
                      return (
                        <button
                          key={slot}
                          className={
                            "rear-card " + (selected === slot ? "selected" : "")
                          }
                          onClick={() => setSelected(slot)}
                          aria-pressed={selected === slot}
                        >
                          <span className="card-top">
                            <strong>
                              {view.labels[slot] ||
                                defaultSlotLabel(slot, activeSlots)}
                            </strong>
                            {c ? (
                              <span className="draft-tag">草稿</span>
                            ) : linkedKbRule ? (
                              <span className="kb-link-tag">电脑键盘宏</span>
                            ) : (
                              <span className="slot">槽位 {slot + 1}</span>
                            )}
                          </span>
                          <span className="card-summary">{summary}</span>
                          <span className="card-arrow">
                            <ArrowRight size={16} />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="preset-note">
                    <Check size={16} />
                    <span>
                      {view.support_tier === "verified"
                        ? "已验证 O+ 1.37 型号预设"
                        : "致动 / KeyLinker Gen2 默认丝印预设"}
                      <small>
                        {view.support_tier === "verified"
                          ? "同型号手柄可直接复用，无需逐只重新识别。"
                          : "可通过“配置与工具 → 引导识别”核对实体背键对应关系。"}
                      </small>
                    </span>
                    <button
                      className="text-button"
                      onClick={() => setPage("tools")}
                    >
                      调整名称
                    </button>
                  </div>
                </section>

                <section className="editor panel">
                  <div className="editor-title">
                    <div>
                      <p className="eyebrow">编辑背键</p>
                      <h2>
                        {view.labels[selected] ||
                          defaultSlotLabel(selected, activeSlots)}
                      </h2>
                    </div>
                    <span
                      className={"pill " + (changes[selected] ? "pending" : "")}
                    >
                      {changes[selected] ? "未保存草稿" : "当前板载配置"}
                    </span>
                  </div>
                  <fieldset disabled={busy}>
                    <div className="segmented">
                      <button
                        className={current?.kind === "hold" ? "active" : ""}
                        onClick={() =>
                          edit({
                            kind: "hold",
                            keys: [holdKeys[0] || 1],
                          })
                        }
                      >
                        按住映射
                      </button>
                      <button
                        className={current?.kind === "macro" ? "active" : ""}
                        onClick={() =>
                          edit({
                            kind: "macro",
                            sequence: `${token(holdKeys[0] || 1)}:100/60`,
                            loop_ms: 0,
                            trigger: 0,
                          })
                        }
                      >
                        顺序宏
                      </button>
                    </div>
                    {current?.kind === "hold" ? (
                      <>
                        <h3>按住背键时，同时输出</h3>
                        <div className="key-picker">
                          {holdKeys.map((id) => (
                            <button
                              key={id}
                              className={
                                current.keys.includes(id) ? "selected" : ""
                              }
                              aria-pressed={current.keys.includes(id)}
                              onClick={() => {
                                const next = current.keys.includes(id)
                                  ? current.keys.filter((k) => k !== id)
                                  : [...current.keys, id];
                                edit({ kind: "hold", keys: next });
                              }}
                            >
                              {name(id)}
                            </button>
                          ))}
                        </div>
                        <p className="hint">
                          可选择多个按键组成组合键（也可在“键盘宏映射”一键生成电脑端暗号）。
                        </p>
                      </>
                    ) : current?.kind === "macro" ? (
                      <MacroEditor
                        change={current}
                        macroKeys={macroKeys}
                        stepLimit={view.slot_limits[selected] || 42}
                        onChange={edit}
                      />
                    ) : (
                      <div className="raw-info">
                        <h3>完整记录已保留</h3>
                        <p>
                          这项记录不能无损转换为普通表单。可直接保留，或选择映射方式重新编辑。
                        </p>
                      </div>
                    )}
                    <div className="preview">
                      <div className="section-label">
                        <span>输出预览</span>
                        <span>
                          {validation
                            ? "请检查参数"
                            : `${program.steps.length} / ${view.slot_limits[selected] || 42} 条记录`}
                        </span>
                      </div>
                      {validation ? (
                        <p className="field-error" role="alert">
                          {validation}
                        </p>
                      ) : (
                        <div className="timeline">
                          {program.steps.map((s, i) => {
                            const stepNames = names(s.mask, macroKeys);
                            return (
                              <span
                                key={i}
                                className={stepNames.length ? "" : "wait"}
                              >
                                <b>{stepNames.join(" + ") || "松开"}</b>
                                <small>
                                  {s.duration_ms
                                    ? s.duration_ms + " ms"
                                    : "随背键按住"}
                                </small>
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </fieldset>
                  {changes[selected] && (
                    <button
                      className="text-button discard"
                      disabled={busy}
                      onClick={() =>
                        setChanges((old) => {
                          const n = { ...old };
                          delete n[selected];
                          return n;
                        })
                      }
                    >
                      <Undo2 size={15} />
                      放弃这个背键的草稿
                    </button>
                  )}
                  <div className="editor-foot">
                    更改先保存在草稿中。点击下方保存才会写入手柄。
                  </div>
                </section>
              </div>
            )
          ) : page === "curves" && view ? (
            <CurvesPage
              view={view}
              settings={settings}
              selectedSlot={preferredSlot}
              onSelectSlot={setPreviewSlot}
              isTauri={isTauri}
              busy={busy}
              onStage={stageSetting}
              onUnstage={unstageSetting}
              onNotice={setNotice}
            />
          ) : page === "settings" && view ? (
            <Settings
              view={view}
              settings={settings}
              stage={stageSetting}
              busy={busy}
            />
          ) : page === "input" ? (
            <InputTesterPage
              isTauri={isTauri}
              selectedSlot={preferredSlot}
              onSelectSlot={setPreviewSlot}
            />
          ) : (
            <div className="tools-layout">
              <section className="panel community-panel">
                <div className="section-heading">
                  <h2>社区统计与免登录问题反馈</h2>
                  <Users size={21} />
                </div>
                <p>
                  遇到型号连接异常、功能建议或兼容性问题，无需注册 GitHub
                  账号即可直接上传反馈（可自动附带当前手柄兼容诊断快照）。
                </p>
                {publicStats && (
                  <div className="telemetry-grid">
                    <div className="telemetry-card">
                      <span>累计使用玩家</span>
                      <strong>{publicStats.total_uv}</strong>
                    </div>
                    <div className="telemetry-card">
                      <span>今日活跃</span>
                      <strong>{publicStats.today_uv}</strong>
                    </div>
                    <div className="telemetry-card">
                      <span>已连接手柄</span>
                      <strong>{publicStats.ble_connects}</strong>
                    </div>
                    <div className="telemetry-card">
                      <span>已收集反馈</span>
                      <strong>{publicStats.feedback_total}</strong>
                    </div>
                  </div>
                )}
                <div className="tool-actions">
                  <button
                    className="primary"
                    onClick={() => setFeedbackOpen(true)}
                  >
                    <MessageSquarePlus size={18} />
                    免登录提交问题 / 兼容反馈
                  </button>
                </div>
              </section>

              <section className="panel">
                <div className="section-heading">
                  <h2>板载配置与兼容诊断</h2>
                  <FolderArchive size={21} />
                </div>
                <p>
                  支持跨固件版本导入导出背键配置，或导出完整兼容诊断包（只读模式下同样可用）。
                </p>
                <div className="tool-actions">
                  <button
                    disabled={
                      !view || isReadOnly || activeSlots.length === 0 || busy
                    }
                    onClick={imported}
                  >
                    <ArrowDownToLine size={18} />
                    导入背键配置
                  </button>
                  <button
                    disabled={
                      !view || isReadOnly || activeSlots.length === 0 || busy
                    }
                    onClick={exported}
                  >
                    <ArrowUpFromLine size={18} />
                    导出背键配置与草稿
                  </button>
                  <button
                    disabled={!view || busy}
                    onClick={async () => {
                      const v = await call({ action: "backup" });
                      if (v) setNotice(v.message);
                    }}
                  >
                    <FolderArchive size={18} />
                    导出完整原始快照
                  </button>
                  <button disabled={!view || busy} onClick={exportDiagnostic}>
                    <FileSpreadsheet size={18} />
                    导出设备兼容诊断包
                  </button>
                </div>
              </section>

              <section className="panel">
                <div className="section-heading">
                  <h2>背键名称与引导识别</h2>
                  <ScanLine size={21} />
                </div>
                <p>
                  不同设备蓝牙地址会独立记住你的命名修正；引导识别动态支持 1–8
                  个实体背键。
                </p>
                <div className="tool-actions">
                  <button
                    disabled={
                      !view || isReadOnly || activeSlots.length === 0 || busy
                    }
                    onClick={() => {
                      setLabelDraft(view?.labels || {});
                      setNaming(true);
                    }}
                  >
                    手动调整名称
                  </button>
                  <button
                    disabled={
                      !view ||
                      isReadOnly ||
                      activeSlots.length === 0 ||
                      busy ||
                      !!dirty
                    }
                    onClick={identify}
                  >
                    引导识别实体背键
                    {activeSlots.length ? `（${activeSlots.length} 键）` : ""}
                  </button>
                </div>
                {!!dirty && (
                  <p className="hint">引导识别前，请先保存或放弃草稿。</p>
                )}
              </section>

              <section className="panel recovery-panel">
                <div className="section-heading">
                  <h2>恢复中心</h2>
                  <span className="pill">{recovery.length} 项待检查</span>
                </div>
                {recovery.length ? (
                  recovery.map((j) => (
                    <div className="recovery-row" key={j.id}>
                      <div>
                        <strong>
                          未完成的
                          {j.kind === "identification"
                            ? "背键识别"
                            : "配置操作"}
                        </strong>
                        <small>
                          {j.address} · {j.id}
                        </small>
                      </div>
                      <button
                        disabled={busy || !view}
                        onClick={async () => {
                          const v = await call({
                            action: "recovery_preview",
                            id: j.id,
                          });
                          if (v) setRecoveryPreview(v);
                        }}
                      >
                        检查恢复内容
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="safe">
                    <Check size={18} />
                    没有未完成的配置操作。
                  </p>
                )}
                <p className="hint">
                  启动时只检查日志，不会自动写入手柄。存在未知外部修改时停止恢复。
                </p>
              </section>

              {view && (
                <details className="panel">
                  <summary>设备描述符与板载原始记录</summary>
                  <dl>
                    <dt>设备地址</dt>
                    <dd>{view.snapshot.address}</dd>
                    <dt>内部名称</dt>
                    <dd>{view.snapshot.decoded.device_name || "未上报"}</dd>
                    <dt>VID / PID / 固件</dt>
                    <dd>
                      {view.snapshot.identity.vid} /{" "}
                      {view.snapshot.identity.pid} ·{" "}
                      {view.snapshot.identity.version_display}
                    </dd>
                    <dt>支持等级</dt>
                    <dd>{view.support_tier}</dd>
                    <dt>激活背键槽</dt>
                    <dd>
                      {view.active_slots.length
                        ? view.active_slots.join(", ")
                        : "无"}
                    </dd>
                    <dt>宏按键布局</dt>
                    <dd>
                      {view.snapshot.decoded.macro_keys?.join(", ") || "无"}
                    </dd>
                  </dl>
                  <p>
                    能力位掩码与摇杆 / 扳机板载原始字节（可在“摇杆与扳机”工作区可视化调节与保存）：
                  </p>
                  <pre>
                    {JSON.stringify(
                      {
                        capabilities: view.snapshot.capabilities,
                        sticks: view.snapshot.raw.sticks,
                        triggers: view.snapshot.raw.triggers,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              )}
            </div>
          )}
        </main>

        <footer className="savebar">
          <div className="operation-state">
            {busy ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <span
                className={
                  "dot " + (dirty ? "pending" : view ? "online" : "")
                }
              />
            )}
            <div>
              <strong>
                {busy
                  ? status
                  : dirty
                    ? `${Object.keys(changes).length} 个背键草稿${settings.length ? " · " + settings.length + " 项设置" : ""}`
                    : view
                      ? isReadOnly
                        ? "只读诊断模式 · 禁止写入手柄"
                        : "板载配置已读取 · 无待保存更改"
                      : page === "keymap"
                        ? "电脑键盘宏本地实时自动保存"
                        : "等待蓝牙连接"}
              </strong>
              <small>
                {busy
                  ? "请保持手柄开机"
                  : dirty
                    ? "保存前重新读取检查冲突，保存后逐项回读核对"
                    : page === "keymap"
                      ? "此处保存按钮仅用于待写入手柄蓝牙的背键暗号或设置草稿"
                      : "蓝牙通道用于板载读写；USB / 2.4G 游戏输入可继续使用"}
              </small>
            </div>
          </div>
          <div className="save-actions">
            {!!dirty && (
              <button
                disabled={busy}
                onClick={async () => {
                  if (
                    await ask(
                      "放弃全部板载草稿？",
                      "手柄中的配置保持当前已保存状态（不影响电脑本地键盘宏规则）。",
                      "放弃草稿",
                    )
                  ) {
                    setChanges({});
                    setSettings([]);
                    setConflict(false);
                  }
                }}
              >
                放弃草稿
              </button>
            )}
            <button disabled={!undoable || busy || isReadOnly} onClick={undo}>
              <Undo2 size={17} />
              撤销保存
            </button>
            <button
              className="primary"
              disabled={!dirty || busy || !!validation || conflict || isReadOnly}
              onClick={save}
            >
              <Save size={18} />
              保存到手柄<span className="shortcut">Ctrl S</span>
            </button>
          </div>
        </footer>
      </div>

      {connect && (
        <Dialog title="选择手柄" close={() => !busy && setConnect(false)}>
          {isTauri ? (
            <>
              <p>
                开机并退出手机 KeyLinker。支持致动 O+ 全系及 KeyLinker
                兼容设备读取。
              </p>
              <button
                disabled={busy}
                className="secondary"
                onClick={async () => {
                  const v = await call({ action: "scan" });
                  if (v) setDevices(v.devices);
                }}
              >
                <RefreshCw className={busy ? "spin" : ""} size={17} />
                {busy ? "正在查找…" : "查找附近设备"}
              </button>
              {address && (
                <button
                  className="saved-device"
                  disabled={busy}
                  onClick={() => read(address)}
                >
                  <Gamepad2 size={24} />
                  <span>
                    上次使用的手柄<small>{address}</small>
                  </span>
                  <ArrowRight size={18} />
                </button>
              )}
              <div className="device-list">
                {devices.map((d) => (
                  <button
                    disabled={busy}
                    key={d.address}
                    onClick={() => read(d.address)}
                  >
                    <Bluetooth size={19} />
                    <span>
                      {d.name}
                      {d.likely && <b className="device-hint">可能是手柄</b>}
                      <small>
                        {d.address} · {d.rssi ?? "—"} dBm
                      </small>
                    </span>
                    <ArrowRight size={18} />
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <p>
                开机并退出手机 KeyLinker。在浏览器选择器中授权一次后，本页会话内的保存（Ctrl+S）、重读（Ctrl+R）与撤销均可无感直连。
              </p>
              {!webBleSupported && (
                <p className="field-error" role="alert">
                  当前浏览器不支持 Web Bluetooth，请使用桌面版 Microsoft Edge 或
                  Google Chrome 打开本页。
                </p>
              )}
              {(cachedWebDevice || address) && webBleSupported && (
                <button
                  className="saved-device"
                  disabled={busy}
                  onClick={() =>
                    void read(cachedWebDevice?.address || address, {
                      forcePicker: false,
                    })
                  }
                >
                  <Gamepad2 size={24} />
                  <span>
                    {cachedWebDevice
                      ? `快速重连：${cachedWebDevice.name}`
                      : "重连上次使用的手柄"}
                    <small>{cachedWebDevice?.address || address}</small>
                  </span>
                  <ArrowRight size={18} />
                </button>
              )}
              <div className="web-picker-actions">
                <button
                  className="web-picker-card recommended"
                  disabled={busy || !webBleSupported}
                  onClick={() =>
                    void read("", { forcePicker: true, showAll: false })
                  }
                >
                  <Bluetooth size={20} />
                  <span>
                    选择致动 / KeyLinker 手柄（推荐）
                    <small>
                      自动筛选“致动 / O+ / ZD / KeyLinker”广播名称与配置服务
                    </small>
                  </span>
                  <ArrowRight size={18} />
                </button>
                <button
                  className="web-picker-card"
                  disabled={busy || !webBleSupported}
                  onClick={() =>
                    void read("", { forcePicker: true, showAll: true })
                  }
                >
                  <RefreshCw className={busy ? "spin" : ""} size={19} />
                  <span>
                    显示附近全部蓝牙设备
                    <small>
                      适用于自定义过广播名称的手柄，连接后自动校验协议代际
                    </small>
                  </span>
                  <ArrowRight size={18} />
                </button>
              </div>
            </>
          )}
          {error && <p className="field-error">{error}</p>}
        </Dialog>
      )}

      {confirm && (
        <Dialog
          title={confirm.title}
          close={() => {
            confirm.resolve(false);
            setConfirm(null);
          }}
        >
          <div className="confirm-body">{confirm.body}</div>
          <div className="dialog-actions">
            <button
              onClick={() => {
                confirm.resolve(false);
                setConfirm(null);
              }}
            >
              取消
            </button>
            <button
              className="primary"
              autoFocus
              onClick={() => {
                confirm.resolve(true);
                setConfirm(null);
              }}
            >
              {confirm.label}
            </button>
          </div>
        </Dialog>
      )}

      {identifying && (
        <Dialog
          title={`识别 ${activeSlots.length} 个背键`}
          close={() => void invoke("cancel")}
        >
          <div className="identify-status">
            <LoaderCircle className="spin" size={32} />
            <h3>{status}</h3>
          </div>
          <p>
            只按提示的背键并松开，避免同时操作正面按键。结束时会恢复原配置。
          </p>
          <button onClick={() => void invoke("cancel")}>
            取消识别并恢复配置
          </button>
        </Dialog>
      )}

      {naming && view && (
        <Dialog title="调整背键名称" close={() => setNaming(false)}>
          <div className="label-fields">
            {activeSlots.map((slot) => (
              <label key={slot}>
                槽位 {slot + 1}（默认 {defaultSlotLabel(slot, activeSlots)}）
                <input
                  value={labelDraft[slot] || ""}
                  maxLength={20}
                  onChange={(e) =>
                    setLabelDraft((old) => ({
                      ...old,
                      [slot]: e.target.value,
                    }))
                  }
                />
              </label>
            ))}
          </div>
          <div className="dialog-actions">
            <button
              onClick={() =>
                setLabelDraft(
                  Object.fromEntries(
                    activeSlots.map((slot) => [
                      slot,
                      defaultSlotLabel(slot, activeSlots),
                    ]),
                  ),
                )
              }
            >
              恢复默认名称
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                const v = await call({ action: "labels", labels: labelDraft });
                if (v) {
                  setView(v);
                  setNaming(false);
                  setNotice("背键名称已保存。");
                }
              }}
            >
              保存名称
            </button>
          </div>
          {error && <p className="field-error">{error}</p>}
        </Dialog>
      )}

      {recoveryPreview && (
        <Dialog title="检查恢复内容" close={() => setRecoveryPreview(null)}>
          <p>
            将恢复 {recoveryPreview.edits.length}{" "}
            项记录到操作前的值。已经恢复的记录会跳过。
          </p>
          <ul>
            {recoveryPreview.edits.map((e: any) => (
              <li key={e.key}>{e.key}</li>
            ))}
          </ul>
          <p className="hint">
            执行前会再次读取和比较。如果记录已被其他软件修改，会停止。
          </p>
          <div className="dialog-actions">
            <button onClick={() => setRecoveryPreview(null)}>取消</button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                const v = await call({
                  action: "recover",
                  id: recoveryPreview.recovery.id,
                });
                if (v) {
                  install(v);
                  setRecoveryPreview(null);
                  setNotice("恢复完成，已回读核对。");
                }
              }}
            >
              执行恢复并核对
            </button>
          </div>
          {error && <p className="field-error">{error}</p>}
        </Dialog>
      )}

      {feedbackOpen && (
        <FeedbackModal
          close={() => setFeedbackOpen(false)}
          isTauri={isTauri}
          view={view}
          lastError={error}
          address={address}
          onStatsUpdate={setPublicStats}
        />
      )}
    </div>
  );
}

const MOTOR_LABELS = ["左握把", "右握把", "左扳机", "右扳机"];

function describeStagedSetting(s: any): string {
  if (s.feature === "stick_curve") {
    return `${s.side === 0 ? "左摇杆" : "右摇杆"}曲线与死区`;
  }
  if (s.feature === "trigger_curve") {
    return `${s.side === 0 ? "左扳机" : "右扳机"}曲线与死区`;
  }
  if (s.feature === "motor_channel") {
    return `振动强度（${MOTOR_LABELS[s.channel] || `通道 ${s.channel + 1}`}：${s.level}%）`;
  }
  if (s.feature === "motors") {
    return "振动强度（四通道）";
  }
  if (s.feature === "remapping") {
    return `标准按键映射（${name(s.source)} → ${name(s.target || s.source)}）`;
  }
  if (s.feature === "lighting") {
    return `灯光颜色（区域 ${Number(s.zone) + 1}：${String(s.rgb).toUpperCase()}）`;
  }
  return "板载设置更改";
}

function Settings({
  view,
  settings,
  stage,
  busy,
}: {
  view: View;
  settings: any[];
  stage: (v: any) => void;
  busy: boolean;
}) {
  const raw = view.snapshot.raw;
  const caps = view.capabilities_info;

  const motorChannels =
    caps && raw.motors ? caps.motor_channels : [];
  const motorBytes = raw.motors
    ? raw.motors.hex.split(" ").map((v) => parseInt(v, 16))
    : [];

  const remapSources =
    caps && caps.changekey !== 0 && raw.remapping
      ? view.snapshot.decoded.remap_keys || []
      : [];
  const remapTargets =
    caps?.has_remap_select_list && view.snapshot.decoded.remap_targets?.length
      ? view.snapshot.decoded.remap_targets
      : remapSources;
  const remapBytes = raw.remapping
    ? raw.remapping.hex.split(" ").map((v) => parseInt(v, 16))
    : [];

  const lightingBytes = raw.lighting
    ? raw.lighting.hex.split(" ")
    : [];
  const maxDeclaredZones = Math.floor(lightingBytes.length / 6);
  const lightingZones = (caps?.lighting_zones || []).filter(
    (z) => z < maxDeclaredZones,
  );

  return (
    <fieldset className="settings-layout" disabled={busy}>
      <section className="panel">
        <div className="section-heading">
          <h2>振动强度</h2>
          <span className="pill">
            {motorChannels.length
              ? `${motorChannels.length} 个通道`
              : "未启用"}
          </span>
        </div>
        {motorChannels.length === 0 ? (
          <p>当前设备未公开可调节振动通道。</p>
        ) : (
          <>
            <p>仅修改实际拖动的通道，其余通道与自动关机字节严格原样保留。</p>
            {motorChannels.map((ch) => {
              const basePct = Math.round(((motorBytes[ch] ?? 0) * 100) / 255);
              const staged = settings.find(
                (v) => v.feature === "motor_channel" && v.channel === ch,
              );
              const val = staged ? staged.level : basePct;
              return (
                <label className="range-row" key={ch}>
                  <span>{MOTOR_LABELS[ch] || `通道 ${ch + 1}`}</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={val}
                    onChange={(e) =>
                      stage({
                        feature: "motor_channel",
                        channel: ch,
                        level: Number(e.target.value),
                      })
                    }
                  />
                  <output>{val}%</output>
                </label>
              );
            })}
          </>
        )}
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>标准按键映射</h2>
          <span className="pill">{remapSources.length ? "板载" : "未启用"}</span>
        </div>
        {remapSources.length === 0 ? (
          <p>当前设备不支持标准按键重映射。</p>
        ) : (
          <>
            <p>
              更改正面按键输出；相同按键表示默认行为。注：Back 与 Start
              在固件中不生效为改键源（仅可作为其他键的目标）。
            </p>
            <div className="remap-grid">
              {remapSources.map((source, i) => {
                const boardVal = remapBytes[i] || 0;
                const staged = settings.find(
                  (v) => v.feature === "remapping" && v.source === source,
                );
                const target =
                  staged !== undefined
                    ? staged.target
                    : boardVal || source;
                const isTargetOnlySource = source === 93 || source === 94;
                const selectOptions = remapTargets.includes(source)
                  ? remapTargets
                  : [source, ...remapTargets];
                return (
                  <label key={source}>
                    <span>{name(source)}</span>
                    <ArrowRight size={14} />
                    <select
                      aria-label={`${name(source)} 输出`}
                      value={target}
                      disabled={isTargetOnlySource && boardVal === 0}
                      title={
                        isTargetOnlySource
                          ? "固件会忽略 Back/Start 作为改键来源，仅允许作为目标或恢复默认"
                          : undefined
                      }
                      onChange={(e) =>
                        stage({
                          feature: "remapping",
                          source,
                          target: Number(e.target.value),
                        })
                      }
                    >
                      {(isTargetOnlySource
                        ? boardVal !== 0 && boardVal !== source
                          ? [source, boardVal]
                          : [source]
                        : selectOptions
                      ).map((t) => (
                        <option key={t} value={t}>
                          {name(t)}
                          {isTargetOnlySource && t === source ? "（锁定）" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          </>
        )}
      </section>

      <section className="panel lighting">
        <div className="section-heading">
          <h2>灯光颜色</h2>
          <span className="pill">
            {lightingZones.length ? `${lightingZones.length} 个灯区` : "未启用"}
          </span>
        </div>
        {lightingZones.length === 0 ? (
          <p>当前设备未通过协议开放可调 RGB 灯区。</p>
        ) : (
          <>
            <p>仅修改设备声明支持灯区的 RGB 字节，其余灯效字节原样保留。</p>
            {lightingZones.map((zone) => {
              const bytes = lightingBytes.slice(zone * 6, zone * 6 + 3);
              const rgb =
                settings.find(
                  (v) => v.feature === "lighting" && v.zone === zone,
                )?.rgb || "#" + bytes.join("");
              return (
                <label className="color-row" key={zone}>
                  <span>区域 {zone + 1}</span>
                  <input
                    type="color"
                    value={rgb}
                    onChange={(e) =>
                      stage({ feature: "lighting", zone, rgb: e.target.value })
                    }
                  />
                  <code>{rgb.toUpperCase()}</code>
                </label>
              );
            })}
          </>
        )}
      </section>
    </fieldset>
  );
}
