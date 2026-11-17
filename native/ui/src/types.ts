export type Change =
  | { kind: "hold"; keys: number[] }
  | { kind: "macro"; sequence: string; loop_ms: number; trigger: number }
  | { kind: "record"; payload: string };

export type RecordData = {
  declared: number;
  hex: string;
  text?: string | null;
};

export type SupportTier = "verified" | "compatible" | "read_only";

export type CapabilitiesInfo = {
  sticks: number;
  stick_sides: number[];
  triggers: number;
  trigger_sides: number[];
  motors: number;
  motor_channels: number[];
  macros: number;
  active_slots: number[];
  changekey: number;
  has_remap_select_list: boolean;
  lighting: number;
  lighting_zones: number[];
  has_per_slot_macro_limits: boolean;
};

export type StickCurveSetting = {
  feature: "stick_curve";
  side: number;
  inner: number;
  outer_raw: number;
  point1: [number, number];
  point2: [number, number];
  invert_x: boolean;
  invert_y: boolean;
  swap: boolean;
};

export type TriggerCurveSetting = {
  feature: "trigger_curve";
  side: number;
  inner: number;
  outer_raw: number;
  point1: [number, number];
  point2: [number, number];
};

export type BoardSetting =
  | StickCurveSetting
  | TriggerCurveSetting
  | { feature: "motors"; levels: [number, number, number, number] }
  | { feature: "motor_channel"; channel: number; level: number }
  | { feature: "remapping"; source: number; target: number }
  | { feature: "lighting"; zone: number; rgb: string };

export type Snapshot = {
  address: string;
  identity: {
    vid: string;
    pid: string;
    version_display: string;
    mode: number;
    generation: number;
    sensor?: number;
  };
  raw: Record<string, RecordData | undefined>;
  decoded: {
    device_name?: string;
    all_keys?: number[];
    macro_keys?: number[];
    remap_keys?: number[];
    remap_targets?: number[];
    macro_limits?: number[];
  };
  capabilities: RecordData;
  errors?: string[];
};

export type Step = { mask: number; duration_ms: number };
export type Program = { steps: Step[]; loop_ms: number; trigger: number };

export type Journal = {
  id: string;
  kind: string;
  state: string;
  address: string;
  records: {
    key: string;
    original: number[];
    target: number[];
    attempted: boolean;
    state: string;
  }[];
};

export type View = {
  snapshot: Snapshot;
  support_tier: SupportTier;
  capabilities_info: CapabilitiesInfo | null;
  active_slots: number[];
  slot_limits: Record<string, number>;
  forms: Record<string, Change>;
  programs: Record<string, Program>;
  labels: Record<string, string>;
  recoveries: Journal[];
};

export type Candidate = {
  name: string;
  address: string;
  rssi: number | null;
  likely: boolean;
  confirmed_service?: boolean;
};

export type Input = {
  slot: number;
  buttons: number;
  left_trigger: number;
  right_trigger: number;
  lx: number;
  ly: number;
  rx: number;
  ry: number;
};

export const DEFAULT_MACRO_KEYS = [
  18, 19, 13, 14, 15, 16, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 93, 94,
];

export const LABELS_OPLUS_6 = ["M1", "M2", "LM", "RM", "LK", "RK"];
export const SLOT_ORDER_8 = ["M1", "M2", "M3", "M4", "M5", "M6", "ML", "MR"];

export function defaultSlotLabel(slot: number, activeSlots?: number[]) {
  if (
    !activeSlots ||
    (activeSlots.length === 6 &&
      activeSlots.every((v, idx) => v === idx))
  ) {
    return LABELS_OPLUS_6[slot] || SLOT_ORDER_8[slot] || `槽 ${slot + 1}`;
  }
  return SLOT_ORDER_8[slot] || `槽 ${slot + 1}`;
}

export const KEYS: [number, string][] = [
  [1, "A"],
  [2, "B"],
  [3, "X"],
  [4, "Y"],
  [5, "LB"],
  [6, "RB"],
  [7, "LT"],
  [8, "RT"],
  [11, "L3"],
  [12, "R3"],
  [13, "↓"],
  [14, "↑"],
  [15, "→"],
  [16, "←"],
  [17, "Home"],
  [93, "Back"],
  [94, "Start"],
  [95, "Capture"],
  [96, "Turbo"],
  [97, "M_Left"],
  [104, "M2"],
];

export const token = (id: number): string =>
  (
    ({
      9: "SELECT_LEGACY",
      10: "START_LEGACY",
      13: "DPAD_DOWN",
      14: "DPAD_UP",
      15: "DPAD_RIGHT",
      16: "DPAD_LEFT",
      17: "HOME",
      93: "SELECT",
      94: "START",
      95: "CAPTURE",
      96: "TURBO",
      97: "M_LEFT",
      104: "M2",
    }) as Record<number, string>
  )[id] ||
  KEYS.find((k) => k[0] === id)?.[1] ||
  `KEY_${id}`;

export const name = (id: number): string =>
  KEYS.find((k) => k[0] === id)?.[1] || `KEY_${id}`;

export function names(
  mask: number,
  macroKeys: number[] = DEFAULT_MACRO_KEYS,
): string[] {
  const keys = macroKeys.length ? macroKeys : DEFAULT_MACRO_KEYS;
  const digital: [number, number][] = [];
  const analog: [number, number][] = [];
  let pos = 0;
  for (const k of keys) {
    if (k === 18 || k === 19) {
      if (pos <= 20) analog.push([k, pos]);
      pos += 4;
    } else {
      if (pos < 24) digital.push([k, pos]);
      pos += 1;
    }
  }
  const list: string[] = [];
  for (const [k, bit] of digital) {
    if ((mask & (1 << bit)) !== 0) {
      list.push(name(k));
    }
  }
  analog.sort((a, b) => a[0] - b[0]);
  for (const [stick, shift] of analog) {
    const nib = (mask >>> shift) & 15;
    if (nib < 8) {
      list.push(
        (stick === 18 ? "LS " : "RS ") +
          ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"][nib],
      );
    }
  }
  return list;
}

export function describe(
  p: Program | undefined,
  macroKeys?: number[],
): string {
  if (!p || !p.steps.length) return "未配置";
  if (p.steps.length === 1 && !p.steps[0].duration_ms && !p.loop_ms) {
    return "按住 " + names(p.steps[0].mask, macroKeys).join(" + ");
  }
  return p.steps
    .filter((s) => names(s.mask, macroKeys).length > 0)
    .map(
      (s) =>
        names(s.mask, macroKeys).join("+") + " · " + s.duration_ms + " ms",
    )
    .join(" → ");
}

// === Native Desktop Keymap & Macro Types ===

export type PadButton =
  | "A"
  | "B"
  | "X"
  | "Y"
  | "LB"
  | "RB"
  | "Back"
  | "Start"
  | "LS"
  | "RS"
  | "Up"
  | "Down"
  | "Left"
  | "Right"
  | "LT"
  | "RT"
  | "LXNeg"
  | "LXPos"
  | "LYNeg"
  | "LYPos"
  | "RXNeg"
  | "RXPos"
  | "RYNeg"
  | "RYPos";

export const PAD_BUTTONS: {
  id: PadButton;
  label: string;
  group: "face" | "dpad" | "stick";
}[] = [
  { id: "A", label: "A", group: "face" },
  { id: "B", label: "B", group: "face" },
  { id: "X", label: "X", group: "face" },
  { id: "Y", label: "Y", group: "face" },
  { id: "LB", label: "LB", group: "face" },
  { id: "RB", label: "RB", group: "face" },
  { id: "LT", label: "LT", group: "face" },
  { id: "RT", label: "RT", group: "face" },
  { id: "LS", label: "LS (L3)", group: "face" },
  { id: "RS", label: "RS (R3)", group: "face" },
  { id: "Back", label: "Back", group: "face" },
  { id: "Start", label: "Start", group: "face" },
  { id: "Up", label: "十字 ↑", group: "dpad" },
  { id: "Down", label: "十字 ↓", group: "dpad" },
  { id: "Left", label: "十字 ←", group: "dpad" },
  { id: "Right", label: "十字 →", group: "dpad" },
  { id: "LXNeg", label: "左摇杆 ←", group: "stick" },
  { id: "LXPos", label: "左摇杆 →", group: "stick" },
  { id: "LYPos", label: "左摇杆 ↑", group: "stick" },
  { id: "LYNeg", label: "左摇杆 ↓", group: "stick" },
  { id: "RXNeg", label: "右摇杆 ←", group: "stick" },
  { id: "RXPos", label: "右摇杆 →", group: "stick" },
  { id: "RYPos", label: "右摇杆 ↑", group: "stick" },
  { id: "RYNeg", label: "右摇杆 ↓", group: "stick" },
];

export function padButtonLabel(b: PadButton): string {
  return PAD_BUTTONS.find((x) => x.id === b)?.label || b;
}

export function padButtonToOnboardKey(b: PadButton): number | null {
  const map: Partial<Record<PadButton, number>> = {
    A: 1,
    B: 2,
    X: 3,
    Y: 4,
    LB: 5,
    RB: 6,
    LT: 7,
    RT: 8,
    LS: 11,
    RS: 12,
    Down: 13,
    Up: 14,
    Right: 15,
    Left: 16,
    Back: 93,
    Start: 94,
  };
  return map[b] ?? null;
}

export function isPadButtonActive(
  pad: Input | undefined,
  btn: PadButton,
  trigThresh = 64,
  deadzone = 16000,
): boolean {
  if (!pad) return false;
  switch (btn) {
    case "A":
      return (pad.buttons & 0x1000) !== 0;
    case "B":
      return (pad.buttons & 0x2000) !== 0;
    case "X":
      return (pad.buttons & 0x4000) !== 0;
    case "Y":
      return (pad.buttons & 0x8000) !== 0;
    case "LB":
      return (pad.buttons & 0x0100) !== 0;
    case "RB":
      return (pad.buttons & 0x0200) !== 0;
    case "Back":
      return (pad.buttons & 0x0020) !== 0;
    case "Start":
      return (pad.buttons & 0x0010) !== 0;
    case "LS":
      return (pad.buttons & 0x0040) !== 0;
    case "RS":
      return (pad.buttons & 0x0080) !== 0;
    case "Up":
      return (pad.buttons & 0x0001) !== 0;
    case "Down":
      return (pad.buttons & 0x0002) !== 0;
    case "Left":
      return (pad.buttons & 0x0004) !== 0;
    case "Right":
      return (pad.buttons & 0x0008) !== 0;
    case "LT":
      return pad.left_trigger > trigThresh;
    case "RT":
      return pad.right_trigger > trigThresh;
    case "LXNeg":
      return pad.lx < -deadzone;
    case "LXPos":
      return pad.lx > deadzone;
    case "LYNeg":
      return pad.ly < -deadzone;
    case "LYPos":
      return pad.ly > deadzone;
    case "RXNeg":
      return pad.rx < -deadzone;
    case "RXPos":
      return pad.rx > deadzone;
    case "RYNeg":
      return pad.ry < -deadzone;
    case "RYPos":
      return pad.ry > deadzone;
  }
}

export const BRIDGE_PRESETS: Record<
  number,
  { trigger: PadButton[]; onboardKeys: number[] }
> = {
  0: { trigger: ["Back", "LS", "RS"], onboardKeys: [93, 11, 12] },
  1: { trigger: ["Back", "LS", "Up"], onboardKeys: [93, 11, 14] },
  2: { trigger: ["Back", "LS", "Down"], onboardKeys: [93, 11, 13] },
  3: { trigger: ["Back", "LS", "Left"], onboardKeys: [93, 11, 16] },
  4: { trigger: ["Back", "LS", "Right"], onboardKeys: [93, 11, 15] },
  5: { trigger: ["Back", "RS", "Up"], onboardKeys: [93, 12, 14] },
  6: { trigger: ["Back", "RS", "Down"], onboardKeys: [93, 12, 13] },
  7: { trigger: ["Back", "RS", "Left"], onboardKeys: [93, 12, 16] },
};

export type OutputToken = string;

export const OUTPUT_GROUPS: { group: string; items: [string, string][] }[] = [
  {
    group: "修饰键",
    items: [
      ["LCtrl", "左 Ctrl"],
      ["RCtrl", "右 Ctrl"],
      ["LShift", "左 Shift"],
      ["RShift", "右 Shift"],
      ["LAlt", "左 Alt"],
      ["RAlt", "右 Alt"],
      ["LWin", "左 Win"],
      ["RWin", "右 Win"],
    ],
  },
  {
    group: "常用编辑与方向键",
    items: [
      ["Space", "空格 (Space)"],
      ["Enter", "回车 (Enter)"],
      ["Escape", "Esc"],
      ["Tab", "Tab"],
      ["Backspace", "退格 (Backspace)"],
      ["CapsLock", "CapsLock"],
      ["Up", "方向 ↑"],
      ["Down", "方向 ↓"],
      ["Left", "方向 ←"],
      ["Right", "方向 →"],
      ["Insert", "Insert"],
      ["Delete", "Delete"],
      ["Home", "Home"],
      ["End", "End"],
      ["PageUp", "PageUp"],
      ["PageDown", "PageDown"],
    ],
  },
  {
    group: "鼠标按键与滚轮",
    items: [
      ["MouseLeft", "鼠标左键"],
      ["MouseRight", "鼠标右键"],
      ["MouseMiddle", "鼠标中键"],
      ["MouseX1", "鼠标侧键 X1 (后退)"],
      ["MouseX2", "鼠标侧键 X2 (前进)"],
      ["WheelUp", "滚轮向上 (脉冲)"],
      ["WheelDown", "滚轮向下 (脉冲)"],
    ],
  },
  {
    group: "字母键 A–Z",
    items: Array.from({ length: 26 }, (_, i) => {
      const ch = String.fromCharCode(65 + i);
      return [ch, ch] as [string, string];
    }),
  },
  {
    group: "主键盘数字 0–9",
    items: Array.from({ length: 10 }, (_, i) => [
      `Key${i}`,
      `数字 ${i}`,
    ]),
  },
  {
    group: "功能键 F1–F12（F8 为保留急停键）",
    items: [
      ["F1", "F1"],
      ["F2", "F2"],
      ["F3", "F3"],
      ["F4", "F4"],
      ["F5", "F5"],
      ["F6", "F6"],
      ["F7", "F7"],
      ["F9", "F9"],
      ["F10", "F10"],
      ["F11", "F11"],
      ["F12", "F12"],
    ],
  },
  {
    group: "符号键",
    items: [
      ["Grave", "` ~"],
      ["Minus", "- _"],
      ["Equals", "= +"],
      ["LeftBracket", "[ {"],
      ["RightBracket", "] }"],
      ["Backslash", "\\ |"],
      ["Semicolon", "; :"],
      ["Apostrophe", "' \""],
      ["Comma", ", <"],
      ["Period", ". >"],
      ["Slash", "/ ?"],
    ],
  },
  {
    group: "小键盘",
    items: [
      ["Num0", "小键盘 0"],
      ["Num1", "小键盘 1"],
      ["Num2", "小键盘 2"],
      ["Num3", "小键盘 3"],
      ["Num4", "小键盘 4"],
      ["Num5", "小键盘 5"],
      ["Num6", "小键盘 6"],
      ["Num7", "小键盘 7"],
      ["Num8", "小键盘 8"],
      ["Num9", "小键盘 9"],
      ["NumDivide", "小键盘 /"],
      ["NumMultiply", "小键盘 *"],
      ["NumSubtract", "小键盘 -"],
      ["NumAdd", "小键盘 +"],
      ["NumDecimal", "小键盘 ."],
      ["NumEnter", "小键盘 Enter"],
    ],
  },
];

const OUTPUT_LABEL_MAP: Record<string, string> = Object.fromEntries(
  OUTPUT_GROUPS.flatMap((g) => g.items),
);

export function outputLabel(tok: OutputToken): string {
  return OUTPUT_LABEL_MAP[tok] || tok;
}

export function isWheelToken(tok: OutputToken): boolean {
  return tok === "WheelUp" || tok === "WheelDown";
}

/**
 * Physical keyboard event `e.code` mapper (immune to Chinese IME `Process`/229!).
 * Returns `"F8"` specifically so the UI can intercept and warn about the emergency hotkey.
 */
export function codeToOutputToken(code: string): OutputToken | "F8" | null {
  if (code === "F8") return "F8";
  if (code.startsWith("Key") && code.length === 4) {
    const ch = code.slice(3).toUpperCase();
    if (ch >= "A" && ch <= "Z") return ch;
  }
  if (code.startsWith("Digit") && code.length === 6) {
    const d = code.slice(5);
    if (d >= "0" && d <= "9") return `Key${d}`;
  }
  if (/^F([1-9]|1[0-2])$/.test(code)) {
    return code;
  }
  if (/^Numpad[0-9]$/.test(code)) {
    return `Num${code.slice(6)}`;
  }
  const table: Record<string, OutputToken> = {
    ShiftLeft: "LShift",
    ShiftRight: "RShift",
    ControlLeft: "LCtrl",
    ControlRight: "RCtrl",
    AltLeft: "LAlt",
    AltRight: "RAlt",
    MetaLeft: "LWin",
    MetaRight: "RWin",
    OSLeft: "LWin",
    OSRight: "RWin",
    Space: "Space",
    Enter: "Enter",
    Escape: "Escape",
    Tab: "Tab",
    Backspace: "Backspace",
    CapsLock: "CapsLock",
    Insert: "Insert",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Backquote: "Grave",
    Minus: "Minus",
    Equal: "Equals",
    BracketLeft: "LeftBracket",
    BracketRight: "RightBracket",
    Backslash: "Backslash",
    IntlBackslash: "Backslash",
    Semicolon: "Semicolon",
    Quote: "Apostrophe",
    Comma: "Comma",
    Period: "Period",
    Slash: "Slash",
    NumpadDivide: "NumDivide",
    NumpadMultiply: "NumMultiply",
    NumpadSubtract: "NumSubtract",
    NumpadAdd: "NumAdd",
    NumpadDecimal: "NumDecimal",
    NumpadEnter: "NumEnter",
  };
  return table[code] || null;
}

export type KbTriggerMode = "once" | "hold_loop" | "toggle_loop";

export type KbStep = {
  keys: OutputToken[];
  hold_ms: number;
  gap_ms: number;
};

export type KeymapAction =
  | { kind: "hold"; keys: OutputToken[] }
  | {
      kind: "macro";
      steps: KbStep[];
      trigger_mode: KbTriggerMode;
      loop_ms: number;
    };

export type KeymapRule = {
  id: string;
  name: string;
  enabled: boolean;
  rear_slot?: number | null;
  trigger: PadButton[];
  action: KeymapAction;
};

export type KeymapProfile = {
  id: string;
  name: string;
  rules: KeymapRule[];
};

export type KeymapStore = {
  schema: number;
  active_profile_id: string;
  controller_slot?: number | null;
  trigger_threshold: number;
  stick_deadzone: number;
  profiles: KeymapProfile[];
};

export type RunnerSnapshot = {
  enabled: boolean;
  paused_reason: string | null;
  state: string;
  active_slot: number | null;
  active_rules: string[];
  armed: boolean;
  panic_count: number;
  last_panic: boolean;
  blocked_count: number;
  injection_warning: string | null;
};
