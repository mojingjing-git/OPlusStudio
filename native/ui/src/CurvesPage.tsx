import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Copy, RotateCcw, Sparkles, Undo2 } from "lucide-react";
import {
  CURVE_AXIS_MAX,
  CURVE_POINT_X_MAX,
  CURVE_POINT_X_MIN,
  CURVE_PRESETS,
  STICK_MAX_PROGRESS,
  TRIGGER_GEARS,
  TRIGGER_MAX_PROGRESS,
  type CurvePoint,
  curveShape,
  curveSideMask,
  matchCurvePreset,
  matchTriggerGear,
  parseCurveRecordChannels,
  projectCurvePreview,
} from "./curves";
import type {
  Input,
  StickCurveSetting,
  TriggerCurveSetting,
  View,
} from "./types";

interface CurvesPageProps {
  view: View;
  settings: any[];
  pad: Input | undefined;
  inputs?: Input[];
  selectedSlot?: number | null;
  onSelectSlot?: (slot: number | null) => void;
  isTauri?: boolean;
  busy: boolean;
  onStage: (s: StickCurveSetting | TriggerCurveSetting) => void;
  onUnstage: (feature: "stick_curve" | "trigger_curve", side: number) => void;
  onNotice: (msg: string) => void;
}

const PLOT_SIZE = 240;

function clampInt(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, Math.round(val)));
}

function sanitizeControlPoints(
  p1: CurvePoint,
  p2: CurvePoint,
): [CurvePoint, CurvePoint] {
  const safeP1X = clampInt(p1[0], CURVE_POINT_X_MIN, CURVE_POINT_X_MAX - 1);
  const safeP2X = clampInt(
    Math.max(safeP1X + 1, p2[0]),
    safeP1X + 1,
    CURVE_POINT_X_MAX,
  );
  return [
    [safeP1X, clampInt(p1[1], 0, CURVE_AXIS_MAX)],
    [safeP2X, clampInt(p2[1], 0, CURVE_AXIS_MAX)],
  ];
}

function formatHalfPct(val200: number): string {
  const pct = val200 / 2;
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
}

interface CurveCanvasProps {
  idPrefix: string;
  inner: number;
  outerRaw: number;
  maxProgress: number;
  point1: CurvePoint;
  point2: CurvePoint;
  liveMagnitude: number | null;
  disabled: boolean;
  onPointsChange: (p1: CurvePoint, p2: CurvePoint) => void;
}

function CurveCanvas({
  idPrefix,
  inner,
  outerRaw,
  maxProgress,
  point1,
  point2,
  liveMagnitude,
  disabled,
  onPointsChange,
}: CurveCanvasProps) {
  const plotRef = useRef<SVGRectElement>(null);
  const [dragging, setDragging] = useState<1 | 2 | null>(null);

  const outerThreshold = Math.max(inner + 1, maxProgress - outerRaw);
  const innerPx = (inner / maxProgress) * PLOT_SIZE;
  const outerPx = (outerThreshold / maxProgress) * PLOT_SIZE;

  const samples = curveShape(point1, point2, 65);
  const linePath = samples
    .map(([x, y], idx) => {
      const sx = (x / CURVE_AXIS_MAX) * PLOT_SIZE;
      const sy = PLOT_SIZE - (y / CURVE_AXIS_MAX) * PLOT_SIZE;
      return `${idx === 0 ? "M" : "L"}${sx.toFixed(2)} ${sy.toFixed(2)}`;
    })
    .join(" ");
  const areaPath = `${linePath} L${PLOT_SIZE} ${PLOT_SIZE} L0 ${PLOT_SIZE} Z`;

  const p1SvgX = (point1[0] / CURVE_AXIS_MAX) * PLOT_SIZE;
  const p1SvgY = PLOT_SIZE - (point1[1] / CURVE_AXIS_MAX) * PLOT_SIZE;
  const p2SvgX = (point2[0] / CURVE_AXIS_MAX) * PLOT_SIZE;
  const p2SvgY = PLOT_SIZE - (point2[1] / CURVE_AXIS_MAX) * PLOT_SIZE;

  // Live hardware telemetry projection
  let liveState: {
    rawPx: number;
    dotX: number;
    dotY: number;
    inPct: number;
    outPct: number;
    zoneLabel: string;
  } | null = null;

  if (liveMagnitude !== null) {
    const projected = projectCurvePreview(
      liveMagnitude,
      inner,
      outerRaw,
      maxProgress,
      point1,
      point2,
    );
    liveState = {
      rawPx: projected.clampedMag * PLOT_SIZE,
      dotX: (projected.curveX / CURVE_AXIS_MAX) * PLOT_SIZE,
      dotY: PLOT_SIZE - (projected.curveY / CURVE_AXIS_MAX) * PLOT_SIZE,
      inPct: projected.inPct,
      outPct: projected.outPct,
      zoneLabel: projected.zoneLabel,
    };
  }

  const [safeP1, safeP2] = sanitizeControlPoints(point1, point2);

  const updateFromPointer = (
    which: 1 | 2,
    clientX: number,
    clientY: number,
  ) => {
    if (disabled || !plotRef.current) return;
    const rect = plotRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
    const rawX = Math.round(nx * CURVE_AXIS_MAX);
    const rawY = Math.round(ny * CURVE_AXIS_MAX);

    if (which === 1) {
      const nextP1: CurvePoint = [
        clampInt(rawX, CURVE_POINT_X_MIN, safeP2[0] - 1),
        clampInt(rawY, 0, CURVE_AXIS_MAX),
      ];
      onPointsChange(nextP1, safeP2);
    } else {
      const nextP2: CurvePoint = [
        clampInt(rawX, safeP1[0] + 1, CURVE_POINT_X_MAX),
        clampInt(rawY, 0, CURVE_AXIS_MAX),
      ];
      onPointsChange(safeP1, nextP2);
    }
  };

  const handlePointerDown =
    (which: 1 | 2) => (e: ReactPointerEvent<SVGGElement>) => {
      if (disabled) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(which);
      updateFromPointer(which, e.clientX, e.clientY);
    };

  const handlePointerMove =
    (which: 1 | 2) => (e: ReactPointerEvent<SVGGElement>) => {
      if (dragging !== which) return;
      updateFromPointer(which, e.clientX, e.clientY);
    };

  const handlePointerUp =
    (which: 1 | 2) => (e: ReactPointerEvent<SVGGElement>) => {
      if (dragging === which) {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
        setDragging(null);
      }
    };

  const areaGradId = `${idPrefix}-area-grad`;
  const clipId = `${idPrefix}-plot-clip`;
  const glowId = `${idPrefix}-spline-glow`;

  return (
    <div className="curve-canvas-block">
      <div className="curve-canvas-bar">
        <span className="subtle">响应曲线画布（固定端点 0,0 → 255,255）</span>
        {liveState ? (
          <span
            className="curve-telemetry-pill"
            title="系统输入流经当前草稿参数计算的软件预览估算值，非手柄蓝牙直接回传"
          >
            <span className="dot online" />
            草稿估算 · 输入 {liveState.inPct}% → 输出 {liveState.outPct}% ·{" "}
            {liveState.zoneLabel}
          </span>
        ) : (
          <span className="curve-telemetry-pill muted">
            拖拽 P1 / P2 圆点实时塑形（草稿预览）
          </span>
        )}
      </div>

      <div className="curve-svg-shell">
        <svg
          className="curve-svg"
          viewBox="-26 -16 284 282"
          role="img"
          aria-label="交互式响应曲线画布"
        >
          <defs>
            <linearGradient id={areaGradId} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.26" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
            </linearGradient>
            <clipPath id={clipId}>
              <rect x={0} y={0} width={PLOT_SIZE} height={PLOT_SIZE} rx={14} />
            </clipPath>
            <filter id={glowId} x="-15%" y="-15%" width="130%" height="130%">
              <feDropShadow
                dx="0"
                dy="2"
                stdDeviation="3.5"
                floodColor="var(--accent)"
                floodOpacity="0.38"
              />
            </filter>
          </defs>

          {/* Recessed Liquid Glass Plot Surface */}
          <rect
            ref={plotRef}
            x={0}
            y={0}
            width={PLOT_SIZE}
            height={PLOT_SIZE}
            rx={14}
            className="curve-plot-bg"
          />

          <g clipPath={`url(#${clipId})`}>
            {/* Inner & Outer Deadzone Shaded Bands */}
            {innerPx > 0 && (
              <rect
                x={0}
                y={0}
                width={innerPx}
                height={PLOT_SIZE}
                className="curve-deadzone-fill inner"
              />
            )}
            {outerPx < PLOT_SIZE && (
              <rect
                x={outerPx}
                y={0}
                width={PLOT_SIZE - outerPx}
                height={PLOT_SIZE}
                className="curve-deadzone-fill outer"
              />
            )}

            {/* 25% / 50% / 75% Optical Grid Lines */}
            {[60, 120, 180].map((pos) => (
              <g key={pos}>
                <line
                  x1={pos}
                  y1={0}
                  x2={pos}
                  y2={PLOT_SIZE}
                  className="curve-grid-line"
                />
                <line
                  x1={0}
                  y1={pos}
                  x2={PLOT_SIZE}
                  y2={pos}
                  className="curve-grid-line"
                />
              </g>
            ))}

            {/* Deadzone Threshold Guide Lines */}
            {innerPx > 0 && (
              <line
                x1={innerPx}
                y1={0}
                x2={innerPx}
                y2={PLOT_SIZE}
                className="curve-deadzone-line"
              />
            )}
            {outerPx < PLOT_SIZE && (
              <line
                x1={outerPx}
                y1={0}
                x2={outerPx}
                y2={PLOT_SIZE}
                className="curve-deadzone-line"
              />
            )}

            {/* 45-Degree Linear Reference Diagonal */}
            <line
              x1={0}
              y1={PLOT_SIZE}
              x2={PLOT_SIZE}
              y2={0}
              className="curve-linear-ref"
            />

            {/* Luminous Area Fill Under Response Curve */}
            <path d={areaPath} fill={`url(#${areaGradId})`} />

            {/* Live Raw Physical Travel Hairline */}
            {liveState && (
              <line
                x1={liveState.rawPx}
                y1={0}
                x2={liveState.rawPx}
                y2={PLOT_SIZE}
                className="curve-live-guide"
              />
            )}
          </g>

          {/* Outer Glass Rim Frame */}
          <rect
            x={0}
            y={0}
            width={PLOT_SIZE}
            height={PLOT_SIZE}
            rx={14}
            className="curve-plot-border"
          />

          {/* Axis Scale Annotations */}
          <text x={-6} y={7} textAnchor="end" className="curve-axis-label">
            255
          </text>
          <text x={-6} y={124} textAnchor="end" className="curve-axis-label">
            128
          </text>
          <text x={-6} y={240} textAnchor="end" className="curve-axis-label">
            0
          </text>
          <text x={0} y={257} textAnchor="start" className="curve-axis-label">
            0
          </text>
          <text x={120} y={257} textAnchor="middle" className="curve-axis-label">
            输入行程
          </text>
          <text x={240} y={257} textAnchor="end" className="curve-axis-label">
            255
          </text>

          {/* Glowing Fritsch-Carlson Monotone Cubic Curve */}
          <path
            d={linePath}
            className="curve-spline-path"
            filter={`url(#${glowId})`}
          />

          {/* Live Emerald Projection Jewel */}
          {liveState && (
            <g className="curve-live-group" pointerEvents="none">
              <circle
                cx={liveState.dotX}
                cy={liveState.dotY}
                r={10.5}
                className="curve-live-halo"
              />
              <circle
                cx={liveState.dotX}
                cy={liveState.dotY}
                r={5.6}
                className="curve-live-dot"
              />
            </g>
          )}

          {/* Draggable Specular Control Handle P1 */}
          <g
            className={
              "curve-handle" + (dragging === 1 ? " dragging" : "")
            }
            onPointerDown={handlePointerDown(1)}
            onPointerMove={handlePointerMove(1)}
            onPointerUp={handlePointerUp(1)}
            onPointerCancel={handlePointerUp(1)}
          >
            <circle cx={p1SvgX} cy={p1SvgY} r={15} className="curve-handle-hit" />
            <circle cx={p1SvgX} cy={p1SvgY} r={7.5} className="curve-handle-knob" />
            <circle cx={p1SvgX - 2} cy={p1SvgY - 2} r={2.2} className="curve-handle-shine" />
            <text
              x={p1SvgX}
              y={p1SvgY > 24 ? p1SvgY - 12 : p1SvgY + 20}
              textAnchor="middle"
              className="curve-handle-tag"
            >
              P1
            </text>
          </g>

          {/* Draggable Specular Control Handle P2 */}
          <g
            className={
              "curve-handle" + (dragging === 2 ? " dragging" : "")
            }
            onPointerDown={handlePointerDown(2)}
            onPointerMove={handlePointerMove(2)}
            onPointerUp={handlePointerUp(2)}
            onPointerCancel={handlePointerUp(2)}
          >
            <circle cx={p2SvgX} cy={p2SvgY} r={15} className="curve-handle-hit" />
            <circle cx={p2SvgX} cy={p2SvgY} r={7.5} className="curve-handle-knob" />
            <circle cx={p2SvgX - 2} cy={p2SvgY - 2} r={2.2} className="curve-handle-shine" />
            <text
              x={p2SvgX}
              y={p2SvgY > 24 ? p2SvgY - 12 : p2SvgY + 20}
              textAnchor="middle"
              className="curve-handle-tag"
            >
              P2
            </text>
          </g>
        </svg>
      </div>

      {/* Precision Point Numeric Fine-Tuning */}
      <div className="curve-coords-grid">
        <label>
          <span>P1 横坐标 X</span>
          <input
            type="number"
            min={CURVE_POINT_X_MIN}
            max={safeP2[0] - 1}
            disabled={disabled}
            aria-label={`${idPrefix} P1 X`}
            value={point1[0]}
            onChange={(e) =>
              onPointsChange(
                [
                  clampInt(
                    Number(e.target.value),
                    CURVE_POINT_X_MIN,
                    safeP2[0] - 1,
                  ),
                  safeP1[1],
                ],
                safeP2,
              )
            }
          />
        </label>
        <label>
          <span>P1 纵坐标 Y</span>
          <input
            type="number"
            min={0}
            max={CURVE_AXIS_MAX}
            disabled={disabled}
            aria-label={`${idPrefix} P1 Y`}
            value={point1[1]}
            onChange={(e) =>
              onPointsChange(
                [safeP1[0], clampInt(Number(e.target.value), 0, CURVE_AXIS_MAX)],
                safeP2,
              )
            }
          />
        </label>
        <label>
          <span>P2 横坐标 X</span>
          <input
            type="number"
            min={safeP1[0] + 1}
            max={CURVE_POINT_X_MAX}
            disabled={disabled}
            aria-label={`${idPrefix} P2 X`}
            value={point2[0]}
            onChange={(e) =>
              onPointsChange(safeP1, [
                clampInt(
                  Number(e.target.value),
                  safeP1[0] + 1,
                  CURVE_POINT_X_MAX,
                ),
                safeP2[1],
              ])
            }
          />
        </label>
        <label>
          <span>P2 纵坐标 Y</span>
          <input
            type="number"
            min={0}
            max={CURVE_AXIS_MAX}
            disabled={disabled}
            aria-label={`${idPrefix} P2 Y`}
            value={point2[1]}
            onChange={(e) =>
              onPointsChange(safeP1, [
                safeP2[0],
                clampInt(Number(e.target.value), 0, CURVE_AXIS_MAX),
              ])
            }
          />
        </label>
      </div>
    </div>
  );
}

export default function CurvesPage({
  view,
  settings,
  pad,
  inputs = [],
  selectedSlot = null,
  onSelectSlot,
  isTauri = true,
  busy,
  onStage,
  onUnstage,
  onNotice,
}: CurvesPageProps) {
  const [tab, setTab] = useState<"sticks" | "triggers">("sticks");

  const caps = view.capabilities_info;
  const stickRecord = parseCurveRecordChannels(view.snapshot.raw.sticks);
  const triggerRecord = parseCurveRecordChannels(view.snapshot.raw.triggers);

  const stickEnabled = (side: 0 | 1): boolean => {
    if (!stickRecord) return false;
    if (caps?.stick_sides) return caps.stick_sides.includes(side);
    return ((caps?.sticks ?? 0) & curveSideMask(side)) !== 0;
  };

  const triggerEnabled = (side: 0 | 1): boolean => {
    if (!triggerRecord) return false;
    if (caps?.trigger_sides) return caps.trigger_sides.includes(side);
    return ((caps?.triggers ?? 0) & curveSideMask(side)) !== 0;
  };

  const getStickState = (side: 0 | 1) => {
    const base = stickRecord?.[side] ?? {
      inner: 6,
      outer_raw: 8,
      point1: [85, 85] as CurvePoint,
      point2: [170, 170] as CurvePoint,
      flags: 0,
      invert_x: false,
      invert_y: false,
      swap: false,
    };
    const staged = settings.find(
      (s): s is StickCurveSetting =>
        s.feature === "stick_curve" && s.side === side,
    );
    return {
      base,
      isDraft: Boolean(staged),
      current: staged
        ? {
            inner: staged.inner,
            outer_raw: staged.outer_raw,
            point1: staged.point1,
            point2: staged.point2,
            invert_x: staged.invert_x,
            invert_y: staged.invert_y,
            swap: staged.swap,
          }
        : {
            inner: base.inner,
            outer_raw: base.outer_raw,
            point1: base.point1,
            point2: base.point2,
            invert_x: base.invert_x,
            invert_y: base.invert_y,
            swap: base.swap,
          },
    };
  };

  const getTriggerState = (side: 0 | 1) => {
    const base = triggerRecord?.[side] ?? {
      inner: 4,
      outer_raw: 2,
      point1: [85, 85] as CurvePoint,
      point2: [170, 170] as CurvePoint,
      flags: 0,
      invert_x: false,
      invert_y: false,
      swap: false,
    };
    const staged = settings.find(
      (s): s is TriggerCurveSetting =>
        s.feature === "trigger_curve" && s.side === side,
    );
    return {
      base,
      isDraft: Boolean(staged),
      current: staged
        ? {
            inner: staged.inner,
            outer_raw: staged.outer_raw,
            point1: staged.point1,
            point2: staged.point2,
          }
        : {
            inner: base.inner,
            outer_raw: base.outer_raw,
            point1: base.point1,
            point2: base.point2,
          },
    };
  };

  const commitStick = (
    side: 0 | 1,
    rawNext: Omit<StickCurveSetting, "feature" | "side">,
  ) => {
    const [p1, p2] = sanitizeControlPoints(rawNext.point1, rawNext.point2);
    const next = { ...rawNext, point1: p1, point2: p2 };
    const { base } = getStickState(side);
    const matchesBase =
      next.inner === base.inner &&
      next.outer_raw === base.outer_raw &&
      next.point1[0] === base.point1[0] &&
      next.point1[1] === base.point1[1] &&
      next.point2[0] === base.point2[0] &&
      next.point2[1] === base.point2[1] &&
      next.invert_x === base.invert_x &&
      next.invert_y === base.invert_y &&
      next.swap === base.swap;
    if (matchesBase) {
      onUnstage("stick_curve", side);
    } else {
      onStage({ feature: "stick_curve", side, ...next });
    }
  };

  const commitTrigger = (
    side: 0 | 1,
    rawNext: Omit<TriggerCurveSetting, "feature" | "side">,
  ) => {
    const [p1, p2] = sanitizeControlPoints(rawNext.point1, rawNext.point2);
    const next = { ...rawNext, point1: p1, point2: p2 };
    const { base } = getTriggerState(side);
    const matchesBase =
      next.inner === base.inner &&
      next.outer_raw === base.outer_raw &&
      next.point1[0] === base.point1[0] &&
      next.point1[1] === base.point1[1] &&
      next.point2[0] === base.point2[0] &&
      next.point2[1] === base.point2[1];
    if (matchesBase) {
      onUnstage("trigger_curve", side);
    } else {
      onStage({ feature: "trigger_curve", side, ...next });
    }
  };

  const stickDraftCount = ([0, 1] as const).filter((s) => getStickState(s).isDraft).length;
  const triggerDraftCount = ([0, 1] as const).filter((s) => getTriggerState(s).isDraft).length;

  return (
    <div className="curves-page">
      {/* Top Mode Switcher & Draft Telemetry Source Bar */}
      <div className="panel curves-header-bar">
        <div className="segmented curves-segmented">
          <button
            type="button"
            className={tab === "sticks" ? "active" : ""}
            onClick={() => setTab("sticks")}
          >
            左右摇杆（死区 · 曲线 · 轴反向）
            {stickDraftCount > 0 && (
              <span className="draft-tag">{stickDraftCount} 草稿</span>
            )}
          </button>
          <button
            type="button"
            className={tab === "triggers" ? "active" : ""}
            onClick={() => setTab("triggers")}
          >
            左右扳机（死区 · 行程档位 · 曲线）
            {triggerDraftCount > 0 && (
              <span className="draft-tag">{triggerDraftCount} 草稿</span>
            )}
          </button>
        </div>

        <div className="curves-preview-note">
          <span>
            实时光点为<strong>草稿软件估算</strong>（读取系统{" "}
            {isTauri ? "XInput" : "Gamepad"} 输入套用当前草稿曲线，与蓝牙配置通道独立；以保存至手柄后的实际固件输出为准）。
          </span>
          {inputs.length > 0 && (
            <div className="curves-slot-picker">
              <span>
                {inputs.length > 1 ? "多手柄预览槽位：" : "当前输入槽位："}
              </span>
              {inputs.map((item) => {
                const active = pad?.slot === item.slot;
                return (
                  <button
                    key={item.slot}
                    type="button"
                    className={
                      active && (selectedSlot === item.slot || inputs.length === 1 || selectedSlot === null)
                        ? "selected"
                        : ""
                    }
                    onClick={() => onSelectSlot?.(item.slot)}
                  >
                    #{item.slot + 1}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {tab === "sticks" ? (
        <fieldset className="curves-grid" disabled={busy}>
          {([0, 1] as const).map((side) => {
            const otherSide: 0 | 1 = side === 0 ? 1 : 0;
            const title = side === 0 ? "左摇杆 LS" : "右摇杆 RS";
            const otherTitle = side === 0 ? "右摇杆" : "左摇杆";
            const enabled = stickEnabled(side);
            const otherEnabled = stickEnabled(otherSide);
            const { current, isDraft } = getStickState(side);
            const otherState = getStickState(otherSide);

            if (!enabled) {
              return (
                <section className="panel curve-card disabled-card" key={`stick-${side}`}>
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">STICK CHANNEL {side + 1}</p>
                      <h2>{title}</h2>
                    </div>
                    <span className="pill">未启用</span>
                  </div>
                  <p className="hint">
                    当前手柄能力描述符（<code>0xB0</code>）未开放此侧摇杆通道，原始字节将在保存对侧配置时严格原样保留。
                  </p>
                </section>
              );
            }

            const outerThreshold = STICK_MAX_PROGRESS - current.outer_raw;
            const activePreset = matchCurvePreset(current.point1, current.point2);
            const liveMag = pad
              ? Math.min(
                  1,
                  Math.hypot(
                    side === 0 ? pad.lx : pad.rx,
                    side === 0 ? pad.ly : pad.ry,
                  ) / 32767,
                )
              : null;

            return (
              <section className="panel curve-card" key={`stick-${side}`}>
                <div className="curve-card-head">
                  <div>
                    <p className="eyebrow">
                      {side === 0 ? "LEFT STICK · 0x31" : "RIGHT STICK · 0x31"}
                    </p>
                    <h2>{title}</h2>
                  </div>
                  <div className="curve-card-badges">
                    <span className={"pill " + (isDraft ? "pending" : "")}>
                      {isDraft ? "未保存草稿" : "当前板载配置"}
                    </span>
                  </div>
                </div>

                {/* Interactive 240x240 SVG Response Curve */}
                <CurveCanvas
                  idPrefix={`stick-${side}`}
                  inner={current.inner}
                  outerRaw={current.outer_raw}
                  maxProgress={STICK_MAX_PROGRESS}
                  point1={current.point1}
                  point2={current.point2}
                  liveMagnitude={liveMag}
                  disabled={busy}
                  onPointsChange={(p1, p2) =>
                    commitStick(side, { ...current, point1: p1, point2: p2 })
                  }
                />

                {/* One-Click Response Curve Presets */}
                <div className="curve-section">
                  <div className="section-label">
                    <span>
                      <Sparkles size={14} className="inline-icon" />
                      响应曲线预设
                    </span>
                    <span>
                      {activePreset
                        ? CURVE_PRESETS.find((p) => p.id === activePreset)?.desc
                        : "自定义控制点"}
                    </span>
                  </div>
                  <div className="preset-pills">
                    {CURVE_PRESETS.map((preset) => (
                      <button
                        type="button"
                        key={preset.id}
                        className={activePreset === preset.id ? "selected" : ""}
                        title={preset.desc}
                        onClick={() =>
                          commitStick(side, {
                            ...current,
                            point1: [...preset.point1],
                            point2: [...preset.point2],
                          })
                        }
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Inner & Outer Deadzone Interlocked Sliders */}
                <div className="curve-section">
                  <div className="section-label">
                    <span>内外死区区间</span>
                    <span>
                      有效工作区 {current.inner}% – {outerThreshold}%
                    </span>
                  </div>
                  <label className="curve-range-row">
                    <div className="curve-range-meta">
                      <span>中心内死区</span>
                      <output>{current.inner}%</output>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={99}
                      value={current.inner}
                      onChange={(e) => {
                        const nextInner = clampInt(Number(e.target.value), 0, 99);
                        let nextOuterThresh = outerThreshold;
                        if (nextInner >= nextOuterThresh) {
                          nextOuterThresh = Math.min(100, nextInner + 1);
                        }
                        commitStick(side, {
                          ...current,
                          inner: nextInner,
                          outer_raw: 100 - nextOuterThresh,
                        });
                      }}
                    />
                  </label>

                  <label className="curve-range-row">
                    <div className="curve-range-meta">
                      <span>边缘有效上限</span>
                      <output>
                        {outerThreshold}%{" "}
                        <small>（外死区边距 {current.outer_raw}%）</small>
                      </output>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={100}
                      value={outerThreshold}
                      onChange={(e) => {
                        const nextOuterThresh = clampInt(Number(e.target.value), 1, 100);
                        let nextInner = current.inner;
                        if (nextOuterThresh <= nextInner) {
                          nextInner = Math.max(0, nextOuterThresh - 1);
                        }
                        commitStick(side, {
                          ...current,
                          inner: nextInner,
                          outer_raw: 100 - nextOuterThresh,
                        });
                      }}
                    />
                  </label>
                </div>

                {/* Stick Axis Switches (.ios-switch) */}
                <div className="curve-section">
                  <div className="section-label">
                    <span>轴向与摇杆互换</span>
                    <span>保留高位未知标志 (0xF8)</span>
                  </div>
                  <div className="axis-switch-list">
                    <label className="axis-switch-row">
                      <div>
                        <strong>X 轴反向（左右反转）</strong>
                        <small>反转该摇杆水平左右推杆方向</small>
                      </div>
                      <input
                        type="checkbox"
                        className="ios-switch"
                        checked={current.invert_x}
                        onChange={(e) =>
                          commitStick(side, {
                            ...current,
                            invert_x: e.target.checked,
                          })
                        }
                      />
                    </label>

                    <label className="axis-switch-row">
                      <div>
                        <strong>Y 轴反向（上下反转）</strong>
                        <small>反转该摇杆垂直上下推杆方向</small>
                      </div>
                      <input
                        type="checkbox"
                        className="ios-switch"
                        checked={current.invert_y}
                        onChange={(e) =>
                          commitStick(side, {
                            ...current,
                            invert_y: e.target.checked,
                          })
                        }
                      />
                    </label>

                    <div className="axis-switch-row">
                      <div>
                        <strong>左右摇杆互换</strong>
                        <small>
                          板载通道标志位（<code>0x04</code>），常规互换建议左右摇杆同步开启
                        </small>
                        {otherEnabled && otherState.current.swap !== current.swap && (
                          <button
                            type="button"
                            className="inline-link-btn sync-swap-btn"
                            onClick={() => {
                              commitStick(otherSide, {
                                ...otherState.current,
                                swap: current.swap,
                              });
                              onNotice(`已将“左右摇杆互换”状态同步到${otherTitle}草稿。`);
                            }}
                          >
                            同步此开关到{otherTitle}
                          </button>
                        )}
                      </div>
                      <input
                        type="checkbox"
                        className="ios-switch"
                        aria-label={`${title} 左右摇杆互换`}
                        checked={current.swap}
                        onChange={(e) =>
                          commitStick(side, {
                            ...current,
                            swap: e.target.checked,
                          })
                        }
                      />
                    </div>
                  </div>
                </div>

                {/* Mirror & Discard Footer */}
                <div className="curve-card-foot">
                  <button
                    type="button"
                    disabled={!otherEnabled}
                    onClick={() => {
                      commitStick(otherSide, {
                        inner: current.inner,
                        outer_raw: current.outer_raw,
                        point1: [...current.point1],
                        point2: [...current.point2],
                        invert_x: current.invert_x,
                        invert_y: current.invert_y,
                        swap: current.swap,
                      });
                      onNotice(`已将${title}参数镜像复制到${otherTitle}草稿。`);
                    }}
                  >
                    <Copy size={15} />
                    复制到{otherTitle}
                  </button>

                  {isDraft ? (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => onUnstage("stick_curve", side)}
                    >
                      <Undo2 size={15} />
                      放弃此项草稿
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="text-button"
                      disabled={
                        current.inner === 6 &&
                        current.outer_raw === 8 &&
                        activePreset === "default" &&
                        !current.invert_x &&
                        !current.invert_y &&
                        !current.swap
                      }
                      onClick={() =>
                        commitStick(side, {
                          inner: 6,
                          outer_raw: 8,
                          point1: [85, 85],
                          point2: [170, 170],
                          invert_x: false,
                          invert_y: false,
                          swap: false,
                        })
                      }
                    >
                      <RotateCcw size={14} />
                      设为出厂默认
                    </button>
                  )}
                </div>
              </section>
            );
          })}
        </fieldset>
      ) : (
        <fieldset className="curves-grid" disabled={busy}>
          {([0, 1] as const).map((side) => {
            const otherSide: 0 | 1 = side === 0 ? 1 : 0;
            const title = side === 0 ? "左扳机 LT" : "右扳机 RT";
            const otherTitle = side === 0 ? "右扳机" : "左扳机";
            const enabled = triggerEnabled(side);
            const otherEnabled = triggerEnabled(otherSide);
            const { current, isDraft } = getTriggerState(side);

            if (!enabled) {
              return (
                <section className="panel curve-card disabled-card" key={`trigger-${side}`}>
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">TRIGGER CHANNEL {side + 1}</p>
                      <h2>{title}</h2>
                    </div>
                    <span className="pill">未启用</span>
                  </div>
                  <p className="hint">
                    当前手柄能力描述符（<code>0xB0</code>）未开放此侧扳机通道，原始字节将在保存对侧配置时严格原样保留。
                  </p>
                </section>
              );
            }

            const outerThreshold = TRIGGER_MAX_PROGRESS - current.outer_raw;
            const activePreset = matchCurvePreset(current.point1, current.point2);
            const activeGear = matchTriggerGear(current.inner, current.outer_raw);
            const liveMag = pad
              ? Math.min(
                  1,
                  (side === 0 ? pad.left_trigger : pad.right_trigger) / 255,
                )
              : null;

            return (
              <section className="panel curve-card" key={`trigger-${side}`}>
                <div className="curve-card-head">
                  <div>
                    <p className="eyebrow">
                      {side === 0 ? "LEFT TRIGGER · 0x32" : "RIGHT TRIGGER · 0x32"}
                    </p>
                    <h2>{title}</h2>
                  </div>
                  <div className="curve-card-badges">
                    <span className={"pill " + (isDraft ? "pending" : "")}>
                      {isDraft ? "未保存草稿" : "当前板载配置"}
                    </span>
                  </div>
                </div>

                {/* Interactive 240x240 SVG Response Curve */}
                <CurveCanvas
                  idPrefix={`trigger-${side}`}
                  inner={current.inner}
                  outerRaw={current.outer_raw}
                  maxProgress={TRIGGER_MAX_PROGRESS}
                  point1={current.point1}
                  point2={current.point2}
                  liveMagnitude={liveMag}
                  disabled={busy}
                  onPointsChange={(p1, p2) =>
                    commitTrigger(side, { ...current, point1: p1, point2: p2 })
                  }
                />

                {/* Trigger Exclusive 4-Gear Travel Presets */}
                <div className="curve-section">
                  <div className="section-label">
                    <span>四档行程快捷预设</span>
                    <span>
                      {activeGear
                        ? TRIGGER_GEARS.find((g) => g.id === activeGear)?.desc
                        : `自定义区间 ${current.inner}–${outerThreshold}`}
                    </span>
                  </div>
                  <div className="preset-pills gear-pills">
                    {TRIGGER_GEARS.map((gear) => (
                      <button
                        type="button"
                        key={gear.id}
                        className={activeGear === gear.id ? "selected" : ""}
                        title={gear.desc}
                        onClick={() =>
                          commitTrigger(side, {
                            ...current,
                            inner: gear.inner,
                            outer_raw: gear.outer_raw,
                          })
                        }
                      >
                        {gear.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* One-Click Response Curve Presets */}
                <div className="curve-section">
                  <div className="section-label">
                    <span>
                      <Sparkles size={14} className="inline-icon" />
                      响应曲线预设
                    </span>
                    <span>
                      {activePreset
                        ? CURVE_PRESETS.find((p) => p.id === activePreset)?.desc
                        : "自定义控制点"}
                    </span>
                  </div>
                  <div className="preset-pills">
                    {CURVE_PRESETS.map((preset) => (
                      <button
                        type="button"
                        key={preset.id}
                        className={activePreset === preset.id ? "selected" : ""}
                        title={preset.desc}
                        onClick={() =>
                          commitTrigger(side, {
                            ...current,
                            point1: [...preset.point1],
                            point2: [...preset.point2],
                          })
                        }
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Start & Full-Travel Trigger Sliders (0-200 scale) */}
                <div className="curve-section">
                  <div className="section-label">
                    <span>起始死区与满行程触发点（0–200 精度）</span>
                    <span>
                      有效行程 {current.inner} – {outerThreshold}
                    </span>
                  </div>

                  <label className="curve-range-row">
                    <div className="curve-range-meta">
                      <span>起始死区</span>
                      <output>
                        {current.inner} / 200{" "}
                        <small>（{formatHalfPct(current.inner)}）</small>
                      </output>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={199}
                      value={current.inner}
                      onChange={(e) => {
                        const nextInner = clampInt(Number(e.target.value), 0, 199);
                        let nextOuterThresh = outerThreshold;
                        if (nextInner >= nextOuterThresh) {
                          nextOuterThresh = Math.min(200, nextInner + 1);
                        }
                        commitTrigger(side, {
                          ...current,
                          inner: nextInner,
                          outer_raw: 200 - nextOuterThresh,
                        });
                      }}
                    />
                  </label>

                  <label className="curve-range-row">
                    <div className="curve-range-meta">
                      <span>满行程触发点</span>
                      <output>
                        {outerThreshold} / 200{" "}
                        <small>
                          （{formatHalfPct(outerThreshold)} · 末端死区 {current.outer_raw}）
                        </small>
                      </output>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={200}
                      value={outerThreshold}
                      onChange={(e) => {
                        const nextOuterThresh = clampInt(Number(e.target.value), 1, 200);
                        let nextInner = current.inner;
                        if (nextOuterThresh <= nextInner) {
                          nextInner = Math.max(0, nextOuterThresh - 1);
                        }
                        commitTrigger(side, {
                          ...current,
                          inner: nextInner,
                          outer_raw: 200 - nextOuterThresh,
                        });
                      }}
                    />
                  </label>
                </div>

                {/* Mirror & Discard Footer */}
                <div className="curve-card-foot">
                  <button
                    type="button"
                    disabled={!otherEnabled}
                    onClick={() => {
                      commitTrigger(otherSide, {
                        inner: current.inner,
                        outer_raw: current.outer_raw,
                        point1: [...current.point1],
                        point2: [...current.point2],
                      });
                      onNotice(`已将${title}参数镜像复制到${otherTitle}草稿。`);
                    }}
                  >
                    <Copy size={15} />
                    复制到{otherTitle}
                  </button>

                  {isDraft ? (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => onUnstage("trigger_curve", side)}
                    >
                      <Undo2 size={15} />
                      放弃此项草稿
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="text-button"
                      disabled={
                        current.inner === 4 &&
                        current.outer_raw === 2 &&
                        activePreset === "default"
                      }
                      onClick={() =>
                        commitTrigger(side, {
                          inner: 4,
                          outer_raw: 2,
                          point1: [85, 85],
                          point2: [170, 170],
                        })
                      }
                    >
                      <RotateCcw size={14} />
                      设为出厂默认
                    </button>
                  )}
                </div>
              </section>
            );
          })}
        </fieldset>
      )}
    </div>
  );
}
