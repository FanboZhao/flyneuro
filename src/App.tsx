import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Activity,
  Aperture,
  BrainCircuit,
  Eye,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  Wind,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { WorldCanvas } from "@/simulation/WorldCanvas"
import { WholeBrainCanvas } from "@/components/WholeBrainCanvas"
import { EyeImage, RetinaMap, TraceChart, Metric } from "@/components/ActivityPanels"
import { CELL_TYPES, HEX_COORDS, TRIAL_STAGES } from "@/simulation/constants"
import type {
  Behavior,
  ControllerMode,
  FlightPhase,
  TrialStage,
  CollisionStatus,
  EyeFrames,
  VisualEffect,
  FlyvisActivity,
  VisionStatus,
  OlfactionActivity,
  CnsMetrics,
  ModelContext,
} from "@/simulation/types"

export default function App() {
  const [running, setRunning] = useState(true)
  const [speed, setSpeed] = useState(1)
  const behavior: Behavior = "forage"
  const controllerMode: ControllerMode = "embodied"
  const visualControl = true
  const [cellType, setCellType] = useState("T4a")
  const [simTime, setSimTime] = useState(0)
  const [bodyHeight, setBodyHeight] = useState(0.62)
  const [collision, setCollision] = useState<CollisionStatus>({ active: false, kind: "clear" })
  const [flightPhase, setFlightPhase] = useState<FlightPhase>("grounded")
  const [trialStage, setTrialStage] = useState<TrialStage>("grounded")
  const [resetToken, setResetToken] = useState(0)
  const [visualEffect, setVisualEffect] = useState<VisualEffect>({
    yawRate: 0,
    headingChange: 0,
    heightOffset: 0,
  })
  const [eyeFrames, setEyeFrames] = useState<EyeFrames | null>(null)
  const [flyvis, setFlyvis] = useState<FlyvisActivity | null>(null)
  const [olfaction, setOlfaction] = useState<OlfactionActivity>({
    left: 0,
    right: 0,
    leftHz: 0,
    rightHz: 0,
    windLeftHz: 0,
    windRightHz: 0,
    wind: [0.035, -0.015, -0.58],
    gradient: [0, 0],
    field: 0,
    proximity: 0,
  })
  const [visionStatus, setVisionStatus] = useState<VisionStatus>("loading")
  const [trace, setTrace] = useState<Array<[number, number, number]>>([])
  const [odorTrace, setOdorTrace] = useState<Array<[number, number, number]>>([])
  const [activeTab, setActiveTab] = useState("vision")
  const [cnsEverOpened, setCnsEverOpened] = useState(false)
  const [cnsMetrics, setCnsMetrics] = useState<CnsMetrics>({
    status: "idle",
    modelTimeMs: 0,
    spikesPerSecond: 0,
    active: 0,
    regions: [0, 0, 0],
    motor: null,
  })
  const simulationRef = useRef({ running, speed })
  useEffect(() => {
    simulationRef.current = { running, speed }
  }, [running, speed])
  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext }).modelContext
    if (!context?.registerTool) return
    const lifecycle = new AbortController()
    const register = context.registerTool(
      {
        name: "control_fly_simulation",
        title: "Control autonomous fly simulation",
        description:
          "Pause, resume, reset, or change the speed of the single autonomous odor-seeking forest task.",
        inputSchema: {
          type: "object",
          properties: {
            speed: { type: "number", minimum: 0.25, maximum: 2 },
            running: { type: "boolean" },
            reset: { type: "boolean" },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        async execute(input) {
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw new Error("Input must be an object.")
          const value = input as Record<string, unknown>
          if (
            value.speed !== undefined &&
            (typeof value.speed !== "number" || value.speed < 0.25 || value.speed > 2)
          )
            throw new Error("Speed must be between 0.25 and 2.")
          if (value.running !== undefined && typeof value.running !== "boolean")
            throw new Error("Running must be boolean.")
          if (value.reset !== undefined && typeof value.reset !== "boolean")
            throw new Error("Reset must be boolean.")
          const next = {
            ...simulationRef.current,
            ...(value.speed === undefined ? {} : { speed: value.speed }),
            ...(value.running === undefined ? {} : { running: value.running }),
          }
          simulationRef.current = next
          setSpeed(next.speed)
          setRunning(next.running)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          if (value.reset === true) setResetToken((token) => token + 1)
          return {
            task: "autonomous_odor_forest",
            controllerMode: "embodied",
            speed: next.speed,
            running: next.running,
            reset: value.reset === true,
          }
        },
      },
      { signal: lifecycle.signal },
    )
    void Promise.resolve(register).catch((error) =>
      console.warn("WebMCP registration failed", error),
    )
    return () => lifecycle.abort()
  }, [])
  const handleFlyvis = useCallback((activity: FlyvisActivity) => {
    setFlyvis(activity)
    setTrace((previous) => [
      ...previous.slice(-57),
      [Math.tanh(activity.selectedMean * 0.4), activity.yaw, activity.lift],
    ])
  }, [])
  const handleOlfaction = useCallback((activity: OlfactionActivity) => {
    setOlfaction(activity)
    setOdorTrace((previous) => [
      ...previous.slice(-57),
      [
        Math.min(1, activity.left * 1.6),
        Math.min(1, activity.right * 1.6),
        Math.max(-1, Math.min(1, (activity.windRightHz - activity.windLeftHz) / 60)),
      ],
    ])
  }, [])
  const selected = CELL_TYPES.find((cell) => cell.id === cellType) ?? CELL_TYPES[5]
  const emptyEye = useMemo(() => new Float32Array(HEX_COORDS.length), [])
  const leftEye = eyeFrames?.luminanceLeft ?? emptyEye
  const rightEye = eyeFrames?.luminanceRight ?? emptyEye
  const neural = useMemo(() => {
    if (!flyvis || flyvis.selected !== cellType) return emptyEye
    return Float32Array.from(flyvis.left, (value, index) =>
      Math.max(0, Math.min(1, 0.5 + (value + flyvis.right[index]) * 0.35)),
    )
  }, [flyvis, cellType, emptyEye])
  const direction = (visualEffect.yawRate * 180) / Math.PI
  const activity = flyvis?.selectedMean ?? 0
  const stageIndex = TRIAL_STAGES.findIndex((stage) => stage.id === trialStage)
  const reset = useCallback(() => {
    setSimTime(0)
    setTrace([])
    setOdorTrace([])
    setRunning(true)
    setTrialStage("grounded")
    setVisualEffect({ yawRate: 0, headingChange: 0, heightOffset: 0 })
    setResetToken((value) => value + 1)
  }, [])
  const enterFullscreen = useCallback(() => {
    document.documentElement.requestFullscreen?.()
  }, [])

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand-lockup" href="https://zhaofanbo.com/" title="返回赵凡博的个人网站">
          <div className="brand-mark" aria-hidden="true">
            <Eye size={19} />
          </div>
          <div className="brand-title">
            FLY<span>NEURO</span>
          </div>
        </a>
        <div className="topbar-status" aria-label="仿真状态">
          <span
            className={`live-dot ${running && cnsMetrics.status === "ready" ? "is-live" : ""}`}
          />
          <strong>
            {cnsMetrics.status === "error"
              ? "CNS 异常"
              : cnsMetrics.status !== "ready"
                ? "CNS 加载中"
                : running
                  ? "自动飞行"
                  : "已暂停"}
          </strong>
        </div>
        <div className="topbar-actions">
          <Button variant="ghost" size="icon-sm" onClick={reset} aria-label="重置仿真">
            <RotateCcw />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={enterFullscreen} aria-label="全屏">
            <Maximize2 />
          </Button>
        </div>
      </header>

      <section className="control-strip" aria-label="仿真控制">
        <Button className="run-button" onClick={() => setRunning((value) => !value)}>
          {running ? <Pause /> : <Play />}
          {running ? "暂停" : "继续"}
        </Button>
        <div className="mission-status">
          <span>林间寻香</span>
          <strong>{TRIAL_STAGES[stageIndex]?.label ?? "叶面待机"}</strong>
          <div
            className="mission-progress"
            aria-label={`任务进度：${TRIAL_STAGES[stageIndex]?.label ?? "叶面待机"}`}
          >
            {TRIAL_STAGES.map((stage, index) => (
              <i key={stage.id} className={index <= stageIndex ? "is-active" : ""} />
            ))}
          </div>
        </div>
        <div className="control-group speed-control">
          <span>
            速度 <strong>{speed.toFixed(1)}×</strong>
          </span>
          <Slider
            aria-label="仿真速度"
            min={0.25}
            max={2}
            step={0.25}
            value={[speed]}
            onValueChange={(value) => setSpeed(value[0])}
          />
        </div>
        <div className="sim-clock">
          <span>仿真时间 · 高度 {bodyHeight.toFixed(1)} m</span>
          <strong>{simTime.toFixed(1)} s</strong>
        </div>
      </section>

      <div className="workspace">
        <section className="world-panel panel">
          <WorldCanvas
            running={running}
            speed={speed}
            behavior={behavior}
            controllerMode={controllerMode}
            resetToken={resetToken}
            cellType={cellType}
            visualControl={visualControl}
            onCollision={setCollision}
            onFlightPhase={setFlightPhase}
            onTrialStage={setTrialStage}
            onOlfaction={handleOlfaction}
            onEyeFrames={setEyeFrames}
            onFlyvis={handleFlyvis}
            onVisionStatus={setVisionStatus}
            onSimulationTime={setSimTime}
            onBodyHeight={setBodyHeight}
            onVisualEffect={setVisualEffect}
            onCnsMetrics={setCnsMetrics}
          />
          <div className="world-vignette" />
          <div
            className={`world-hud ${collision.active ? "is-contact" : ""}`}
            aria-label={`飞行状态：${flightPhase}；碰撞：${collision.active ? collision.kind : "无"}`}
          >
            <strong>
              {collision.active
                ? `接触 · ${collision.kind}`
                : flightPhase === "grounded"
                  ? "停驻"
                  : flightPhase === "takeoff"
                    ? "起飞"
                    : flightPhase === "landing"
                      ? "降落"
                      : "巡航"}
            </strong>
            <span>
              {cnsMetrics.status === "ready"
                ? `DN 转向 ${direction.toFixed(1)}°/s · 飞行 ${cnsMetrics.motor?.flightHz.toFixed(0) ?? "0"} Hz`
                : cnsMetrics.status === "error"
                  ? "CNS 运行失败"
                  : "CNS 加载中"}
            </span>
          </div>
        </section>

        <aside className="data-panel panel">
          <Tabs
            value={activeTab}
            onValueChange={(value) => {
              setActiveTab(value)
              if (value === "cns") setCnsEverOpened(true)
            }}
            className="h-full"
          >
            <TabsList variant="line" className="data-tabs four-tabs">
              <TabsTrigger value="vision">
                <Aperture />
                复眼
              </TabsTrigger>
              <TabsTrigger value="flyvis">
                <Activity />
                Flyvis
              </TabsTrigger>
              <TabsTrigger value="olfaction">
                <Wind />
                嗅觉
              </TabsTrigger>
              <TabsTrigger value="cns">
                <BrainCircuit />
                CNS
              </TabsTrigger>
            </TabsList>
            <TabsContent value="vision" className="tab-scroll">
              <section className="panel-section">
                <div className="section-heading">
                  <div>
                    <span>SCENE → COMPOUND EYES</span>
                    <strong>果蝇的双眼画面</strong>
                  </div>
                  <span className="provenance derived">
                    {visionStatus === "ready"
                      ? "实时"
                      : visionStatus === "error"
                        ? "异常"
                        : "加载中"}
                  </span>
                </div>
                <div className="eye-grid">
                  <EyeImage side="left" label="左眼" />
                  <EyeImage side="right" label="右眼" />
                </div>
                <p className="microcopy">两台头部相机看到的树林与花朵，经复眼采样后送入 FlyVis。</p>
                <div className="eye-grid hex-input-grid">
                  <RetinaMap values={leftEye} accent="#b8e878" label="左眼 · 721" />
                  <RetinaMap values={rightEye} accent="#77d9d2" label="右眼 · 721" />
                </div>
              </section>
            </TabsContent>
            <TabsContent value="flyvis" className="tab-scroll">
              <section className="panel-section">
                <div className="section-heading">
                  <div>
                    <span>FLYVIS ACTIVITY</span>
                    <strong>视觉神经活动</strong>
                  </div>
                  <span className="provenance learned">模型</span>
                </div>
                <div className="cell-type-row" role="list" aria-label="视觉细胞类型">
                  {CELL_TYPES.map((cell) => (
                    <button
                      key={cell.id}
                      role="listitem"
                      className={cellType === cell.id ? "active" : ""}
                      onClick={() => setCellType(cell.id)}
                      style={{ "--cell-color": cell.color } as React.CSSProperties}
                    >
                      <i />
                      <strong>{cell.id}</strong>
                      <span>{cell.stage}</span>
                    </button>
                  ))}
                </div>
                <div className="neural-map-wrap">
                  <RetinaMap
                    values={neural}
                    accent={selected.color}
                    label={`${selected.id} · 活动变化`}
                  />
                  <div className="neural-readout">
                    <span>相对灰场均值</span>
                    <strong style={{ color: selected.color }}>{activity.toFixed(3)}</strong>
                    <i
                      style={{
                        width: `${Math.min(100, Math.abs(activity) * 25)}%`,
                        backgroundColor: selected.color,
                      }}
                    />
                  </div>
                </div>
                <p className="microcopy">
                  每眼 45,669 个模型单元；颜色表示相对中性灰输入的活动变化。
                </p>
              </section>
              <section className="panel-section">
                <div className="section-heading compact">
                  <div>
                    <span>ACTIVITY TRACE</span>
                    <strong>{selected.id} 与运动通道</strong>
                  </div>
                  <span className="trace-time">最近 5.8 s</span>
                </div>
                <TraceChart samples={trace} color={selected.color} />
                <div className="trace-legend">
                  <span>
                    <i style={{ background: selected.color }} />
                    {selected.id}
                  </span>
                  <span>
                    <i className="cyan" />
                    T4/T5 转向
                  </span>
                  <span>
                    <i className="amber" />
                    T4/T5 升降
                  </span>
                </div>
                <p className="microcopy">FlyVis 活动是视觉读数；身体转向来自 CNS 下降神经元。</p>
              </section>
            </TabsContent>
            <TabsContent value="olfaction" className="tab-scroll">
              <section className="panel-section">
                <div className="section-heading">
                  <div>
                    <span>ODOR INPUT</span>
                    <strong>左右触角</strong>
                  </div>
                  <span className="provenance learned">4 个花源</span>
                </div>
                <div className="antenna-grid">
                  <div>
                    <span>左触角</span>
                    <strong>{olfaction.leftHz.toFixed(1)} Hz</strong>
                    <i>
                      <b style={{ width: `${Math.min(100, olfaction.leftHz / 1.2)}%` }} />
                    </i>
                    <small>浓度 {olfaction.left.toFixed(3)}</small>
                  </div>
                  <div>
                    <span>右触角</span>
                    <strong>{olfaction.rightHz.toFixed(1)} Hz</strong>
                    <i>
                      <b style={{ width: `${Math.min(100, olfaction.rightHz / 1.2)}%` }} />
                    </i>
                    <small>浓度 {olfaction.right.toFixed(3)}</small>
                  </div>
                </div>
                <TraceChart samples={odorTrace} color="#f0b56e" />
                <div className="trace-legend">
                  <span>
                    <i style={{ background: "#f0b56e" }} />
                    左侧浓度
                  </span>
                  <span>
                    <i className="cyan" />
                    右侧浓度
                  </span>
                  <span>
                    <i className="amber" />
                    风向差
                  </span>
                </div>
                <div className="mini-metrics">
                  <Metric label="平滑浓度" value={olfaction.field.toFixed(3)} />
                  <Metric label="近源信号" value={olfaction.proximity.toFixed(3)} />
                  <Metric
                    label="梯度"
                    value={Math.hypot(...olfaction.gradient).toFixed(3)}
                    accent="#b8df72"
                  />
                </div>
                <p className="microcopy">花香不可见；触角读数随气团起伏，平滑浓度显示底层梯度。</p>
              </section>
              <section className="panel-section">
                <div className="section-heading compact">
                  <div>
                    <span>WIND INPUT</span>
                    <strong>相对风向</strong>
                  </div>
                  <Wind size={17} />
                </div>
                <div className="mini-metrics">
                  <Metric label="JO 左" value={olfaction.windLeftHz.toFixed(1)} unit="Hz" />
                  <Metric label="JO 右" value={olfaction.windRightHz.toFixed(1)} unit="Hz" />
                  <Metric
                    label="风速"
                    value={Math.hypot(
                      olfaction.wind[0],
                      olfaction.wind[1],
                      olfaction.wind[2],
                    ).toFixed(2)}
                    unit="m/s"
                    accent="#77d9d2"
                  />
                </div>
                <p className="microcopy">
                  触角的气味与风向信号进入 CNS；近源气味梯度帮助对准花盘。
                </p>
              </section>
            </TabsContent>
            <TabsContent
              value="cns"
              forceMount={cnsEverOpened ? true : undefined}
              className="tab-scroll"
            >
              <section className="panel-section cns-section">
                <div className="section-heading">
                  <div>
                    <span>WHOLE CNS</span>
                    <strong>全脑神经活动 · 165,122 个神经元</strong>
                  </div>
                  <span className="provenance learned">
                    {cnsMetrics.status === "ready"
                      ? "实时"
                      : cnsMetrics.status === "error"
                        ? "异常"
                        : "加载中"}
                  </span>
                </div>
                {cnsEverOpened && (
                  <WholeBrainCanvas
                    running={running}
                    active={activeTab === "cns"}
                    metrics={cnsMetrics}
                  />
                )}
                <div className="brain-stat-grid">
                  <Metric
                    label="活跃神经元"
                    value={cnsMetrics.status === "ready" ? cnsMetrics.active.toLocaleString() : "—"}
                    accent="#b8df72"
                  />
                  <Metric
                    label="脉冲 / 神经秒"
                    value={
                      cnsMetrics.status === "ready"
                        ? cnsMetrics.spikesPerSecond.toLocaleString()
                        : "—"
                    }
                  />
                  <Metric
                    label="神经模型时间"
                    value={
                      cnsMetrics.status === "ready"
                        ? (cnsMetrics.modelTimeMs / 1000).toFixed(2)
                        : "—"
                    }
                    unit="s"
                    accent="#f0b56e"
                  />
                </div>
                <div className="brain-region-legend">
                  <span>
                    <i className="optic-region" />
                    视叶 {cnsMetrics.regions[0].toLocaleString()}/s
                  </span>
                  <span>
                    <i className="central-region" />
                    中央脑 {cnsMetrics.regions[1].toLocaleString()}/s
                  </span>
                  <span>
                    <i className="motor-region" />
                    下降神经元 / VNC {cnsMetrics.regions[2].toLocaleString()}/s
                  </span>
                </div>
                <div className="brain-motor-readout">
                  <span>
                    转向 DN 左 / 右{" "}
                    <strong>
                      {cnsMetrics.motor?.turnLHz.toFixed(1) ?? "—"} /{" "}
                      {cnsMetrics.motor?.turnRHz.toFixed(1) ?? "—"} Hz
                    </strong>
                  </span>
                  <span>
                    起飞 / 飞行 DN{" "}
                    <strong>
                      {cnsMetrics.motor?.takeoffHz.toFixed(1) ?? "—"} /{" "}
                      {cnsMetrics.motor?.flightHz.toFixed(1) ?? "—"} Hz
                    </strong>
                  </span>
                  <span>
                    翅肌 MN（监测）
                    <strong>{cnsMetrics.motor?.wingPowerHz.toFixed(1) ?? "—"} Hz</strong>
                  </span>
                </div>
                <details className="model-details">
                  <summary>模型边界与导航说明</summary>
                  <p>
                    局部气味梯度、双触角差、相对风和碰撞被人工导航策略转换为 CNS
                    输入；转向、前进与飞行由 CNS
                    发放驱动，近花刹停由低层执行器完成。执行器不读取花朵坐标。身体使用 FlyBody
                    外形和浏览器动力学代理，并非 MuJoCo，也不是经过验证的果蝇行为预测器。
                  </p>
                </details>
              </section>
            </TabsContent>
          </Tabs>
        </aside>
      </div>
    </main>
  )
}
