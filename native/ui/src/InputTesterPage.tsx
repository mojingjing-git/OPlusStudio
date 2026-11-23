import { useEffect, useRef, useState } from "react";
import { Activity, Gamepad2, RotateCcw, Vibrate } from "lucide-react";
import {
  type GamepadHapticActuatorLike,
  type LivePadSample,
  PollingRateAnalyzer,
  StickBenchAnalyzer,
  subscribeLiveInputs,
} from "./liveInput";

interface InputTesterPageProps {
  isTauri: boolean;
  selectedSlot: number | null;
  onSelectSlot: (slot: number | null) => void;
}

const DIGITAL_BUTTONS: readonly [number, string][] = [
  [0x1000, "A"],
  [0x2000, "B"],
  [0x4000, "X"],
  [0x8000, "Y"],
  [0x0100, "LB"],
  [0x0200, "RB"],
  [0x0040, "L3"],
  [0x0080, "R3"],
  [0x0020, "Back"],
  [0x0010, "Start"],
  [0x0001, "↑"],
  [0x0002, "↓"],
  [0x0004, "←"],
  [0x0008, "→"],
];

const RADAR_CENTER = 108;
const RADAR_RADIUS = 84;

// Pre-computed 36 perimeter degree tick coordinates (static, zero runtime cost)
const RADAR_TICKS = Array.from({ length: 36 }, (_, idx) => {
  const rad = (idx * 10 * Math.PI) / 180;
  const major = idx % 3 === 0;
  const rIn = major ? RADAR_RADIUS - 5 : RADAR_RADIUS - 2.6;
  const rOut = RADAR_RADIUS;
  return {
    x1: (RADAR_CENTER + Math.cos(rad) * rIn).toFixed(1),
    y1: (RADAR_CENTER + Math.sin(rad) * rIn).toFixed(1),
    x2: (RADAR_CENTER + Math.cos(rad) * rOut).toFixed(1),
    y2: (RADAR_CENTER + Math.sin(rad) * rOut).toFixed(1),
    major,
  };
});

function setTextIfChanged(el: HTMLElement | null, next: string): void {
  if (el && el.textContent !== next) {
    el.textContent = next;
  }
}

export default function InputTesterPage({
  isTauri,
  selectedSlot,
  onSelectSlot,
}: InputTesterPageProps) {
  // React state ONLY tracks connected slot numbers & whether rumble is supported (changes only on plug/unplug!)
  const [connectedSlots, setConnectedSlots] = useState<number[]>([]);
  const [activeSlotNum, setActiveSlotNum] = useState<number | null>(null);
  const [hasRumble, setHasRumble] = useState(false);

  const selectedSlotRef = useRef<number | null>(selectedSlot);
  selectedSlotRef.current = selectedSlot;

  const actuatorRef = useRef<GamepadHapticActuatorLike | null>(null);
  const leftBenchRef = useRef(new StickBenchAnalyzer());
  const rightBenchRef = useRef(new StickBenchAnalyzer());
  const pollBenchRef = useRef(new PollingRateAnalyzer());

  // Mutable imperative tracking state (zero React state churn!)
  const prevSlotsKeyRef = useRef("");
  const prevActiveSlotRef = useRef<number | null>(null);
  const prevHasRumbleRef = useRef(false);
  const prevButtonsRef = useRef(-1);
  const testedMaskRef = useRef(0);
  const ltPeakRef = useRef(0);
  const rtPeakRef = useRef(0);
  const lastTextFlushRef = useRef(0);

  // Cached DOM / SVG element refs
  const padNameRef = useRef<HTMLSpanElement>(null);
  const pollBadgeRef = useRef<HTMLSpanElement>(null);
  const testedCountRef = useRef<HTMLSpanElement>(null);

  const leftLiveGroupRef = useRef<SVGGElement>(null);
  const leftRestCircleRef = useRef<SVGCircleElement>(null);
  const leftPolyPathRef = useRef<SVGPathElement>(null);
  const leftCoordsRef = useRef<HTMLElement>(null);
  const leftCircValRef = useRef<HTMLElement>(null);
  const leftDriftValRef = useRef<HTMLElement>(null);

  const rightLiveGroupRef = useRef<SVGGElement>(null);
  const rightRestCircleRef = useRef<SVGCircleElement>(null);
  const rightPolyPathRef = useRef<SVGPathElement>(null);
  const rightCoordsRef = useRef<HTMLElement>(null);
  const rightCircValRef = useRef<HTMLElement>(null);
  const rightDriftValRef = useRef<HTMLElement>(null);

  const ltFillRef = useRef<HTMLDivElement>(null);
  const ltPeakMarkRef = useRef<HTMLSpanElement>(null);
  const ltValRef = useRef<HTMLElement>(null);
  const ltPeakTextRef = useRef<HTMLElement>(null);

  const rtFillRef = useRef<HTMLDivElement>(null);
  const rtPeakMarkRef = useRef<HTMLSpanElement>(null);
  const rtValRef = useRef<HTMLElement>(null);
  const rtPeakTextRef = useRef<HTMLElement>(null);

  const btnElsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const schemLeftCapRef = useRef<SVGGElement>(null);
  const schemRightCapRef = useRef<SVGGElement>(null);
  const schemLtFillRef = useRef<SVGRectElement>(null);
  const schemRtFillRef = useRef<SVGRectElement>(null);
  const schemBtnMapRef = useRef<Record<number, SVGElement | null>>({});

  const resetAllBenchmarks = () => {
    leftBenchRef.current.reset();
    rightBenchRef.current.reset();
    pollBenchRef.current.reset();
    testedMaskRef.current = 0;
    prevButtonsRef.current = -1;
    ltPeakRef.current = 0;
    rtPeakRef.current = 0;

    leftPolyPathRef.current?.setAttribute("d", "");
    rightPolyPathRef.current?.setAttribute("d", "");
    leftRestCircleRef.current?.setAttribute("transform", "translate(0, 0)");
    rightRestCircleRef.current?.setAttribute("transform", "translate(0, 0)");
    setTextIfChanged(leftCircValRef.current, "转满一圈测算");
    setTextIfChanged(rightCircValRef.current, "转满一圈测算");
    setTextIfChanged(leftDriftValRef.current, "0.0%");
    setTextIfChanged(rightDriftValRef.current, "0.0%");
    setTextIfChanged(testedCountRef.current, `已测 0 / ${DIGITAL_BUTTONS.length}`);
    setTextIfChanged(ltPeakTextRef.current, "峰值 0");
    setTextIfChanged(rtPeakTextRef.current, "峰值 0");
    if (ltPeakMarkRef.current) ltPeakMarkRef.current.style.left = "0%";
    if (rtPeakMarkRef.current) rtPeakMarkRef.current.style.left = "0%";

    for (const el of btnElsRef.current) {
      if (el) {
        el.classList.remove("pressed", "tested");
      }
    }
    for (const svgEl of Object.values(schemBtnMapRef.current)) {
      if (svgEl) {
        svgEl.classList.remove("is-on", "is-tested");
      }
    }
  };

  useEffect(() => {
    return subscribeLiveInputs(({ pads, now }) => {
      const slotsKey = pads.map((p) => p.slot).join(",");
      if (slotsKey !== prevSlotsKeyRef.current) {
        prevSlotsKeyRef.current = slotsKey;
        setConnectedSlots(pads.map((p) => p.slot));
      }

      const pref = selectedSlotRef.current;
      const pad: LivePadSample | undefined =
        (pref !== null ? pads.find((p) => p.slot === pref) : undefined) ||
        pads[0];

      const nextSlot = pad ? pad.slot : null;
      if (nextSlot !== prevActiveSlotRef.current) {
        prevActiveSlotRef.current = nextSlot;
        setActiveSlotNum(nextSlot);
        resetAllBenchmarks();
      }

      const canVibrate = Boolean(pad?.actuator?.playEffect);
      actuatorRef.current = pad?.actuator ?? null;
      if (canVibrate !== prevHasRumbleRef.current) {
        prevHasRumbleRef.current = canVibrate;
        setHasRumble(canVibrate);
      }

      if (!pad) return;

      // 1. Stick live dots & schematic caps (pure SVG transform attribute — 0 layout reflow!)
      const ldx = Math.max(-1.12, Math.min(1.12, pad.fx)) * RADAR_RADIUS;
      const ldy = Math.max(-1.12, Math.min(1.12, -pad.fy)) * RADAR_RADIUS;
      const rdx = Math.max(-1.12, Math.min(1.12, pad.frx)) * RADAR_RADIUS;
      const rdy = Math.max(-1.12, Math.min(1.12, -pad.fry)) * RADAR_RADIUS;

      leftLiveGroupRef.current?.setAttribute(
        "transform",
        `translate(${ldx.toFixed(2)}, ${ldy.toFixed(2)})`,
      );
      rightLiveGroupRef.current?.setAttribute(
        "transform",
        `translate(${rdx.toFixed(2)}, ${rdy.toFixed(2)})`,
      );
      schemLeftCapRef.current?.setAttribute(
        "transform",
        `translate(${(pad.fx * 11).toFixed(1)}, ${(-pad.fy * 11).toFixed(1)})`,
      );
      schemRightCapRef.current?.setAttribute(
        "transform",
        `translate(${(pad.frx * 11).toFixed(1)}, ${(-pad.fry * 11).toFixed(1)})`,
      );

      // 2. 36-Sector Circularity Polygon & Resting Drift
      if (leftBenchRef.current.push(pad.fx, pad.fy)) {
        leftPolyPathRef.current?.setAttribute(
          "d",
          leftBenchRef.current.buildSvgPath(RADAR_CENTER, RADAR_CENTER, RADAR_RADIUS),
        );
      }
      if (rightBenchRef.current.push(pad.frx, pad.fry)) {
        rightPolyPathRef.current?.setAttribute(
          "d",
          rightBenchRef.current.buildSvgPath(RADAR_CENTER, RADAR_CENTER, RADAR_RADIUS),
        );
      }
      leftRestCircleRef.current?.setAttribute(
        "transform",
        `translate(${(leftBenchRef.current.restX * RADAR_RADIUS).toFixed(1)}, ${(-leftBenchRef.current.restY * RADAR_RADIUS).toFixed(1)})`,
      );
      rightRestCircleRef.current?.setAttribute(
        "transform",
        `translate(${(rightBenchRef.current.restX * RADAR_RADIUS).toFixed(1)}, ${(-rightBenchRef.current.restY * RADAR_RADIUS).toFixed(1)})`,
      );

      // 3. Analog Triggers (GPU scaleX compositor transform — 0 width layout thrash!)
      if (ltFillRef.current) {
        ltFillRef.current.style.transform = `scaleX(${pad.flt.toFixed(4)})`;
      }
      if (rtFillRef.current) {
        rtFillRef.current.style.transform = `scaleX(${pad.frt.toFixed(4)})`;
      }
      schemLtFillRef.current?.setAttribute("opacity", (0.14 + pad.flt * 0.86).toFixed(2));
      schemRtFillRef.current?.setAttribute("opacity", (0.14 + pad.frt * 0.86).toFixed(2));

      if (pad.left_trigger > ltPeakRef.current) {
        ltPeakRef.current = pad.left_trigger;
        if (ltPeakMarkRef.current) {
          ltPeakMarkRef.current.style.left = `${((pad.left_trigger / 255) * 100).toFixed(1)}%`;
        }
      }
      if (pad.right_trigger > rtPeakRef.current) {
        rtPeakRef.current = pad.right_trigger;
        if (rtPeakMarkRef.current) {
          rtPeakMarkRef.current.style.left = `${((pad.right_trigger / 255) * 100).toFixed(1)}%`;
        }
      }

      // 4. Digital Buttons (ONLY touched when 16-bit mask changes!)
      if (pad.buttons !== prevButtonsRef.current) {
        prevButtonsRef.current = pad.buttons;
        testedMaskRef.current |= pad.buttons;
        let testedTotal = 0;
        for (let i = 0; i < DIGITAL_BUTTONS.length; i++) {
          const bit = DIGITAL_BUTTONS[i][0];
          const isOn = (pad.buttons & bit) !== 0;
          const isTested = (testedMaskRef.current & bit) !== 0;
          if (isTested) testedTotal += 1;

          const pillEl = btnElsRef.current[i];
          if (pillEl) {
            pillEl.classList.toggle("pressed", isOn);
            pillEl.classList.toggle("tested", isTested && !isOn);
          }
          const svgEl = schemBtnMapRef.current[bit];
          if (svgEl) {
            svgEl.classList.toggle("is-on", isOn);
            svgEl.classList.toggle("is-tested", isTested && !isOn);
          }
        }
        setTextIfChanged(
          testedCountRef.current,
          `已测 ${testedTotal} / ${DIGITAL_BUTTONS.length}`,
        );
      }

      // 5. Polling rate & throttled numeric text readouts (every >=85ms to avoid per-frame text layout)
      pollBenchRef.current.push(pad);
      if (now - lastTextFlushRef.current >= 85) {
        lastTextFlushRef.current = now;
        setTextIfChanged(padNameRef.current, pad.id);

        const rate = pollBenchRef.current.stats();
        setTextIfChanged(
          pollBadgeRef.current,
          rate
            ? `${rate.hz} Hz · 抖动 ${rate.jitterMs.toFixed(1)} ms`
            : "采样率待摇杆移动测算",
        );

        setTextIfChanged(
          leftCoordsRef.current,
          `X ${pad.fx >= 0 ? "+" : ""}${pad.fx.toFixed(3)} · Y ${pad.fy >= 0 ? "+" : ""}${pad.fy.toFixed(3)} (${pad.lx}, ${pad.ly})`,
        );
        setTextIfChanged(
          rightCoordsRef.current,
          `X ${pad.frx >= 0 ? "+" : ""}${pad.frx.toFixed(3)} · Y ${pad.fry >= 0 ? "+" : ""}${pad.fry.toFixed(3)} (${pad.rx}, ${pad.ry})`,
        );

        const lErr = leftBenchRef.current.avgErrorPct;
        setTextIfChanged(
          leftCircValRef.current,
          lErr !== null
            ? `${lErr.toFixed(1)}% (${leftBenchRef.current.coveredCount}/36)`
            : leftBenchRef.current.coveredCount > 0
              ? `采集中 ${leftBenchRef.current.coveredCount}/36`
              : "转满一圈测算",
        );
        const rErr = rightBenchRef.current.avgErrorPct;
        setTextIfChanged(
          rightCircValRef.current,
          rErr !== null
            ? `${rErr.toFixed(1)}% (${rightBenchRef.current.coveredCount}/36)`
            : rightBenchRef.current.coveredCount > 0
              ? `采集中 ${rightBenchRef.current.coveredCount}/36`
              : "转满一圈测算",
        );

        setTextIfChanged(
          leftDriftValRef.current,
          `${leftBenchRef.current.restDriftPct.toFixed(1)}%`,
        );
        setTextIfChanged(
          rightDriftValRef.current,
          `${rightBenchRef.current.restDriftPct.toFixed(1)}%`,
        );

        setTextIfChanged(
          ltValRef.current,
          `${pad.left_trigger} (${Math.round(pad.flt * 100)}%)`,
        );
        setTextIfChanged(
          rtValRef.current,
          `${pad.right_trigger} (${Math.round(pad.frt * 100)}%)`,
        );
        setTextIfChanged(ltPeakTextRef.current, `峰值 ${ltPeakRef.current}`);
        setTextIfChanged(rtPeakTextRef.current, `峰值 ${rtPeakRef.current}`);
      }
    });
  }, []);

  const triggerRumble = (strong: number, weak: number, duration: number) => {
    const act = actuatorRef.current;
    if (!act?.playEffect) return;
    act
      .playEffect("dual-rumble", {
        startDelay: 0,
        duration,
        strongMagnitude: strong,
        weakMagnitude: weak,
      })
      .catch(() => {});
  };

  const stopRumble = () => {
    const act = actuatorRef.current;
    if (act?.reset) {
      act.reset().catch(() => {});
    } else {
      triggerRumble(0, 0, 20);
    }
  };

  const bindSchem = (bit: number) => (el: SVGElement | null) => {
    schemBtnMapRef.current[bit] = el;
  };

  return (
    <div className="tester-page">
      {/* Top Status & Controls Bar */}
      <section className="panel tester-topbar">
        <div className="tester-topbar-left">
          <div className="tester-title-row">
            <Activity size={20} />
            <h2>手柄性能测试台</h2>
            <span className="pill" ref={pollBadgeRef}>
              采样率待摇杆移动测算
            </span>
          </div>
          <small className="tester-device-sub" ref={padNameRef}>
            {activeSlotNum !== null
              ? `槽位 #${activeSlotNum + 1} 已就绪`
              : "等待手柄连接"}
          </small>
        </div>

        <div className="tester-topbar-actions">
          {connectedSlots.length > 1 && (
            <div className="tester-slot-pills" role="group" aria-label="选择手柄槽位">
              {connectedSlots.map((slot) => (
                <button
                  key={slot}
                  type="button"
                  className={activeSlotNum === slot ? "secondary" : "text-button"}
                  onClick={() => onSelectSlot(slot)}
                >
                  P{slot + 1}
                </button>
              ))}
            </div>
          )}
          {activeSlotNum !== null && (
            <button
              type="button"
              className="secondary"
              onClick={resetAllBenchmarks}
            >
              <RotateCcw size={15} />
              重置测试数据
            </button>
          )}
        </div>
      </section>

      {activeSlotNum === null ? (
        <section className="panel empty-small">
          <Gamepad2 size={48} />
          <h3>{isTauri ? "尚未检测到激活的 XInput 手柄" : "尚未检测到激活的手柄"}</h3>
          <p>
            {isTauri
              ? "使用 USB 数据线或 2.4G 接收器连接手柄（XInput 模式），拨动摇杆或按任意键即可开始满帧率实时测试。"
              : "使用 USB 数据线或 2.4G 接收器连接手柄（XInput 模式），按一下任意按键即可在浏览器中唤醒满帧率实时测试。"}
          </p>
        </section>
      ) : (
        <div className="tester-grid">
          {/* Card 1: Dual Stick Circularity & Resting Drift Radar */}
          <section className="panel tester-card tester-sticks-card">
            <div className="section-heading">
              <h2>摇杆 · 圆度与回中漂移</h2>
              <span className="subtle">沿外圈慢转一圈测算圆度误差</span>
            </div>

            <div className="tester-radars-row">
              {/* Left Stick Radar */}
              <div className="tester-radar-col">
                <div className="tester-radar-head">
                  <strong>左摇杆 LS</strong>
                  <code ref={leftCoordsRef}>X +0.000 · Y +0.000 (0, 0)</code>
                </div>
                <svg
                  className="tester-radar-svg"
                  viewBox="0 0 216 216"
                  aria-label="左摇杆圆度与漂移雷达"
                >
                  <circle
                    cx={RADAR_CENTER}
                    cy={RADAR_CENTER}
                    r={RADAR_RADIUS}
                    className="tester-radar-outer"
                  />
                  <circle
                    cx={RADAR_CENTER}
                    cy={RADAR_CENTER}
                    r={RADAR_RADIUS * 0.5}
                    className="tester-radar-mid"
                  />
                  <circle
                    cx={RADAR_CENTER}
                    cy={RADAR_CENTER}
                    r={RADAR_RADIUS * 0.1}
                    className="tester-radar-dz"
                  />
                  <line
                    x1={RADAR_CENTER - RADAR_RADIUS}
                    y1={RADAR_CENTER}
                    x2={RADAR_CENTER + RADAR_RADIUS}
                    y2={RADAR_CENTER}
                    className="tester-radar-axis"
                  />
                  <line
                    x1={RADAR_CENTER}
                    y1={RADAR_CENTER - RADAR_RADIUS}
                    x2={RADAR_CENTER}
                    y2={RADAR_CENTER + RADAR_RADIUS}
                    className="tester-radar-axis"
                  />
                  {RADAR_TICKS.map((tk, i) => (
                    <line
                      key={i}
                      x1={tk.x1}
                      y1={tk.y1}
                      x2={tk.x2}
                      y2={tk.y2}
                      className={
                        tk.major ? "tester-radar-tick major" : "tester-radar-tick"
                      }
                    />
                  ))}
                  {/* 36-Sector Circularity Envelope */}
                  <path ref={leftPolyPathRef} className="tester-circ-poly" />
                  {/* Resting Drift Center Marker */}
                  <g transform={`translate(${RADAR_CENTER}, ${RADAR_CENTER})`}>
                    <circle
                      ref={leftRestCircleRef}
                      cx={0}
                      cy={0}
                      r={3.2}
                      className="tester-rest-dot"
                    />
                  </g>
                  {/* Live Stick Position Dot */}
                  <g transform={`translate(${RADAR_CENTER}, ${RADAR_CENTER})`}>
                    <g ref={leftLiveGroupRef}>
                      <circle cx={0} cy={0} r={10} className="tester-live-halo" />
                      <circle cx={0} cy={0} r={5.2} className="tester-live-dot" />
                    </g>
                  </g>
                </svg>
                <div className="tester-metrics-pair">
                  <div>
                    <span>圆度误差</span>
                    <strong ref={leftCircValRef}>转满一圈测算</strong>
                  </div>
                  <div>
                    <span>松手偏移</span>
                    <strong ref={leftDriftValRef}>0.0%</strong>
                  </div>
                </div>
              </div>

              {/* Right Stick Radar */}
              <div className="tester-radar-col">
                <div className="tester-radar-head">
                  <strong>右摇杆 RS</strong>
                  <code ref={rightCoordsRef}>X +0.000 · Y +0.000 (0, 0)</code>
                </div>
                <svg
                  className="tester-radar-svg"
                  viewBox="0 0 216 216"
                  aria-label="右摇杆圆度与漂移雷达"
                >
                  <circle
                    cx={RADAR_CENTER}
                    cy={RADAR_CENTER}
                    r={RADAR_RADIUS}
                    className="tester-radar-outer"
                  />
                  <circle
                    cx={RADAR_CENTER}
                    cy={RADAR_CENTER}
                    r={RADAR_RADIUS * 0.5}
                    className="tester-radar-mid"
                  />
                  <circle
                    cx={RADAR_CENTER}
                    cy={RADAR_CENTER}
                    r={RADAR_RADIUS * 0.1}
                    className="tester-radar-dz"
                  />
                  <line
                    x1={RADAR_CENTER - RADAR_RADIUS}
                    y1={RADAR_CENTER}
                    x2={RADAR_CENTER + RADAR_RADIUS}
                    y2={RADAR_CENTER}
                    className="tester-radar-axis"
                  />
                  <line
                    x1={RADAR_CENTER}
                    y1={RADAR_CENTER - RADAR_RADIUS}
                    x2={RADAR_CENTER}
                    y2={RADAR_CENTER + RADAR_RADIUS}
                    className="tester-radar-axis"
                  />
                  {RADAR_TICKS.map((tk, i) => (
                    <line
                      key={i}
                      x1={tk.x1}
                      y1={tk.y1}
                      x2={tk.x2}
                      y2={tk.y2}
                      className={
                        tk.major ? "tester-radar-tick major" : "tester-radar-tick"
                      }
                    />
                  ))}
                  <path ref={rightPolyPathRef} className="tester-circ-poly" />
                  <g transform={`translate(${RADAR_CENTER}, ${RADAR_CENTER})`}>
                    <circle
                      ref={rightRestCircleRef}
                      cx={0}
                      cy={0}
                      r={3.2}
                      className="tester-rest-dot"
                    />
                  </g>
                  <g transform={`translate(${RADAR_CENTER}, ${RADAR_CENTER})`}>
                    <g ref={rightLiveGroupRef}>
                      <circle cx={0} cy={0} r={10} className="tester-live-halo" />
                      <circle cx={0} cy={0} r={5.2} className="tester-live-dot" />
                    </g>
                  </g>
                </svg>
                <div className="tester-metrics-pair">
                  <div>
                    <span>圆度误差</span>
                    <strong ref={rightCircValRef}>转满一圈测算</strong>
                  </div>
                  <div>
                    <span>松手偏移</span>
                    <strong ref={rightDriftValRef}>0.0%</strong>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Card 2: Interactive Schematic, Triggers & Tested Button Matrix */}
          <div className="tester-right-stack">
            {/* Triggers + Vibration */}
            <section className="panel tester-card">
              <div className="section-heading">
                <h2>扳机压感与行程峰值</h2>
                <span className="subtle">0 – 255 线性级数</span>
              </div>
              <div className="tester-triggers-list">
                <div className="tester-trig-item">
                  <div className="tester-trig-head">
                    <strong>LT 左扳机</strong>
                    <div>
                      <code ref={ltValRef}>0 (0%)</code>
                      <small ref={ltPeakTextRef}>峰值 0</small>
                    </div>
                  </div>
                  <div className="tester-trig-track">
                    <div ref={ltFillRef} className="tester-trig-fill" />
                    <span ref={ltPeakMarkRef} className="tester-trig-peak" />
                  </div>
                </div>

                <div className="tester-trig-item">
                  <div className="tester-trig-head">
                    <strong>RT 右扳机</strong>
                    <div>
                      <code ref={rtValRef}>0 (0%)</code>
                      <small ref={rtPeakTextRef}>峰值 0</small>
                    </div>
                  </div>
                  <div className="tester-trig-track">
                    <div ref={rtFillRef} className="tester-trig-fill" />
                    <span ref={rtPeakMarkRef} className="tester-trig-peak" />
                  </div>
                </div>
              </div>

              {hasRumble && (
                <div className="tester-rumble-row">
                  <span className="tester-rumble-label">
                    <Vibrate size={15} />
                    马达震动实测
                  </span>
                  <div className="tester-rumble-btns">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => triggerRumble(0.25, 0.45, 320)}
                    >
                      轻震
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => triggerRumble(1.0, 1.0, 480)}
                    >
                      重震
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => triggerRumble(0.8, 0.2, 200)}
                    >
                      脉冲
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={stopRumble}
                    >
                      停止
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* Front Schematic + Button Matrix */}
            <section className="panel tester-card">
              <div className="section-heading">
                <h2>全按键触发与留痕检测</h2>
                <span className="pill" ref={testedCountRef}>
                  已测 0 / {DIGITAL_BUTTONS.length}
                </span>
              </div>

              <div className="tester-pad-visual">
                <svg
                  className="tester-front-svg"
                  viewBox="0 0 360 206"
                  aria-hidden="true"
                >
                  {/* LT / RT Triggers */}
                  <rect
                    ref={schemLtFillRef}
                    x={74}
                    y={8}
                    width={52}
                    height={14}
                    rx={6}
                    opacity={0.14}
                    className="schem-trig"
                  />
                  <rect
                    ref={schemRtFillRef}
                    x={234}
                    y={8}
                    width={52}
                    height={14}
                    rx={6}
                    opacity={0.14}
                    className="schem-trig"
                  />
                  {/* LB / RB Bumpers */}
                  <rect
                    ref={bindSchem(0x0100)}
                    x={64}
                    y={24}
                    width={68}
                    height={14}
                    rx={7}
                    className="schem-node"
                  />
                  <rect
                    ref={bindSchem(0x0200)}
                    x={228}
                    y={24}
                    width={68}
                    height={14}
                    rx={7}
                    className="schem-node"
                  />
                  {/* Controller Body Outline */}
                  <path
                    d="M84 38 H276 C306 38 326 64 334 114 C340 152 332 188 308 194 C288 198 272 174 252 152 H108 C88 174 72 198 52 194 C28 188 20 152 26 114 C34 64 54 38 84 38 Z"
                    className="schem-shell"
                  />
                  {/* Back / Start */}
                  <rect
                    ref={bindSchem(0x0020)}
                    x={146}
                    y={68}
                    width={20}
                    height={11}
                    rx={5.5}
                    className="schem-node"
                  />
                  <rect
                    ref={bindSchem(0x0010)}
                    x={194}
                    y={68}
                    width={20}
                    height={11}
                    rx={5.5}
                    className="schem-node"
                  />
                  {/* Left Stick + L3 */}
                  <circle cx={104} cy={82} r={24} className="schem-well" />
                  <g transform="translate(104, 82)">
                    <g ref={schemLeftCapRef}>
                      <circle
                        ref={bindSchem(0x0040)}
                        cx={0}
                        cy={0}
                        r={14}
                        className="schem-node schem-cap"
                      />
                    </g>
                  </g>
                  {/* D-Pad */}
                  <rect
                    ref={bindSchem(0x0001)}
                    x={130}
                    y={108}
                    width={14}
                    height={15}
                    rx={3}
                    className="schem-node"
                  />
                  <rect
                    ref={bindSchem(0x0002)}
                    x={130}
                    y={135}
                    width={14}
                    height={15}
                    rx={3}
                    className="schem-node"
                  />
                  <rect
                    ref={bindSchem(0x0004)}
                    x={116}
                    y={122}
                    width={15}
                    height={13}
                    rx={3}
                    className="schem-node"
                  />
                  <rect
                    ref={bindSchem(0x0008)}
                    x={143}
                    y={122}
                    width={15}
                    height={13}
                    rx={3}
                    className="schem-node"
                  />
                  {/* Right Stick + R3 */}
                  <circle cx={218} cy={128} r={24} className="schem-well" />
                  <g transform="translate(218, 128)">
                    <g ref={schemRightCapRef}>
                      <circle
                        ref={bindSchem(0x0080)}
                        cx={0}
                        cy={0}
                        r={14}
                        className="schem-node schem-cap"
                      />
                    </g>
                  </g>
                  {/* ABXY */}
                  <circle
                    ref={bindSchem(0x8000)}
                    cx={266}
                    cy={62}
                    r={10.5}
                    className="schem-node"
                  />
                  <circle
                    ref={bindSchem(0x2000)}
                    cx={286}
                    cy={82}
                    r={10.5}
                    className="schem-node"
                  />
                  <circle
                    ref={bindSchem(0x4000)}
                    cx={246}
                    cy={82}
                    r={10.5}
                    className="schem-node"
                  />
                  <circle
                    ref={bindSchem(0x1000)}
                    cx={266}
                    cy={102}
                    r={10.5}
                    className="schem-node"
                  />
                </svg>
              </div>

              <div className="input-buttons tester-buttons">
                {DIGITAL_BUTTONS.map(([, name], idx) => (
                  <span
                    key={name}
                    ref={(el) => {
                      btnElsRef.current[idx] = el;
                    }}
                  >
                    {name}
                  </span>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
