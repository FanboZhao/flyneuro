export type Behavior = "forage" | "patrol" | "track"
export type ControllerMode = "strict" | "embodied"
export type FlightPhase = "grounded" | "takeoff" | "cruise" | "landing"
export type TrialStage = "grounded" | "takeoff" | "forest" | "approach" | "landing" | "success"
export type CollisionKind =
  | "rock"
  | "log"
  | "mushroom"
  | "fruit"
  | "water"
  | "pillar"
  | "tree"
  | "flower"
  | "boundary"
export type CollisionStatus = { active: boolean; kind: CollisionKind | "clear" }
export type EyeFrames = {
  luminanceLeft: Float32Array
  luminanceRight: Float32Array
  sampledAt: number
}
export type VisualEffect = { yawRate: number; headingChange: number; heightOffset: number }
export type CnsMotor = {
  turn: number
  forward: number
  forwardHz: number
  backwardHz: number
  turnLHz: number
  turnRHz: number
  takeoffHz: number
  flightHz: number
  wingPowerHz: number
}
export type FlyvisActivity = {
  selected: string
  left: Float32Array
  right: Float32Array
  flow: Float32Array
  selectedMean: number
  yaw: number
  lift: number
  directional: Record<string, [number, number]>
  stepCount: number
  frameAgeMs: number
}
export type VisionStatus = "loading" | "ready" | "error"
export type OlfactionActivity = {
  left: number
  right: number
  leftHz: number
  rightHz: number
  windLeftHz: number
  windRightHz: number
  wind: [number, number, number]
  gradient: [number, number]
  field: number
  proximity: number
}
export type SensoryPoolSizes = {
  odorLeft: number
  odorRight: number
  windLeft: number
  windRight: number
}
export type CnsMetrics = {
  status: "idle" | "loading" | "ready" | "error"
  message?: string
  modelTimeMs: number
  spikesPerSecond: number
  active: number
  regions: [number, number, number]
  motor: CnsMotor | null
  sensoryPools?: SensoryPoolSizes
}

export type CircleCollider = {
  x: number
  z: number
  radius: number
  height: number
  kind: Exclude<CollisionKind, "log" | "boundary">
}

export type CapsuleCollider = {
  ax: number
  az: number
  bx: number
  bz: number
  radius: number
  height: number
  kind: "log"
}

export type ModelContext = {
  registerTool: (
    tool: {
      name: string
      title: string
      description: string
      inputSchema: object
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }
      execute: (input: unknown) => Promise<unknown>
    },
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>
}
