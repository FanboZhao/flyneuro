"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
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
import { decodeFlyBrainNeurons } from "@/lib/fly-brain-codec"

type Behavior = "forage" | "patrol" | "track"
type ControllerMode = "strict" | "embodied"
type FlightPhase = "grounded" | "takeoff" | "cruise" | "landing"
type TrialStage = "grounded" | "takeoff" | "forest" | "approach" | "landing" | "success"
type CollisionKind = "rock" | "log" | "mushroom" | "fruit" | "water" | "pillar" | "tree" | "flower" | "boundary"
type CollisionStatus = { active: boolean; kind: CollisionKind | "clear" }
type EyeFrames = { luminanceLeft: Float32Array; luminanceRight: Float32Array; sampledAt: number }
type VisualEffect = { yawRate: number; headingChange: number; heightOffset: number }
type CnsMotor = { turn: number; forward: number; forwardHz: number; backwardHz: number; turnLHz: number; turnRHz: number; takeoffHz: number; flightHz: number; wingPowerHz: number }
type FlyvisActivity = {
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
type VisionStatus = "loading" | "ready" | "error"
type OlfactionActivity = { left: number; right: number; leftHz: number; rightHz: number; windLeftHz: number; windRightHz: number; wind: [number, number, number]; gradient: [number, number]; field: number; proximity: number }
type SensoryPoolSizes = { odorLeft: number; odorRight: number; windLeft: number; windRight: number }
type CnsMetrics = { status: "idle" | "loading" | "ready" | "error"; message?: string; modelTimeMs: number; spikesPerSecond: number; active: number; regions: [number, number, number]; motor: CnsMotor | null; sensoryPools?: SensoryPoolSizes }

type CircleCollider = {
  x: number
  z: number
  radius: number
  height: number
  kind: Exclude<CollisionKind, "log" | "boundary">
}

type CapsuleCollider = {
  ax: number
  az: number
  bx: number
  bz: number
  radius: number
  height: number
  kind: "log"
}

type ModelContext = {
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

const HEX_RADIUS = 15
// The rendered FlyBody wings reach about 0.97 scene units from the body centre
// over a full beat. Keep a small margin around their swept horizontal envelope.
const FLY_WING_SWEEP_RADIUS = 1.04
const TREE_COLLIDER_MARGIN = 0.1
const TREE_PASSAGE_MARGIN = 0.16
// Offscreen WebGL targets return linear RGB bytes. Convert them before both
// displaying the eye images and sampling the same image for FlyVis.
const LINEAR_TO_SRGB_BYTES = Uint8Array.from({ length: 256 }, (_, byte) => {
  const linear = byte / 255
  return Math.round(255 * (linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055))
})
const HEX_COORDS = (() => {
  const coords: Array<[number, number]> = []
  for (let q = -HEX_RADIUS; q <= HEX_RADIUS; q += 1) {
    const rMin = Math.max(-HEX_RADIUS, -q - HEX_RADIUS)
    const rMax = Math.min(HEX_RADIUS, -q + HEX_RADIUS)
    for (let r = rMin; r <= rMax; r += 1) coords.push([q, r])
  }
  return coords
})()

const CELL_TYPES = [
  { id: "R1–6", stage: "Photoreceptor", color: "#f6df72" },
  { id: "L1", stage: "Lamina · ON", color: "#7de4bb" },
  { id: "L2", stage: "Lamina · OFF", color: "#55cfe2" },
  { id: "Mi1", stage: "Medulla", color: "#c4ed82" },
  { id: "Tm3", stage: "Medulla", color: "#ffb86d" },
  { id: "T4a", stage: "Motion · F→B", color: "#ff7f6a" },
  { id: "T4b", stage: "Motion · B→F", color: "#d688ff" },
  { id: "T5a", stage: "OFF motion", color: "#ff5ea8" },
]

const SCENTED_FLOWERS = [
  { x: 0, z: 13.2, color: 0xf16d88 },
  { x: -6.8, z: 9.2, color: 0xd98fe8 },
  { x: 6.6, z: 7, color: 0xf49c5f },
  { x: -6.1, z: 1, color: 0xe8d266 },
] as const

const TRIAL_STAGES: Array<{ id: TrialStage; label: string }> = [
  { id: "grounded", label: "叶面待机" }, { id: "takeoff", label: "感觉触发起飞" },
  { id: "forest", label: "林间穿越" }, { id: "approach", label: "气味源接近" },
  { id: "landing", label: "花盘降落" }, { id: "success", label: "稳定接触" },
]

// Calibrated against the FlyBody joint-local axes. These offsets keep every
// claw below the thorax during flight; left/right values differ because the
// source model mirrors joint frames rather than joint-angle signs.
const FLIGHT_LEG_FOLD = {
  1: {
    left: { coxaZ: -0.52, coxaX: 0.14, femurX: -0.78, tibiaX: -0.5 },
    right: { coxaZ: -0.7, coxaX: -0.02, femurX: -0.84, tibiaX: -0.48 },
  },
  2: {
    left: { coxaZ: 0.01, coxaX: 0.33, femurX: -1.15, tibiaX: -1.06 },
    right: { coxaZ: -0.14, coxaX: 0.42, femurX: -1.06, tibiaX: -1.08 },
  },
  3: {
    left: { coxaZ: -0.17, coxaX: 0.5, femurX: -1.17, tibiaX: -1.18 },
    right: { coxaZ: -0.13, coxaX: 0.6, femurX: -1.09, tibiaX: -1.21 },
  },
} as const

function seeded(index: number, seed = 1) {
  const value = Math.sin(index * 91.73 + seed * 37.19) * 43758.5453
  return value - Math.floor(value)
}

function makeStem(color = 0x315e39) {
  return new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.05, 0.7, 7),
    new THREE.MeshStandardMaterial({ color, roughness: 0.9 }),
  )
}

function makeLeaf(color = 0x4d8a48) {
  const leaf = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 9, 6),
    new THREE.MeshStandardMaterial({ color, roughness: 0.95 }),
  )
  leaf.scale.set(0.45, 0.08, 1.1)
  return leaf
}

function addFlower(scene: THREE.Scene, x: number, z: number, hue: number, scale: number) {
  const group = new THREE.Group()
  const stem = makeStem(0x315e39)
  stem.scale.y = scale
  stem.position.y = 0.35 * scale
  group.add(stem)
  const center = new THREE.Mesh(
    new THREE.SphereGeometry(0.11 * scale, 12, 8),
    new THREE.MeshStandardMaterial({ color: 0xf8c85b, emissive: 0x3a2100, emissiveIntensity: 0.25 }),
  )
  center.position.y = 0.72 * scale
  group.add(center)
  const petalMaterial = new THREE.MeshStandardMaterial({ color: hue, roughness: 0.8 })
  for (let i = 0; i < 7; i += 1) {
    const a = (i / 7) * Math.PI * 2
    const petal = new THREE.Mesh(new THREE.SphereGeometry(0.11 * scale, 9, 6), petalMaterial)
    petal.scale.set(1.35, 0.35, 0.75)
    petal.position.set(Math.cos(a) * 0.17 * scale, 0.72 * scale, Math.sin(a) * 0.17 * scale)
    petal.rotation.y = -a
    group.add(petal)
  }
  group.position.set(x, 0, z)
  group.rotation.y = seeded(Math.round(x * 20 + z * 11), 2) * Math.PI
  scene.add(group)
  return group
}

function addPlant(scene: THREE.Scene, x: number, z: number, scale: number, seed: number) {
  const group = new THREE.Group()
  const stems = 3 + Math.floor(seeded(seed, 9) * 4)
  for (let i = 0; i < stems; i += 1) {
    const angle = (i / stems) * Math.PI * 2 + seeded(seed + i, 3)
    const stem = makeStem(i % 2 ? 0x3d7442 : 0x2d5f38)
    stem.scale.set(0.7, scale * (0.65 + seeded(seed + i, 5) * 0.55), 0.7)
    stem.position.set(Math.cos(angle) * 0.11, 0.3 * stem.scale.y, Math.sin(angle) * 0.11)
    stem.rotation.z = Math.cos(angle) * 0.14
    stem.rotation.x = Math.sin(angle) * 0.14
    group.add(stem)
    const leaf = makeLeaf(i % 2 ? 0x4b8a45 : 0x397b46)
    leaf.position.set(Math.cos(angle) * 0.18, 0.35 * stem.scale.y, Math.sin(angle) * 0.18)
    leaf.rotation.y = -angle
    leaf.rotation.z = 0.3
    leaf.scale.multiplyScalar(scale)
    group.add(leaf)
  }
  group.position.set(x, 0, z)
  scene.add(group)
}

function addMushroom(scene: THREE.Scene, x: number, z: number, scale: number, color: number) {
  const group = new THREE.Group()
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08 * scale, 0.12 * scale, 0.42 * scale, 9),
    new THREE.MeshStandardMaterial({ color: 0xd8c8a4, roughness: 1 }),
  )
  stem.position.y = 0.21 * scale
  group.add(stem)
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.24 * scale, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
    new THREE.MeshStandardMaterial({ color, roughness: 0.7 }),
  )
  cap.scale.y = 0.52
  cap.position.y = 0.43 * scale
  group.add(cap)
  group.position.set(x, 0, z)
  scene.add(group)
  return group
}

function WorldCanvas({
  running,
  speed,
  behavior,
  controllerMode,
  resetToken,
  cellType,
  visualControl,
  onCollision,
  onFlightPhase,
  onTrialStage,
  onOlfaction,
  onEyeFrames,
  onFlyvis,
  onVisionStatus,
  onSimulationTime,
  onBodyHeight,
  onVisualEffect,
  onCnsMetrics,
}: {
  running: boolean
  speed: number
  behavior: Behavior
  controllerMode: ControllerMode
  resetToken: number
  cellType: string
  visualControl: boolean
  onCollision: (status: CollisionStatus) => void
  onFlightPhase: (phase: FlightPhase) => void
  onTrialStage: (stage: TrialStage) => void
  onOlfaction: (activity: OlfactionActivity) => void
  onEyeFrames: (frames: EyeFrames) => void
  onFlyvis: (activity: FlyvisActivity) => void
  onVisionStatus: (status: VisionStatus) => void
  onSimulationTime: (time: number) => void
  onBodyHeight: (height: number) => void
  onVisualEffect: (effect: VisualEffect) => void
  onCnsMetrics: (metrics: CnsMetrics) => void
}) {
  const holderRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef({ running, speed, behavior, controllerMode, resetToken, cellType, visualControl })
  useEffect(() => {
    runtimeRef.current = { running, speed, behavior, controllerMode, resetToken, cellType, visualControl }
  }, [running, speed, behavior, controllerMode, resetToken, cellType, visualControl])

  useEffect(() => {
    const holder = holderRef.current
    if (!holder) return
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x172820)
    scene.fog = new THREE.FogExp2(0x172820, 0.022)
    const camera = new THREE.PerspectiveCamera(46, 1, 0.05, 120)
    camera.position.set(-1.65, 3.05, -18.1)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.12
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    holder.appendChild(renderer.domElement)
    const eyeResolution = 128
    const eyeTarget = new THREE.WebGLRenderTarget(eyeResolution, eyeResolution, { depthBuffer: true, stencilBuffer: false })
    const eyeCamera = new THREE.PerspectiveCamera(114, 1, 0.06, 45)
    const eyePixels = [new Uint8Array(eyeResolution * eyeResolution * 4), new Uint8Array(eyeResolution * eyeResolution * 4)]
    const eyeLuminance = [new Float32Array(HEX_COORDS.length), new Float32Array(HEX_COORDS.length)]
    const eyeAdaptMean = [Number.NaN, Number.NaN]
    const worker = new Worker("/workers/flyvis-worker.js")
    const cnsWorker = new Worker("/workers/cns-worker.js", { type: "module" })
    const odorWorker = new Worker("/workers/odor-worker.js")
    let visionReady = false
    let cnsReady = false
    let motor: CnsMotor | null = null
    let sensoryPools: SensoryPoolSizes | undefined
    let lastCnsMessage = 0
    cnsWorker.onmessage = (event: MessageEvent) => {
      const message = event.data
      if (message.type === "status") {
        onCnsMetrics({ status: "loading", message: message.message, modelTimeMs: 0, spikesPerSecond: 0, active: 0, regions: [0, 0, 0], motor: null })
      } else if (message.type === "ready") {
        cnsReady = true
        sensoryPools = message.sensoryPoolSizes
        onCnsMetrics({ status: "ready", modelTimeMs: 0, spikesPerSecond: 0, active: 0, regions: [0, 0, 0], motor: null, sensoryPools })
      } else if (message.type === "frame") {
        motor = message.motor as CnsMotor
        lastCnsMessage = performance.now()
        window.dispatchEvent(new CustomEvent("cns-frame", { detail: { t: message.t, spikes: message.spikes } }))
        const windowMs = Math.max(0.5, message.windowMs)
        onCnsMetrics({ status: "ready", modelTimeMs: message.t,
          spikesPerSecond: Math.round(message.spikesWindow * 1000 / windowMs), active: message.active,
          regions: message.regionSpikes.map((count: number) => Math.round(count * 1000 / windowMs)) as [number, number, number], motor, sensoryPools })
      } else if (message.type === "error") {
        console.error("Whole-CNS LIF worker failed", message.message)
        onCnsMetrics({ status: "error", message: "全脑网络运行失败", modelTimeMs: 0, spikesPerSecond: 0, active: 0, regions: [0, 0, 0], motor: null })
      }
    }
    cnsWorker.onerror = (error) => {
      console.error("Whole-CNS LIF worker failed", error)
      onCnsMetrics({ status: "error", message: "全脑网络运行失败", modelTimeMs: 0, spikesPerSecond: 0, active: 0, regions: [0, 0, 0], motor: null })
    }
    onCnsMetrics({ status: "loading", message: "正在载入全脑连接图…", modelTimeMs: 0, spikesPerSecond: 0, active: 0, regions: [0, 0, 0], motor: null })
    cnsWorker.postMessage({ type: "init", running: runtimeRef.current.running, speed: runtimeRef.current.speed, mode: runtimeRef.current.behavior, controllerMode: runtimeRef.current.controllerMode })
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data
      if (message.type === "ready") {
        visionReady = true
        onVisionStatus("ready")
        worker.postMessage({ type: "select", selected: runtimeRef.current.cellType })
      } else if (message.type === "activity") {
        const { cnsIndices, cnsRates, ...activity } = message
        cnsWorker.postMessage({ type: "drive", indices: cnsIndices, rates: cnsRates }, [cnsIndices.buffer, cnsRates.buffer])
        onFlyvis(activity as FlyvisActivity)
      } else if (message.type === "error") {
        console.error("FlyVis worker failed", message.message)
        onVisionStatus("error")
      }
    }
    worker.onerror = (error) => { console.error("FlyVis worker failed", error); onVisionStatus("error") }
    worker.postMessage({ type: "lesion", eye: null })
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.05
    controls.enablePan = false
    controls.minDistance = 1.4
    controls.maxDistance = 8
    controls.maxPolarAngle = Math.PI * 0.48
    controls.target.set(0, 0.85, -12.85)
    scene.add(new THREE.HemisphereLight(0xb6d8c5, 0x1b2318, 2.0))
    const sun = new THREE.DirectionalLight(0xffd6a1, 3.5)
    sun.position.set(-7, 10, 5)
    sun.castShadow = true
    sun.shadow.mapSize.set(1024, 1024)
    sun.shadow.camera.left = -19
    sun.shadow.camera.right = 19
    sun.shadow.camera.top = 19
    sun.shadow.camera.bottom = -19
    scene.add(sun)
    const ground = new THREE.Mesh(new THREE.CircleGeometry(20, 96), new THREE.MeshStandardMaterial({ color: 0x263e2d, roughness: 0.98 }))
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    scene.add(ground)
    const circleColliders: CircleCollider[] = []
    const capsuleColliders: CapsuleCollider[] = []
    const cameraOccluders: THREE.Object3D[] = []
    const maxFlightHeight = 4.6
    const treeTrunkMaterial = new THREE.MeshStandardMaterial({ color: 0x4c3325, roughness: 1 })
    const treeCrownMaterials = [0x315e3d, 0x3e7047, 0x496f3a].map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.94 }))
    // Seeded rejection sampling fills the whole forest footprint. There is no
    // reserved centre lane or waypoint corridor: only a compact take-off pad,
    // the flower heads, and enough trunk-to-trunk clearance for both wings.
    const treePositions: Array<{ x: number; z: number; radius: number }> = []
    const minimumTrunkGap = 2 * (FLY_WING_SWEEP_RADIUS + TREE_COLLIDER_MARGIN) + TREE_PASSAGE_MARGIN
    for (let candidate = 0; treePositions.length < 68 && candidate < 1200; candidate += 1) {
      const x = (seeded(candidate, 102) - 0.5) * 24.4
      const z = -13.8 + seeded(candidate, 103) * 29.2
      if ((x / 12.7) ** 2 + ((z - 0.65) / 15.4) ** 2 > 1) continue
      if (Math.hypot(x, z + 13.4) < 1.7) continue
      if (SCENTED_FLOWERS.some((flower) => Math.hypot(x - flower.x, z - flower.z) < 1.68)) continue
      const trunkRadius = 0.18 + seeded(candidate, 105) * 0.13
      if (treePositions.some((tree) => Math.hypot(x - tree.x, z - tree.z) < minimumTrunkGap + trunkRadius + tree.radius)) continue
      const i = treePositions.length
      treePositions.push({ x, z, radius: trunkRadius })
      // Keep even the lowest crown well above the fly's maximum flight envelope,
      // so the route winds between collidable trunks rather than through leaves.
      const trunkHeight = maxFlightHeight + 2.4 + seeded(candidate, 104) * 2.2
      const tree = new THREE.Group()
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(trunkRadius * 0.78, trunkRadius, trunkHeight, 8), treeTrunkMaterial)
      trunk.position.y = trunkHeight / 2
      trunk.castShadow = true
      trunk.receiveShadow = true
      trunk.userData.cameraOcclusionRoot = tree
      tree.add(trunk)
      for (let level = 0; level < 3; level += 1) {
        const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.72 + seeded(candidate * 3 + level, 106) * 0.42, 1), treeCrownMaterials[(i + level) % treeCrownMaterials.length])
        crown.position.set((seeded(candidate * 3 + level, 107) - 0.5) * 0.42, trunkHeight - 0.35 + level * 0.42, (seeded(candidate * 3 + level, 108) - 0.5) * 0.34)
        crown.scale.set(1.15, 0.9, 1.05)
        crown.castShadow = true
        crown.userData.cameraOcclusionRoot = tree
        tree.add(crown)
      }
      tree.position.set(x, 0, z)
      scene.add(tree)
      cameraOccluders.push(tree)
      circleColliders.push({ x, z, radius: trunkRadius + TREE_COLLIDER_MARGIN, height: trunkHeight, kind: "tree" })
    }
    const startLeaf = makeLeaf(0x75a95a)
    startLeaf.scale.set(4.2, 0.24, 5.2)
    // The FlyBody feet rest near y=0.22 at the initial body height (0.62).
    // Keep the leaf surface just below them so take-off does not begin inside it.
    startLeaf.position.set(0, 0.17, -13.4)
    startLeaf.rotation.y = -0.18
    scene.add(startLeaf)
    for (let i = 0; i < 34; i += 1) {
      const angle = seeded(i, 1) * Math.PI * 2
      const radius = 1.8 + Math.pow(seeded(i, 2), 0.65) * 16.4
      addPlant(scene, Math.cos(angle) * radius, Math.sin(angle) * radius, 0.7 + seeded(i, 4) * 1.55, i)
    }
    for (let i = 0; i < 8; i += 1) {
      const angle = seeded(i, 25) * Math.PI * 2
      const radius = 4 + seeded(i, 28) * 12.5
      const scale = 0.9 + seeded(i, 31) * 1.15
      const mushroom = addMushroom(scene, Math.cos(angle) * radius, Math.sin(angle) * radius, scale, i % 2 ? 0xd26c4e : 0xc5a653)
      circleColliders.push({ x: mushroom.position.x, z: mushroom.position.z, radius: 0.22 * scale, height: 0.58 * scale, kind: "mushroom" })
    }
    const rockMaterial = new THREE.MeshStandardMaterial({ color: 0x637064, roughness: 0.97 })
    for (let i = 0; i < 13; i += 1) {
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42 + seeded(i, 40) * 0.7, 1), rockMaterial)
      const angle = seeded(i, 42) * Math.PI * 2
      const radius = 4.2 + seeded(i, 43) * 13
      const rockRadius = 0.42 + seeded(i, 40) * 0.7
      rock.position.set(Math.cos(angle) * radius, 0.24, Math.sin(angle) * radius)
      rock.scale.set(1.2, 0.75, 0.9)
      rock.rotation.set(seeded(i, 44), seeded(i, 45) * Math.PI, seeded(i, 46))
      rock.castShadow = true
      rock.receiveShadow = true
      scene.add(rock)
      circleColliders.push({ x: rock.position.x, z: rock.position.z, radius: rockRadius * 1.05, height: rock.position.y + rockRadius * 0.75, kind: "rock" })
    }
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.62, 5.5, 12), new THREE.MeshStandardMaterial({ color: 0x4f3826, roughness: 1 }))
    log.rotation.z = Math.PI / 2
    log.rotation.y = -0.2
    log.position.set(-4.1, 0.55, -3.4)
    log.castShadow = true
    log.receiveShadow = true
    scene.add(log)
    const logDirection = new THREE.Vector3(0, 1, 0).applyQuaternion(log.quaternion)
    capsuleColliders.push({
      ax: log.position.x - logDirection.x * 2.75,
      az: log.position.z - logDirection.z * 2.75,
      bx: log.position.x + logDirection.x * 2.75,
      bz: log.position.z + logDirection.z * 2.75,
      radius: 0.58,
      height: 1.15,
      kind: "log",
    })
    const pond = new THREE.Mesh(new THREE.CircleGeometry(2.1, 48), new THREE.MeshPhysicalMaterial({ color: 0x315f63, roughness: 0.22, clearcoat: 0.65, transparent: true, opacity: 0.78 }))
    pond.rotation.x = -Math.PI / 2
    pond.position.set(4.7, 0.018, 3.9)
    scene.add(pond)
    circleColliders.push({ x: pond.position.x, z: pond.position.z, radius: 2.05, height: 0.65, kind: "water" })
    const fruit = new THREE.Group()
    for (let i = 0; i < 5; i += 1) {
      const berry = new THREE.Mesh(new THREE.SphereGeometry(0.25 + seeded(i, 52) * 0.12, 14, 10), new THREE.MeshStandardMaterial({ color: i % 2 ? 0x9f4b35 : 0xc17336, roughness: 0.72 }))
      berry.scale.y = 0.72
      berry.position.set((i - 2) * 0.26, 0.18 + seeded(i, 53) * 0.14, seeded(i, 54) * 0.32)
      fruit.add(berry)
    }
    fruit.position.set(2.8, 0, -2.7)
    scene.add(fruit)
    circleColliders.push({ x: fruit.position.x, z: fruit.position.z, radius: 0.82, height: 0.55, kind: "fruit" })
    const fly = new THREE.Group()
    fly.name = "flybody-agent"
    fly.position.set(0, 0.62, -13.4)
    scene.add(fly)
    const flyBodyPivot = new THREE.Group()
    flyBodyPivot.name = "flybody-z-up-to-y-up"
    flyBodyPivot.rotation.set(-Math.PI / 2, Math.PI / 2, 0, "YXZ")
    flyBodyPivot.scale.setScalar(3.05)
    fly.add(flyBodyPivot)
    const articulated = new Map<string, { object: THREE.Object3D; base: THREE.Quaternion }>()
    let disposed = false
    const loader = new GLTFLoader()
    loader.load("/models/flybody-fly.glb", (gltf) => {
      if (disposed) return
      const model = gltf.scene
      model.name = "FlyBody-official-LOD"
      model.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = true
          object.receiveShadow = true
        }
        if (object.userData.flybodyBody || /^(wing_|coxa_|femur_|tibia_|abdomen)/.test(object.name)) {
          articulated.set(object.name, { object, base: object.quaternion.clone() })
        }
      })
      flyBodyPivot.add(model)
    }, undefined, (error) => console.error("FlyBody model failed to load", error))
    const axisX = new THREE.Vector3(1, 0, 0)
    const axisY = new THREE.Vector3(0, 1, 0)
    const axisZ = new THREE.Vector3(0, 0, 1)
    const poseDelta = new THREE.Quaternion()
    const poseJoint = (name: string, rotations: Array<[THREE.Vector3, number]>) => {
      const entry = articulated.get(name)
      if (!entry) return
      entry.object.quaternion.copy(entry.base)
      rotations.forEach(([axis, angle]) => entry.object.quaternion.multiply(poseDelta.setFromAxisAngle(axis, angle)))
    }
    const targetMarker = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.025, 8, 36), new THREE.MeshBasicMaterial({ color: 0xe9f59b, transparent: true, opacity: 0.55 }))
    targetMarker.rotation.x = Math.PI / 2
    targetMarker.position.set(2.8, 0.03, -2.7)
    scene.add(targetMarker)

    // Experiment objects change only the rendered sensory world. None of these
    // groups has access to the body command or CNS motor readout.
    const optomotorGroup = new THREE.Group()
    for (let i = 0; i < 32; i += 1) {
      const angle = (i / 32) * Math.PI * 2
      const stripe = new THREE.Mesh(
        new THREE.PlaneGeometry(1.35, 5.8),
        new THREE.MeshBasicMaterial({ color: i % 2 ? 0xf3f0d8 : 0x111711, side: THREE.DoubleSide, fog: false }),
      )
      stripe.position.set(Math.sin(angle) * 6.7, 2.85, Math.cos(angle) * 6.7)
      stripe.lookAt(0, 2.3, 0)
      optomotorGroup.add(stripe)
    }
    optomotorGroup.name = "sensory-optomotor-panorama"
    scene.add(optomotorGroup)

    const loomingGroup = new THREE.Group()
    const loomingObject = new THREE.Mesh(
      new THREE.SphereGeometry(0.72, 24, 18),
      new THREE.MeshBasicMaterial({ color: 0x050707, fog: false }),
    )
    loomingGroup.add(loomingObject)
    loomingGroup.name = "sensory-looming-object"
    scene.add(loomingGroup)

    const landingGroup = new THREE.Group()
    const landingStem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.18, 2.55, 10),
      new THREE.MeshStandardMaterial({ color: 0x356a3f, roughness: 0.9 }),
    )
    landingStem.position.y = 1.275
    landingGroup.add(landingStem)
    const landingCenter = new THREE.Mesh(
      new THREE.CylinderGeometry(0.72, 0.62, 0.18, 30),
      new THREE.MeshStandardMaterial({ color: 0xf4bf42, emissive: 0x5a3300, emissiveIntensity: 0.45, roughness: 0.72 }),
    )
    landingCenter.position.y = 2.58
    landingCenter.rotation.x = Math.PI / 2
    landingGroup.add(landingCenter)
    const landingPetalMaterial = new THREE.MeshStandardMaterial({ color: SCENTED_FLOWERS[0].color, roughness: 0.78 })
    for (let i = 0; i < 10; i += 1) {
      const angle = (i / 10) * Math.PI * 2
      const petal = new THREE.Mesh(new THREE.SphereGeometry(0.48, 12, 8), landingPetalMaterial)
      petal.scale.set(1.45, 0.18, 0.72)
      petal.position.set(Math.cos(angle) * 0.88, 2.55, Math.sin(angle) * 0.88)
      petal.rotation.y = -angle
      landingGroup.add(petal)
    }
    landingGroup.name = "sensory-scented-flower"
    const flowerGroups = SCENTED_FLOWERS.map((flower, index) => {
      const group = index === 0 ? landingGroup : landingGroup.clone(true)
      group.position.set(flower.x, 0, flower.z)
      group.name = `sensory-scented-flower-${index + 1}`
      if (index > 0) {
        group.traverse((object) => {
          if (object instanceof THREE.Mesh && object.geometry.type === "SphereGeometry") {
            object.material = new THREE.MeshStandardMaterial({ color: flower.color, roughness: 0.78 })
          }
        })
      }
      scene.add(group)
      circleColliders.push({ x: flower.x, z: flower.z, radius: 0.2, height: 2.48, kind: "flower" })
      return group
    })

    const slalomGroup = new THREE.Group()
    const slalomColliders: CircleCollider[] = []
    const slalomLayout = [[-1.15, 2.8], [1.2, 4.5], [-1.3, 6.2], [1.05, 7.9]] as const
    slalomLayout.forEach(([x, z], index) => {
      const height = 3.2 + index * 0.35
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.55, height, 12),
        new THREE.MeshStandardMaterial({ color: index % 2 ? 0x4b9ab0 : 0xd88148, roughness: 0.82 }),
      )
      pillar.position.set(x, height / 2, z)
      pillar.castShadow = true
      slalomGroup.add(pillar)
      slalomColliders.push({ x, z, radius: 0.55, height, kind: "pillar" })
    })
    slalomGroup.name = "sensory-obstacle-slalom"
    scene.add(slalomGroup)

    const conspecificGroup = new THREE.Group()
    const conspecificBody = new THREE.Mesh(
      new THREE.SphereGeometry(0.19, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0x17120e, roughness: 0.65 }),
    )
    conspecificBody.scale.set(0.72, 0.62, 1.55)
    conspecificGroup.add(conspecificBody)
    const conspecificWingMaterial = new THREE.MeshBasicMaterial({ color: 0xdce6dc, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
    const conspecificWings: THREE.Mesh[] = []
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.CircleGeometry(0.24, 12), conspecificWingMaterial)
      wing.scale.set(0.55, 1.35, 1)
      wing.position.set(side * 0.2, 0.08, 0)
      wing.rotation.set(-Math.PI / 2, 0, side * 0.38)
      conspecificGroup.add(wing)
      conspecificWings.push(wing)
    }
    conspecificGroup.name = "sensory-conspecific-target"
    scene.add(conspecificGroup)
    let avoidanceTurn = 0
    let avoidanceUntil = 0
    let landingCommitted = false
    odorWorker.onmessage = (event: MessageEvent) => {
      const message = event.data
      if (message.type !== "sample") return
      const leftHz = message.leftHz
      const rightHz = message.rightHz
      const windLeftHz = message.windLeftHz
      const windRightHz = message.windRightHz
      cnsWorker.postMessage({ type: "olfaction", leftHz, rightHz, windLeftHz, windRightHz })
      const gradient = message.gradient as [number, number]
      const gradientMagnitude = Math.hypot(gradient[0], gradient[1])
      // Odor-guided upwind surge: use the lateral concentration gradient to
      // stay inside a plume while relative wind supplies the upwind direction.
      // This avoids descending the plume when its widening makes the raw
      // longitudinal gradient locally point downwind.
      const fieldStrength = Math.max(0, Number(message.field) || 0)
      const desiredZ = Math.max(0.008, Math.abs(gradient[1]) * 0.55 + fieldStrength * 0.012)
      const rawDesiredX = gradientMagnitude > 0.0002 ? gradient[0] : -message.wind[0] * 0.02
      const desiredX = THREE.MathUtils.clamp(rawDesiredX, -desiredZ * 0.58, desiredZ * 0.58)
      const proximity = THREE.MathUtils.clamp(Number(message.proximity) || 0, 0, 1)
      const homing = THREE.MathUtils.clamp(Number(message.homing) || 0, 0, 1)
      const coreGradient = message.coreGradient as [number, number]
      const coreStrength = Math.hypot(coreGradient[0], coreGradient[1])
      const coreBlend = coreStrength > 0.0002
        ? THREE.MathUtils.smoothstep(homing, 0.025, 0.16) : 0
      const coreX = coreStrength > 0 ? coreGradient[0] / coreStrength : 0
      const coreZ = coreStrength > 0 ? coreGradient[1] / coreStrength : 0
      const upwindLength = Math.hypot(desiredX, desiredZ)
      const aimX = THREE.MathUtils.lerp(desiredX / upwindLength, coreX, coreBlend)
      const aimZ = THREE.MathUtils.lerp(desiredZ / upwindLength, coreZ, coreBlend)
      const desiredHeading = Math.atan2(-aimX, -aimZ)
      const headingError = Math.atan2(Math.sin(desiredHeading - heading), Math.cos(desiredHeading - heading))
      const bilateral = THREE.MathUtils.clamp((leftHz - rightHz) / 55, -0.35, 0.35)
      const chemotacticTurn = THREE.MathUtils.clamp(headingError / 1.1 + bilateral * 0.2, -1, 1)
      const turn = elapsed < avoidanceUntil ? avoidanceTurn : chemotacticTurn
      // Commit only inside the physical flower-head capture radius. A looser
      // threshold can make the fly descend onto the forest floor before its
      // body actually overlaps a flower.
      if (proximity > 0.5) landingCommitted = true
      const landing = landingCommitted
      const launch = elapsed > 0.65 && phase === "grounded" && !landing
      cnsWorker.postMessage({ type: "navigation", turn, launch, landing, blocked: elapsed < avoidanceUntil, homing })
      onOlfaction({ left: message.left, right: message.right, leftHz, rightHz, windLeftHz, windRightHz,
        wind: message.wind, gradient, field: message.field, proximity: message.proximity })
    }
    const contactMaterial = new THREE.MeshBasicMaterial({ color: 0xff9a57, transparent: true, opacity: 0, depthWrite: false })
    const contactPulse = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.035, 8, 40), contactMaterial)
    contactPulse.rotation.x = Math.PI / 2
    contactPulse.visible = false
    contactPulse.renderOrder = 5
    scene.add(contactPulse)
    let width = 0
    let height = 0
    const resize = () => {
      const nextWidth = holder.clientWidth
      const nextHeight = holder.clientHeight
      if (!nextWidth || !nextHeight || (nextWidth === width && nextHeight === height)) return
      width = nextWidth
      height = nextHeight
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(holder)
    resize()
    const eyeForward = new THREE.Vector3()
    const eyeRight = new THREE.Vector3()
    const eyeOrigin = new THREE.Vector3()
    const eyeLookAt = new THREE.Vector3()
    let lastEyeSample = 0
    let lastEyeDisplay = 0
    const renderEyes = (now: number) => {
      if (!visionReady || !runtimeRef.current.running || now - lastEyeSample < 50) return
      lastEyeSample = now
      eyeForward.set(0, 0, -1).applyQuaternion(fly.quaternion).normalize()
      eyeRight.set(1, 0, 0).applyQuaternion(fly.quaternion).normalize()
      fly.visible = false
      const shadowsEnabled = renderer.shadowMap.enabled
      renderer.shadowMap.enabled = false
      for (let eye = 0; eye < 2; eye++) {
        const side = eye === 0 ? -1 : 1
        eyeOrigin.copy(resolvedPosition).addScaledVector(eyeForward, 0.2).addScaledVector(eyeRight, side * 0.16)
        eyeOrigin.y += 0.1
        eyeCamera.position.copy(eyeOrigin)
        eyeLookAt.copy(eyeOrigin).addScaledVector(eyeForward, 0.58).addScaledVector(eyeRight, side * 0.82)
        eyeCamera.lookAt(eyeLookAt)
        renderer.setRenderTarget(eyeTarget)
        renderer.render(scene, eyeCamera)
        renderer.readRenderTargetPixels(eyeTarget, 0, 0, eyeResolution, eyeResolution, eyePixels[eye])
        const pixels = eyePixels[eye]
        for (let offset = 0; offset < pixels.length; offset += 4) {
          pixels[offset] = LINEAR_TO_SRGB_BYTES[pixels[offset]]
          pixels[offset + 1] = LINEAR_TO_SRGB_BYTES[pixels[offset + 1]]
          pixels[offset + 2] = LINEAR_TO_SRGB_BYTES[pixels[offset + 2]]
        }
        const luminance = eyeLuminance[eye]
        let rawMean = 0
        HEX_COORDS.forEach(([q, r], index) => {
          const nx = ((q + r / 2) / (HEX_RADIUS * 1.5)) * 0.86
          const ny = (r / HEX_RADIUS) * 0.86
          const px = Math.max(0, Math.min(eyeResolution - 1, Math.round((nx * 0.5 + 0.5) * (eyeResolution - 1))))
          const py = Math.max(0, Math.min(eyeResolution - 1, Math.round((ny * 0.5 + 0.5) * (eyeResolution - 1))))
          const offset = (py * eyeResolution + px) * 4
          const raw = (pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722) / 255
          luminance[index] = raw
          rawMean += raw
        })
        rawMean /= HEX_COORDS.length
        eyeAdaptMean[eye] = Number.isNaN(eyeAdaptMean[eye]) ? rawMean : THREE.MathUtils.lerp(eyeAdaptMean[eye], rawMean, 0.16)
        for (let column = 0; column < luminance.length; column++) {
          luminance[column] = THREE.MathUtils.clamp(0.5 + (luminance[column] - eyeAdaptMean[eye]) * 2.2, 0, 1)
        }
      }
      renderer.setRenderTarget(null)
      renderer.shadowMap.enabled = shadowsEnabled
      fly.visible = true
      const left = eyeLuminance[0].slice()
      const right = eyeLuminance[1].slice()
      worker.postMessage({ type: "frame", left, right }, [left.buffer, right.buffer])
      if (now - lastEyeDisplay >= 100) {
        lastEyeDisplay = now
        window.dispatchEvent(new CustomEvent("flyvis-eye-frame", { detail: { left: eyePixels[0], right: eyePixels[1] } }))
        onEyeFrames({ luminanceLeft: eyeLuminance[0].slice(), luminanceRight: eyeLuminance[1].slice(), sampledAt: now })
      }
    }
    let elapsed = 0
    let last = performance.now()
    let animation = 0
    let observedResetToken = runtimeRef.current.resetToken
    const flyRadius = 0.4
    const flyVerticalRadius = 0.28
    const groundedHeight = 0.62
    const environmentRadius = 18.8 - flyRadius
    const resolvedPosition = new THREE.Vector3(0, groundedHeight, -13.4)
    const proposedPosition = new THREE.Vector3()
    const previousPosition = new THREE.Vector3()
    const cameraFocus = new THREE.Vector3(0, 0.85, -12.85)
    const cameraDesired = new THREE.Vector3(-1.65, 3.05, -18.1)
    const cameraRayDirection = new THREE.Vector3()
    const cameraRaycaster = new THREE.Raycaster()
    let hiddenForMainCamera: THREE.Object3D[] = []
    let heading = Math.PI
    let motorHeadingChange = 0
    let verticalVelocity = 0
    let phase: FlightPhase = "grounded"
    let phaseElapsed = 0
    let lowWingTime = 0
    let flightIntentTime = 0
    let legTuckBlend = 0
    let lastReportedTime = 0
    let workerRunning = runtimeRef.current.running
    let workerCellType = runtimeRef.current.cellType
    let workerSpeed = runtimeRef.current.speed
    let workerMode = runtimeRef.current.behavior
    let workerControllerMode = runtimeRef.current.controllerMode
    let contactLife = 0
    let lastCollisionKey = "clear"
    let lastFlightPhase: FlightPhase | "" = ""
    let lastTrialStage: TrialStage | "" = ""
    let lastOdorSample = 0
    let flowerContactTime = 0
    let contactNormalX = 0
    let contactNormalZ = 0
    const resolveCircle = (position: THREE.Vector3, collider: CircleCollider) => {
      if (position.y - flyVerticalRadius > collider.height) return false
      let dx = position.x - collider.x
      let dz = position.z - collider.z
      // A trunk can hit either wing even when the thorax itself clears it.
      // Use the full wing-beat envelope, independent of the current flap phase.
      const minimum = collider.radius + (collider.kind === "tree" ? FLY_WING_SWEEP_RADIUS : flyRadius)
      const distanceSq = dx * dx + dz * dz
      if (distanceSq >= minimum * minimum) return false
      if (distanceSq < 1e-8) {
        dx = 1
        dz = 0
      }
      const distance = Math.sqrt(dx * dx + dz * dz)
      contactNormalX = dx / distance
      contactNormalZ = dz / distance
      position.x = collider.x + contactNormalX * minimum
      position.z = collider.z + contactNormalZ * minimum
      return true
    }
    const resolveCapsule = (position: THREE.Vector3, collider: CapsuleCollider) => {
      if (position.y - flyVerticalRadius > collider.height) return false
      const sx = collider.bx - collider.ax
      const sz = collider.bz - collider.az
      const lengthSq = sx * sx + sz * sz
      const projection = lengthSq > 0 ? ((position.x - collider.ax) * sx + (position.z - collider.az) * sz) / lengthSq : 0
      const t = Math.max(0, Math.min(1, projection))
      const closestX = collider.ax + sx * t
      const closestZ = collider.az + sz * t
      let dx = position.x - closestX
      let dz = position.z - closestZ
      const minimum = collider.radius + flyRadius
      const distanceSq = dx * dx + dz * dz
      if (distanceSq >= minimum * minimum) return false
      if (distanceSq < 1e-8) {
        dx = -sz || 1
        dz = sx
      }
      const distance = Math.sqrt(dx * dx + dz * dz)
      contactNormalX = dx / distance
      contactNormalZ = dz / distance
      position.x = closestX + contactNormalX * minimum
      position.z = closestZ + contactNormalZ * minimum
      return true
    }
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      const runtime = runtimeRef.current
      if (runtime.resetToken !== observedResetToken) {
        observedResetToken = runtime.resetToken
        elapsed = 0
        resolvedPosition.set(0, groundedHeight, -13.4)
        camera.position.set(-1.65, 3.05, -18.1)
        controls.target.set(0, 0.85, -12.85)
        heading = Math.PI
        motorHeadingChange = 0
        fly.rotation.x = 0
        verticalVelocity = 0
        phase = "grounded"
        phaseElapsed = 0
        lowWingTime = 0
        flightIntentTime = 0
        legTuckBlend = 0
        motor = null
        landingCommitted = false
        lastCnsMessage = 0
        eyeAdaptMean[0] = Number.NaN
        eyeAdaptMean[1] = Number.NaN
        worker.postMessage({ type: "reset" })
        odorWorker.postMessage({ type: "reset" })
        cnsWorker.postMessage({ type: "reset" })
        window.dispatchEvent(new Event("cns-reset"))
      }
      if (workerRunning !== runtime.running) {
        workerRunning = runtime.running
        worker.postMessage({ type: "run", running: workerRunning })
        cnsWorker.postMessage({ type: "run", running: workerRunning })
        odorWorker.postMessage({ type: "run", running: workerRunning })
      }
      if (workerCellType !== runtime.cellType) {
        workerCellType = runtime.cellType
        worker.postMessage({ type: "select", selected: workerCellType })
      }
      if (workerSpeed !== runtime.speed) {
        workerSpeed = runtime.speed
        worker.postMessage({ type: "speed", speed: workerSpeed })
        cnsWorker.postMessage({ type: "speed", speed: workerSpeed })
      }
      if (workerMode !== runtime.behavior) {
        workerMode = runtime.behavior
        cnsWorker.postMessage({ type: "mode", mode: workerMode })
      }
      if (workerControllerMode !== runtime.controllerMode) {
        workerControllerMode = runtime.controllerMode
        cnsWorker.postMessage({ type: "controllerMode", controllerMode: workerControllerMode })
      }
      if (runtime.running && cnsReady) elapsed += dt * runtime.speed
      const shouldReport = now - lastReportedTime > 100
      if (shouldReport) {
        lastReportedTime = now
        onSimulationTime(elapsed)
      }
      if (now - lastOdorSample > 100) {
        lastOdorSample = now
        odorWorker.postMessage({ type: "sample", x: resolvedPosition.x, y: resolvedPosition.y, z: resolvedPosition.z, heading, now, speed: runtime.speed })
      }
      const linked = runtime.visualControl && cnsReady && !!motor && now - lastCnsMessage < 1500
      const embodied = runtime.controllerMode === "embodied"
      const turnCommand = linked ? motor!.turn : 0
      const forwardCommand = linked ? motor!.forward : 0
      // The connectome's wing MN pool is not a validated flight command.
      // Use the actual flight-DN spike readout as a site-specific wing envelope.
      const wingPower = linked ? 1 - Math.exp(-Math.LN2 * Math.max(0, motor!.flightHz) / 15) : 0
      const takeoffCommand = linked ? motor!.takeoffHz : 0
      const bodyDt = runtime.running && cnsReady ? dt * runtime.speed : 0
      if (bodyDt) {
        phaseElapsed += bodyDt
        flightIntentTime = phase === "grounded" && linked && takeoffCommand > 18
          ? flightIntentTime + bodyDt : Math.max(0, flightIntentTime - bodyDt * 2)
        if (phase === "grounded" && linked && flightIntentTime > 0.35) {
          phase = "takeoff"
          phaseElapsed = 0
          flightIntentTime = 0
          if (embodied) verticalVelocity = 2.1
        }
        if (phase !== "grounded") {
          lowWingTime = wingPower < 0.3 ? lowWingTime + bodyDt : 0
          const landingDelay = embodied ? 0.45 : 0.18
          if (phase === "cruise" && lowWingTime > landingDelay) { phase = "landing"; phaseElapsed = 0 }
          const jumpAssist = embodied && phase === "takeoff" && phaseElapsed < 0.25 ? 5 * (1 - phaseElapsed / 0.25) : 0
          const rawTakeoffForce = !embodied && phase === "takeoff" ? Math.max(0, takeoffCommand - 18) * 0.18 : 0
          const liftAcceleration = embodied
            ? 9.8 * wingPower - 6.7 - 1.8 * verticalVelocity - 0.9 * Math.max(0, resolvedPosition.y - groundedHeight)
            : 13 * wingPower - 9.81 - 0.55 * verticalVelocity
          verticalVelocity += (liftAcceleration + jumpAssist + rawTakeoffForce) * bodyDt
          if (embodied && phase === "landing") verticalVelocity = Math.min(verticalVelocity, -0.4)
        } else verticalVelocity = 0
      }
      const nextHeight = THREE.MathUtils.clamp(resolvedPosition.y + verticalVelocity * bodyDt, groundedHeight, maxFlightHeight)
      if (nextHeight >= maxFlightHeight && verticalVelocity > 0) verticalVelocity = 0
      if (phase === "takeoff" && nextHeight > groundedHeight + 0.65) { phase = "cruise"; phaseElapsed = 0 }
      if (phase !== "grounded" && nextHeight <= groundedHeight && verticalVelocity <= 0) {
        phase = "grounded"
        phaseElapsed = 0
        verticalVelocity = 0
        lowWingTime = 0
      }
      const flight = { phase }
      if (flight.phase !== lastFlightPhase) {
        lastFlightPhase = flight.phase
        onFlightPhase(flight.phase)
      }
      previousPosition.copy(resolvedPosition)
      const motorTurn = turnCommand * (embodied ? 1.5 : 2.15) * bodyDt
      heading += motorTurn
      motorHeadingChange += motorTurn
      const forwardSpeed = embodied
        ? phase === "grounded" ? Math.max(0, forwardCommand) * 0.65
          : (0.18 + 0.75 * wingPower) * (0.16 + 0.84 * Math.max(0, forwardCommand))
        : phase === "grounded" ? forwardCommand * 0.72 : forwardCommand * wingPower * 1.05
      const landingSpeedScale = landingCommitted ? 0 : phase === "landing" ? 0.12 : 1
      const stepDistance = linked ? bodyDt * forwardSpeed * landingSpeedScale : 0
      proposedPosition.copy(resolvedPosition)
      proposedPosition.x -= Math.sin(heading) * stepDistance
      proposedPosition.z -= Math.cos(heading) * stepDistance
      proposedPosition.y = nextHeight
      let collisionKind: CollisionKind | "clear" = "clear"
      contactNormalX = 0
      contactNormalZ = 0
      for (let pass = 0; pass < 3; pass += 1) {
        circleColliders.forEach((collider) => {
          if (resolveCircle(proposedPosition, collider)) collisionKind = collider.kind
        })
        capsuleColliders.forEach((collider) => {
          if (resolveCapsule(proposedPosition, collider)) collisionKind = collider.kind
        })
        const radialDistance = Math.hypot(proposedPosition.x, proposedPosition.z)
        if (radialDistance > environmentRadius) {
          contactNormalX = -proposedPosition.x / radialDistance
          contactNormalZ = -proposedPosition.z / radialDistance
          proposedPosition.x = (proposedPosition.x / radialDistance) * environmentRadius
          proposedPosition.z = (proposedPosition.z / radialDistance) * environmentRadius
          collisionKind = "boundary"
        }
      }
      if (collisionKind !== "clear") {
        const normalLength = Math.hypot(contactNormalX, contactNormalZ)
        if (normalLength > 0.001) {
          const nx = contactNormalX / normalLength
          const nz = contactNormalZ / normalLength
          const forwardX = -Math.sin(heading)
          const forwardZ = -Math.cos(heading)
          const tangentAX = -nz
          const tangentAZ = nx
          const tangentBX = nz
          const tangentBZ = -nx
          const useA = tangentAX * forwardX + tangentAZ * forwardZ >= tangentBX * forwardX + tangentBZ * forwardZ
          const tangentX = useA ? tangentAX : tangentBX
          const tangentZ = useA ? tangentAZ : tangentBZ
          const escapeX = tangentX * 0.88 + nx * 0.48
          const escapeZ = tangentZ * 0.88 + nz * 0.48
          const desiredHeading = Math.atan2(-escapeX, -escapeZ)
          const escapeError = Math.atan2(Math.sin(desiredHeading - heading), Math.cos(desiredHeading - heading))
          avoidanceTurn = THREE.MathUtils.clamp(escapeError / 0.62, -1, 1)
        } else {
          avoidanceTurn = Math.sin(elapsed * 1.7) > 0 ? 1 : -1
        }
        avoidanceUntil = elapsed + 0.52
      }
      let flowerDistance = Number.POSITIVE_INFINITY
      for (const flower of SCENTED_FLOWERS) {
        flowerDistance = Math.min(flowerDistance, Math.hypot(proposedPosition.x - flower.x, proposedPosition.z - flower.z))
      }
      const flowerTop = 2.68
      const crossingFlowerTop = previousPosition.y - flyVerticalRadius >= flowerTop - 0.12 && proposedPosition.y - flyVerticalRadius <= flowerTop + 0.08
      if (flowerDistance < 1.16 && verticalVelocity <= 0 && crossingFlowerTop) {
        proposedPosition.y = flowerTop + flyVerticalRadius
        verticalVelocity = 0
        phase = "grounded"
        lowWingTime = 0
        collisionKind = "flower"
        flowerContactTime += bodyDt
      } else if (flowerDistance < 1.16 && Math.abs(proposedPosition.y - (flowerTop + flyVerticalRadius)) < 0.12 && phase === "grounded") {
        proposedPosition.y = flowerTop + flyVerticalRadius
        flowerContactTime += bodyDt
        collisionKind = "flower"
      } else flowerContactTime = 0
      resolvedPosition.copy(proposedPosition)
      fly.position.copy(resolvedPosition)
      const supportHeight = landingCommitted && flowerDistance < 1.8
        ? flowerTop + flyVerticalRadius : groundedHeight
      const targetLegTuck = phase === "grounded" ? 0
        : phase === "cruise" ? 1
          : phase === "takeoff"
            ? THREE.MathUtils.clamp((resolvedPosition.y - groundedHeight) / 0.58, 0, 1)
            : THREE.MathUtils.clamp((resolvedPosition.y - supportHeight) / 0.95, 0, 1)
      const legPoseRate = targetLegTuck < legTuckBlend ? 8.5 : 7
      legTuckBlend += (targetLegTuck - legTuckBlend) * Math.min(1, bodyDt * legPoseRate)
      const trialStage: TrialStage = flowerContactTime > 0.8 ? "success"
        : flowerDistance < 1.8 || phase === "landing" ? "landing"
          : flowerDistance < 4.2 ? "approach"
            : phase === "grounded" ? "grounded"
              : phase === "takeoff" ? "takeoff" : "forest"
      if (trialStage !== lastTrialStage) {
        lastTrialStage = trialStage
        onTrialStage(trialStage)
      }
      if (shouldReport) {
        onBodyHeight(resolvedPosition.y)
        onVisualEffect({ yawRate: bodyDt ? turnCommand * 1.5 : 0, headingChange: motorHeadingChange, heightOffset: resolvedPosition.y - groundedHeight })
      }
      const followForwardX = -Math.sin(heading)
      const followForwardZ = -Math.cos(heading)
      const followRightX = Math.cos(heading)
      const followRightZ = -Math.sin(heading)
      cameraFocus.set(
        resolvedPosition.x + followForwardX * 0.55,
        resolvedPosition.y + 0.18,
        resolvedPosition.z + followForwardZ * 0.55,
      )
      cameraDesired.set(
        resolvedPosition.x - followForwardX * 4.9 + followRightX * 1.55,
        resolvedPosition.y + 2.35,
        resolvedPosition.z - followForwardZ * 4.9 + followRightZ * 1.55,
      )
      const cameraAlpha = 1 - Math.exp(-dt * 4.2)
      camera.position.lerp(cameraDesired, cameraAlpha)
      controls.target.lerp(cameraFocus, cameraAlpha)
      cameraRayDirection.copy(camera.position).sub(controls.target)
      const cameraRayDistance = cameraRayDirection.length()
      cameraRaycaster.set(controls.target, cameraRayDirection.normalize())
      cameraRaycaster.far = cameraRayDistance
      hiddenForMainCamera = [...new Set(cameraRaycaster.intersectObjects(cameraOccluders, true)
        .filter((hit) => hit.distance > 0.38 && hit.distance < cameraRayDistance - 0.08)
        .map((hit) => (hit.object.userData.cameraOcclusionRoot as THREE.Object3D | undefined) ?? hit.object))]
      fly.rotation.y = heading
      const targetPitch = embodied
        ? flight.phase === "takeoff" ? -0.16 : flight.phase === "landing" ? 0.13 : flight.phase === "cruise" ? Math.sin(elapsed * 1.2) * 0.025 : 0
        : THREE.MathUtils.clamp(-verticalVelocity * 0.07, -0.28, 0.28)
      fly.rotation.x += (targetPitch - fly.rotation.x) * Math.min(1, dt * 5)
      if (collisionKind !== "clear") contactLife = 0.3
      else contactLife = Math.max(0, contactLife - dt)
      contactPulse.visible = contactLife > 0
      if (contactPulse.visible) {
        const pulseProgress = 1 - contactLife / 0.3
        contactPulse.position.set(resolvedPosition.x, 0.045, resolvedPosition.z)
        contactPulse.scale.setScalar(0.8 + pulseProgress * 0.75)
        contactMaterial.opacity = (1 - pulseProgress) * 0.8
      }
      const collisionKey = collisionKind === "clear" ? "clear" : collisionKind
      if (collisionKey !== lastCollisionKey) {
        lastCollisionKey = collisionKey
        onCollision({ active: collisionKind !== "clear", kind: collisionKind })
      }
      const airborne = flight.phase !== "grounded"
      const wingBeat = Math.sin(elapsed * (airborne ? 65 : 13))
      const wingAmplitude = airborne ? 0.18 + 0.5 * Math.min(1, wingPower) : 0.08
      poseJoint("wing_left", [[axisZ, -0.48 - wingBeat * wingAmplitude], [axisX, 0.16 + Math.abs(wingBeat) * (airborne ? 0.22 : 0.04)]])
      poseJoint("wing_right", [[axisZ, 0.48 + wingBeat * wingAmplitude], [axisX, 0.16 + Math.abs(wingBeat) * (airborne ? 0.22 : 0.04)]])
      for (const pair of [1, 2, 3]) {
        for (const side of ["left", "right"] as const) {
          // Take-off folds the legs as the body rises. A walking gait here
          // makes the feet dip through the launch surface before they clear it.
          const fold = FLIGHT_LEG_FOLD[pair as keyof typeof FLIGHT_LEG_FOLD][side]
          poseJoint(`coxa_T${pair}_${side}`, [[axisZ, fold.coxaZ * legTuckBlend], [axisX, fold.coxaX * legTuckBlend]])
          poseJoint(`femur_T${pair}_${side}`, [[axisX, fold.femurX * legTuckBlend]])
          poseJoint(`tibia_T${pair}_${side}`, [[axisX, fold.tibiaX * legTuckBlend]])
        }
      }
      poseJoint("abdomen_2", [[axisY, Math.sin(elapsed * 2.2) * 0.014]])
      poseJoint("abdomen_3", [[axisY, Math.sin(elapsed * 2.2 + 0.5) * 0.012]])
      flowerGroups.forEach((flower, i) => { flower.rotation.z = Math.sin(elapsed * 0.8 + i) * 0.018 })
      optomotorGroup.visible = false
      loomingGroup.visible = false
      flowerGroups.forEach((flower) => { flower.visible = true })
      slalomGroup.visible = false
      conspecificGroup.visible = false
      targetMarker.visible = false
      targetMarker.position.set(0, 2.82, 13.2)
      targetMarker.rotation.x = Math.PI / 2
      ;(targetMarker.material as THREE.MeshBasicMaterial).opacity = 0.34 + Math.sin(elapsed * 2.2) * 0.16
      renderEyes(now)
      // Occluding crowns are hidden only for the observer render. They remain
      // present for both compound-eye cameras, FlyVis input, and all physics.
      hiddenForMainCamera.forEach((object) => { object.visible = false })
      controls.update()
      renderer.render(scene, camera)
      hiddenForMainCamera.forEach((object) => { object.visible = true })
      animation = requestAnimationFrame(loop)
    }
    animation = requestAnimationFrame(loop)
    return () => {
      disposed = true
      cancelAnimationFrame(animation)
      observer.disconnect()
      worker.terminate()
      cnsWorker.terminate()
      odorWorker.terminate()
      eyeTarget.dispose()
      controls.dispose()
      renderer.dispose()
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose()
          if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose())
          else object.material.dispose()
        }
      })
      holder.removeChild(renderer.domElement)
    }
  }, [onCollision, onFlightPhase, onTrialStage, onOlfaction, onEyeFrames, onFlyvis, onVisionStatus, onSimulationTime, onBodyHeight, onVisualEffect, onCnsMetrics])
  return <div ref={holderRef} className="world-canvas" aria-label="三维果蝇自然环境" />
}

function WholeBrainCanvas({ running, active, metrics }: { running: boolean; active: boolean; metrics: CnsMetrics }) {
  const holderRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef({ running, active })
  useEffect(() => { runtimeRef.current = { running, active } }, [running, active])

  useEffect(() => {
    const holder = holderRef.current
    if (!holder) return
    let disposed = false
    let animation = 0
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0d1713)
    scene.fog = new THREE.FogExp2(0x0d1713, 0.055)
    const camera = new THREE.PerspectiveCamera(39, 1, 0.05, 80)
    camera.position.set(0, 0.1, 9.2)
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    holder.appendChild(renderer.domElement)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.06
    controls.enablePan = false
    controls.minDistance = 4.5
    controls.maxDistance = 16
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.35
    controls.target.set(0, -0.35, 0)

    const uniforms = {
      uBrainTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 1.6) },
    }
    const material = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float aLastSpike;
        attribute float aGroup;
        attribute float aVisible;
        uniform float uBrainTime;
        uniform float uPixelRatio;
        varying vec3 vColor;
        varying float vAlpha;

        vec3 regionColor(float group) {
          float band = mod(group, 6.0);
          if (band < 1.0) return vec3(0.25, 0.72, 0.88);
          if (band < 2.0) return vec3(0.48, 0.86, 0.67);
          if (band < 3.0) return vec3(0.74, 0.48, 0.92);
          if (band < 4.0) return vec3(0.98, 0.48, 0.58);
          if (band < 5.0) return vec3(0.98, 0.72, 0.31);
          return vec3(0.66, 0.82, 0.42);
        }

        void main() {
          float age = max(0.0, uBrainTime - aLastSpike);
          float activity = exp(-age * 0.045) * aVisible;
          vec3 base = regionColor(aGroup);
          vColor = mix(base * 0.52, vec3(1.0, 0.88, 0.35), activity * 0.9);
          vAlpha = aVisible * (0.08 + activity * 0.78);
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * viewPosition;
          gl_PointSize = aVisible * uPixelRatio * (0.58 + activity * 2.15) * (7.0 / max(1.0, -viewPosition.z));
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 point = gl_PointCoord * 2.0 - 1.0;
          float radius = dot(point, point);
          if (radius > 1.0 || vAlpha < 0.01) discard;
          float softEdge = 1.0 - smoothstep(0.35, 1.0, radius);
          gl_FragColor = vec4(vColor, vAlpha * softEdge);
        }
      `,
    })
    let points: THREE.Points | undefined
    let spikeTimes: Float32Array | null = null
    let spikeAttribute: THREE.BufferAttribute | null = null
    const onFrame = (event: Event) => {
      const { t, spikes } = (event as CustomEvent<{ t: number; spikes: Uint32Array }>).detail
      uniforms.uBrainTime.value = t
      if (spikeTimes && spikeAttribute) {
        for (const index of spikes) if (index < spikeTimes.length) spikeTimes[index] = t
        spikeAttribute.needsUpdate = true
      }
    }
    const onReset = () => {
      uniforms.uBrainTime.value = 0
      spikeTimes?.fill(-1_000_000)
      if (spikeAttribute) spikeAttribute.needsUpdate = true
    }
    window.addEventListener("cns-frame", onFrame)
    window.addEventListener("cns-reset", onReset)
    let width = 0
    let height = 0
    const resize = () => {
      const nextWidth = holder.clientWidth
      const nextHeight = holder.clientHeight
      if (!nextWidth || !nextHeight || (nextWidth === width && nextHeight === height)) return
      width = nextWidth
      height = nextHeight
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(holder)
    resize()

    void fetch("/data/fly-brain-neurons.flyn")
      .then((response) => {
        if (!response.ok) throw new Error(`neuron table ${response.status}`)
        return response.arrayBuffer()
      })
      .then((buffer) => {
        if (disposed) return
        const table = decodeFlyBrainNeurons(new Uint8Array(buffer))
        const { count, soma, superclass } = table
        const positions = new Float32Array(count * 3)
        const lastSpikes = new Float32Array(count).fill(-1_000_000)
        const groups = new Float32Array(count)
        const visible = new Float32Array(count)
        const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
        const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
        for (let i = 0; i < count; i += 1) {
          for (let axis = 0; axis < 3; axis += 1) {
            const value = soma[i * 3 + axis]
            if (Number.isFinite(value)) {
              min[axis] = Math.min(min[axis], value)
              max[axis] = Math.max(max[axis], value)
            }
          }
        }
        const center = min.map((value, axis) => (value + max[axis]) / 2)
        const extent = Math.max(...max.map((value, axis) => value - min[axis]))
        const scale = 5.2 / extent
        for (let i = 0; i < count; i += 1) {
          const x = soma[i * 3]
          const y = soma[i * 3 + 1]
          const z = soma[i * 3 + 2]
          const hasSoma = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
          visible[i] = hasSoma ? 1 : 0
          if (hasSoma) {
            positions[i * 3] = (x - center[0]) * scale
            positions[i * 3 + 1] = -(y - center[1]) * scale
            positions[i * 3 + 2] = (z - center[2]) * scale
          }
          groups[i] = superclass[i]
        }
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3))
        spikeTimes = lastSpikes
        spikeAttribute = new THREE.BufferAttribute(lastSpikes, 1).setUsage(THREE.DynamicDrawUsage)
        geometry.setAttribute("aLastSpike", spikeAttribute)
        geometry.setAttribute("aGroup", new THREE.BufferAttribute(groups, 1))
        geometry.setAttribute("aVisible", new THREE.BufferAttribute(visible, 1))
        geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 7)
        points = new THREE.Points(geometry, material)
        points.rotation.z = Math.PI * 0.015
        scene.add(points)
      })
      .catch((error) => {
        console.error("Whole-CNS soma table failed to load", error)
        if (!disposed) console.error("CNS anatomy view unavailable")
      })

    const loop = () => {
      if (runtimeRef.current.active) {
        controls.autoRotate = runtimeRef.current.running
        controls.update()
        renderer.render(scene, camera)
      }
      animation = requestAnimationFrame(loop)
    }
    animation = requestAnimationFrame(loop)
    return () => {
      disposed = true
      cancelAnimationFrame(animation)
      observer.disconnect()
      window.removeEventListener("cns-frame", onFrame)
      window.removeEventListener("cns-reset", onReset)
      controls.dispose()
      points?.geometry.dispose()
      material.dispose()
      renderer.dispose()
      holder.removeChild(renderer.domElement)
    }
  }, [])

  return (
    <div className="whole-brain-canvas" aria-label="165122神经元全中枢活动可视化">
      <div ref={holderRef} className="whole-brain-render" />
      {metrics.status !== "ready" && <div className="brain-loading">{metrics.message || "正在载入全脑连接图…"}</div>}
      <div className="brain-source-label"><span>REAL SOMA POSITIONS</span><strong>CONNECTOME LIF SPIKES</strong></div>
      <div className="brain-axis-label">拖动旋转 · 滚轮缩放</div>
    </div>
  )
}

function EyeImage({ side, label }: { side: "left" | "right"; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const resolution = 128
    canvas.width = resolution
    canvas.height = resolution
    const image = ctx.createImageData(resolution, resolution)
    const draw = (event: Event) => {
      const pixels = (event as CustomEvent<{ left: Uint8Array; right: Uint8Array }>).detail[side]
      for (let row = 0; row < resolution; row++) {
        const source = (resolution - row - 1) * resolution * 4
        image.data.set(pixels.subarray(source, source + resolution * 4), row * resolution * 4)
      }
      ctx.putImageData(image, 0, 0)
    }
    window.addEventListener("flyvis-eye-frame", draw)
    return () => window.removeEventListener("flyvis-eye-frame", draw)
  }, [side])
  return <div className="eye-image"><span>{label}</span><canvas ref={ref} /></div>
}

function RetinaMap({ values, accent, label }: { values: ArrayLike<number>; accent: string; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const ratio = Math.min(window.devicePixelRatio, 2)
    const rect = canvas.getBoundingClientRect()
    canvas.width = Math.max(1, rect.width * ratio)
    canvas.height = Math.max(1, rect.height * ratio)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)
    const size = Math.min(rect.width / 34, rect.height / 31)
    const cx = rect.width / 2
    const cy = rect.height / 2
    HEX_COORDS.forEach(([q, r], i) => {
      const x = cx + size * Math.sqrt(3) * (q + r / 2)
      const y = cy + size * 1.5 * r
      const v = values[i] ?? 0
      const c = new THREE.Color("#17241f").lerp(new THREE.Color(accent), Math.pow(v, 1.35))
      ctx.fillStyle = `rgb(${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)} / ${0.45 + v * 0.55})`
      ctx.beginPath()
      for (let side = 0; side < 6; side += 1) {
        const angle = (Math.PI / 180) * (60 * side - 30)
        const px = x + Math.cos(angle) * size * 0.74
        const py = y + Math.sin(angle) * size * 0.74
        if (side === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      ctx.fill()
    })
  }, [values, accent])
  return <div className="retina-frame"><span>{label}</span><canvas ref={ref} /></div>
}

function TraceChart({ samples, color }: { samples: Array<[number, number, number]>; color: string }) {
  const paths = useMemo(() => [0, 1, 2].map((line) => {
    const points = Array.from({ length: 58 }, (_, i) => {
      const x = (i / 57) * 100
      const sample = samples[Math.max(0, samples.length - 58 + i)]?.[line] ?? 0
      const y = 36 - Math.max(-1, Math.min(1, sample)) * 26
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    return `M${points.join(" L")}`
  }), [samples])
  return (
    <svg className="trace-chart" viewBox="0 0 100 72" preserveAspectRatio="none" role="img" aria-label="神经活动时间曲线">
      {[12, 29, 46, 63].map((y) => <line key={y} x1="0" y1={y} x2="100" y2={y} className="grid-line" />)}
      {paths.map((path, i) => <path key={i} d={path} fill="none" stroke={i === 0 ? color : i === 1 ? "#68c7cc" : "#f2c46d"} strokeWidth={i === 0 ? 1.8 : 1.15} opacity={1 - i * 0.18} vectorEffect="non-scaling-stroke" />)}
      <line x1="84" y1="4" x2="84" y2="68" className="cursor-line" />
    </svg>
  )
}

function Metric({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: string }) {
  return <div className="metric"><span>{label}</span><strong style={accent ? { color: accent } : undefined}>{value}<small>{unit}</small></strong></div>
}

export default function Home() {
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
  const [visualEffect, setVisualEffect] = useState<VisualEffect>({ yawRate: 0, headingChange: 0, heightOffset: 0 })
  const [eyeFrames, setEyeFrames] = useState<EyeFrames | null>(null)
  const [flyvis, setFlyvis] = useState<FlyvisActivity | null>(null)
  const [olfaction, setOlfaction] = useState<OlfactionActivity>({ left: 0, right: 0, leftHz: 0, rightHz: 0, windLeftHz: 0, windRightHz: 0, wind: [0.035, -0.015, -0.58], gradient: [0, 0], field: 0, proximity: 0 })
  const [visionStatus, setVisionStatus] = useState<VisionStatus>("loading")
  const [trace, setTrace] = useState<Array<[number, number, number]>>([])
  const [odorTrace, setOdorTrace] = useState<Array<[number, number, number]>>([])
  const [activeTab, setActiveTab] = useState("vision")
  const [cnsEverOpened, setCnsEverOpened] = useState(false)
  const [cnsMetrics, setCnsMetrics] = useState<CnsMetrics>({ status: "idle", modelTimeMs: 0, spikesPerSecond: 0, active: 0, regions: [0, 0, 0], motor: null })
  const simulationRef = useRef({ running, speed })
  useEffect(() => {
    simulationRef.current = { running, speed }
  }, [running, speed])
  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext }).modelContext
    if (!context?.registerTool) return
    const lifecycle = new AbortController()
    const register = context.registerTool({
      name: "control_fly_simulation",
      title: "Control autonomous fly simulation",
      description: "Pause, resume, reset, or change the speed of the single autonomous odor-seeking forest task.",
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
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object.")
        const value = input as Record<string, unknown>
        if (value.speed !== undefined && (typeof value.speed !== "number" || value.speed < 0.25 || value.speed > 2)) throw new Error("Speed must be between 0.25 and 2.")
        if (value.running !== undefined && typeof value.running !== "boolean") throw new Error("Running must be boolean.")
        if (value.reset !== undefined && typeof value.reset !== "boolean") throw new Error("Reset must be boolean.")
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
        return { task: "autonomous_odor_forest", controllerMode: "embodied", speed: next.speed, running: next.running, reset: value.reset === true }
      },
    }, { signal: lifecycle.signal })
    void Promise.resolve(register).catch((error) => console.warn("WebMCP registration failed", error))
    return () => lifecycle.abort()
  }, [])
  const handleFlyvis = useCallback((activity: FlyvisActivity) => {
    setFlyvis(activity)
    setTrace((previous) => [...previous.slice(-57), [Math.tanh(activity.selectedMean * 0.4), activity.yaw, activity.lift]])
  }, [])
  const handleOlfaction = useCallback((activity: OlfactionActivity) => {
    setOlfaction(activity)
    setOdorTrace((previous) => [...previous.slice(-57), [Math.min(1, activity.left * 1.6), Math.min(1, activity.right * 1.6), Math.max(-1, Math.min(1, (activity.windRightHz - activity.windLeftHz) / 60))]])
  }, [])
  const selected = CELL_TYPES.find((cell) => cell.id === cellType) ?? CELL_TYPES[5]
  const emptyEye = useMemo(() => new Float32Array(HEX_COORDS.length), [])
  const leftEye = eyeFrames?.luminanceLeft ?? emptyEye
  const rightEye = eyeFrames?.luminanceRight ?? emptyEye
  const neural = useMemo(() => {
    if (!flyvis || flyvis.selected !== cellType) return emptyEye
    return Float32Array.from(flyvis.left, (value, index) => Math.max(0, Math.min(1, 0.5 + (value + flyvis.right[index]) * 0.35)))
  }, [flyvis, cellType, emptyEye])
  const direction = visualEffect.yawRate * 180 / Math.PI
  const activity = flyvis?.selectedMean ?? 0
  const stageIndex = TRIAL_STAGES.findIndex((stage) => stage.id === trialStage)
  const reset = useCallback(() => { setSimTime(0); setTrace([]); setOdorTrace([]); setRunning(true); setTrialStage("grounded"); setVisualEffect({ yawRate: 0, headingChange: 0, heightOffset: 0 }); setResetToken((value) => value + 1) }, [])
  const enterFullscreen = useCallback(() => { document.documentElement.requestFullscreen?.() }, [])

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark" aria-hidden="true"><Eye size={19} /></div><div className="brand-title">FLYVIS <span>OBSERVATORY</span></div></div>
        <div className="topbar-status" aria-label="仿真状态"><span className={`live-dot ${running && cnsMetrics.status === "ready" ? "is-live" : ""}`} /><strong>{cnsMetrics.status === "error" ? "CNS 异常" : cnsMetrics.status !== "ready" ? "CNS 加载中" : running ? "自动飞行" : "已暂停"}</strong></div>
        <div className="topbar-actions"><Button variant="ghost" size="icon-sm" onClick={reset} aria-label="重置仿真"><RotateCcw /></Button><Button variant="ghost" size="icon-sm" onClick={enterFullscreen} aria-label="全屏"><Maximize2 /></Button></div>
      </header>

      <section className="control-strip" aria-label="仿真控制">
        <Button className="run-button" onClick={() => setRunning((value) => !value)}>{running ? <Pause /> : <Play />}{running ? "暂停" : "继续"}</Button>
        <div className="mission-status"><span>林间寻香</span><strong>{TRIAL_STAGES[stageIndex]?.label ?? "叶面待机"}</strong><div className="mission-progress" aria-label={`任务进度：${TRIAL_STAGES[stageIndex]?.label ?? "叶面待机"}`}>{TRIAL_STAGES.map((stage, index) => <i key={stage.id} className={index <= stageIndex ? "is-active" : ""} />)}</div></div>
        <div className="control-group speed-control"><span>速度 <strong>{speed.toFixed(1)}×</strong></span><Slider aria-label="仿真速度" min={0.25} max={2} step={0.25} value={[speed]} onValueChange={(value) => setSpeed(value[0])} /></div>
        <div className="sim-clock"><span>仿真时间 · 高度 {bodyHeight.toFixed(1)} m</span><strong>{simTime.toFixed(1)} s</strong></div>
      </section>

      <div className="workspace">
        <section className="world-panel panel">
          <WorldCanvas running={running} speed={speed} behavior={behavior} controllerMode={controllerMode} resetToken={resetToken} cellType={cellType} visualControl={visualControl} onCollision={setCollision} onFlightPhase={setFlightPhase} onTrialStage={setTrialStage} onOlfaction={handleOlfaction} onEyeFrames={setEyeFrames} onFlyvis={handleFlyvis} onVisionStatus={setVisionStatus} onSimulationTime={setSimTime} onBodyHeight={setBodyHeight} onVisualEffect={setVisualEffect} onCnsMetrics={setCnsMetrics} />
          <div className="world-vignette" />
          <div className={`world-hud ${collision.active ? "is-contact" : ""}`} aria-label={`飞行状态：${flightPhase}；碰撞：${collision.active ? collision.kind : "无"}`}>
            <strong>{collision.active ? `接触 · ${collision.kind}` : flightPhase === "grounded" ? "停驻" : flightPhase === "takeoff" ? "起飞" : flightPhase === "landing" ? "降落" : "巡航"}</strong>
            <span>{cnsMetrics.status === "ready" ? `DN 转向 ${direction.toFixed(1)}°/s · 飞行 ${cnsMetrics.motor?.flightHz.toFixed(0) ?? "0"} Hz` : cnsMetrics.status === "error" ? "CNS 运行失败" : "CNS 加载中"}</span>
          </div>
        </section>

        <aside className="data-panel panel">
          <Tabs value={activeTab} onValueChange={(value) => { setActiveTab(value); if (value === "cns") setCnsEverOpened(true) }} className="h-full">
            <TabsList variant="line" className="data-tabs four-tabs"><TabsTrigger value="vision"><Aperture />复眼</TabsTrigger><TabsTrigger value="flyvis"><Activity />Flyvis</TabsTrigger><TabsTrigger value="olfaction"><Wind />嗅觉</TabsTrigger><TabsTrigger value="cns"><BrainCircuit />CNS</TabsTrigger></TabsList>
            <TabsContent value="vision" className="tab-scroll">
              <section className="panel-section"><div className="section-heading"><div><span>SCENE → COMPOUND EYES</span><strong>果蝇的双眼画面</strong></div><span className="provenance derived">{visionStatus === "ready" ? "实时" : visionStatus === "error" ? "异常" : "加载中"}</span></div><div className="eye-grid"><EyeImage side="left" label="左眼" /><EyeImage side="right" label="右眼" /></div><p className="microcopy">两台头部相机看到的树林与花朵，经复眼采样后送入 FlyVis。</p><div className="eye-grid hex-input-grid"><RetinaMap values={leftEye} accent="#b8e878" label="左眼 · 721" /><RetinaMap values={rightEye} accent="#77d9d2" label="右眼 · 721" /></div></section>
            </TabsContent>
            <TabsContent value="flyvis" className="tab-scroll">
              <section className="panel-section"><div className="section-heading"><div><span>FLYVIS ACTIVITY</span><strong>视觉神经活动</strong></div><span className="provenance learned">模型</span></div><div className="cell-type-row" role="list" aria-label="视觉细胞类型">{CELL_TYPES.map((cell) => <button key={cell.id} role="listitem" className={cellType === cell.id ? "active" : ""} onClick={() => setCellType(cell.id)} style={{ "--cell-color": cell.color } as React.CSSProperties}><i /><strong>{cell.id}</strong><span>{cell.stage}</span></button>)}</div><div className="neural-map-wrap"><RetinaMap values={neural} accent={selected.color} label={`${selected.id} · 活动变化`} /><div className="neural-readout"><span>相对灰场均值</span><strong style={{ color: selected.color }}>{activity.toFixed(3)}</strong><i style={{ width: `${Math.min(100, Math.abs(activity) * 25)}%`, backgroundColor: selected.color }} /></div></div><p className="microcopy">每眼 45,669 个模型单元；颜色表示相对中性灰输入的活动变化。</p></section>
              <section className="panel-section"><div className="section-heading compact"><div><span>ACTIVITY TRACE</span><strong>{selected.id} 与运动通道</strong></div><span className="trace-time">最近 5.8 s</span></div><TraceChart samples={trace} color={selected.color} /><div className="trace-legend"><span><i style={{ background: selected.color }} />{selected.id}</span><span><i className="cyan" />T4/T5 转向</span><span><i className="amber" />T4/T5 升降</span></div><p className="microcopy">FlyVis 活动是视觉读数；身体转向来自 CNS 下降神经元。</p></section>
            </TabsContent>
            <TabsContent value="olfaction" className="tab-scroll">
              <section className="panel-section"><div className="section-heading"><div><span>ODOR INPUT</span><strong>左右触角</strong></div><span className="provenance learned">4 个花源</span></div><div className="antenna-grid"><div><span>左触角</span><strong>{olfaction.leftHz.toFixed(1)} Hz</strong><i><b style={{ width: `${Math.min(100, olfaction.leftHz / 1.2)}%` }} /></i><small>浓度 {olfaction.left.toFixed(3)}</small></div><div><span>右触角</span><strong>{olfaction.rightHz.toFixed(1)} Hz</strong><i><b style={{ width: `${Math.min(100, olfaction.rightHz / 1.2)}%` }} /></i><small>浓度 {olfaction.right.toFixed(3)}</small></div></div><TraceChart samples={odorTrace} color="#f0b56e" /><div className="trace-legend"><span><i style={{ background: "#f0b56e" }} />左侧浓度</span><span><i className="cyan" />右侧浓度</span><span><i className="amber" />风向差</span></div><div className="mini-metrics"><Metric label="平滑浓度" value={olfaction.field.toFixed(3)} /><Metric label="近源信号" value={olfaction.proximity.toFixed(3)} /><Metric label="梯度" value={Math.hypot(...olfaction.gradient).toFixed(3)} accent="#b8df72" /></div><p className="microcopy">花香不可见；触角读数随气团起伏，平滑浓度显示底层梯度。</p></section>
              <section className="panel-section"><div className="section-heading compact"><div><span>WIND INPUT</span><strong>相对风向</strong></div><Wind size={17} /></div><div className="mini-metrics"><Metric label="JO 左" value={olfaction.windLeftHz.toFixed(1)} unit="Hz" /><Metric label="JO 右" value={olfaction.windRightHz.toFixed(1)} unit="Hz" /><Metric label="风速" value={Math.hypot(olfaction.wind[0], olfaction.wind[1], olfaction.wind[2]).toFixed(2)} unit="m/s" accent="#77d9d2" /></div><p className="microcopy">触角的气味与风向信号进入 CNS；近源气味梯度帮助对准花盘。</p></section>
            </TabsContent>
            <TabsContent value="cns" forceMount={cnsEverOpened ? true : undefined} className="tab-scroll">
              <section className="panel-section cns-section">
                <div className="section-heading"><div><span>WHOLE CNS</span><strong>全脑神经活动 · 165,122 个神经元</strong></div><span className="provenance learned">{cnsMetrics.status === "ready" ? "实时" : cnsMetrics.status === "error" ? "异常" : "加载中"}</span></div>
                {cnsEverOpened && <WholeBrainCanvas running={running} active={activeTab === "cns"} metrics={cnsMetrics} />}
                <div className="brain-stat-grid"><Metric label="活跃神经元" value={cnsMetrics.status === "ready" ? cnsMetrics.active.toLocaleString() : "—"} accent="#b8df72" /><Metric label="脉冲 / 神经秒" value={cnsMetrics.status === "ready" ? cnsMetrics.spikesPerSecond.toLocaleString() : "—"} /><Metric label="神经模型时间" value={cnsMetrics.status === "ready" ? (cnsMetrics.modelTimeMs / 1000).toFixed(2) : "—"} unit="s" accent="#f0b56e" /></div>
                <div className="brain-region-legend"><span><i className="optic-region" />视叶 {cnsMetrics.regions[0].toLocaleString()}/s</span><span><i className="central-region" />中央脑 {cnsMetrics.regions[1].toLocaleString()}/s</span><span><i className="motor-region" />下降神经元 / VNC {cnsMetrics.regions[2].toLocaleString()}/s</span></div>
                <div className="brain-motor-readout"><span>转向 DN 左 / 右 <strong>{cnsMetrics.motor?.turnLHz.toFixed(1) ?? "—"} / {cnsMetrics.motor?.turnRHz.toFixed(1) ?? "—"} Hz</strong></span><span>起飞 / 飞行 DN <strong>{cnsMetrics.motor?.takeoffHz.toFixed(1) ?? "—"} / {cnsMetrics.motor?.flightHz.toFixed(1) ?? "—"} Hz</strong></span><span>翅肌 MN（监测）<strong>{cnsMetrics.motor?.wingPowerHz.toFixed(1) ?? "—"} Hz</strong></span></div>
                <details className="model-details"><summary>模型边界与导航说明</summary><p>局部气味梯度、双触角差、相对风和碰撞被人工导航策略转换为 CNS 输入；转向、前进与飞行由 CNS 发放驱动，近花刹停由低层执行器完成。执行器不读取花朵坐标。身体使用 FlyBody 外形和浏览器动力学代理，并非 MuJoCo，也不是经过验证的果蝇行为预测器。</p></details>
              </section>
            </TabsContent>
          </Tabs>
        </aside>
      </div>

    </main>
  )
}
