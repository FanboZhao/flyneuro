import type { TrialStage } from "./types"

export const HEX_RADIUS = 15
// The rendered FlyBody wings reach about 0.97 scene units from the body centre
// over a full beat. Keep a small margin around their swept horizontal envelope.
export const FLY_WING_SWEEP_RADIUS = 1.04
export const TREE_COLLIDER_MARGIN = 0.1
export const TREE_PASSAGE_MARGIN = 0.16
// Offscreen WebGL targets return linear RGB bytes. Convert them before both
// displaying the eye images and sampling the same image for FlyVis.
export const LINEAR_TO_SRGB_BYTES = Uint8Array.from({ length: 256 }, (_, byte) => {
  const linear = byte / 255
  return Math.round(
    255 * (linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055),
  )
})
export const HEX_COORDS = (() => {
  const coords: Array<[number, number]> = []
  for (let q = -HEX_RADIUS; q <= HEX_RADIUS; q += 1) {
    const rMin = Math.max(-HEX_RADIUS, -q - HEX_RADIUS)
    const rMax = Math.min(HEX_RADIUS, -q + HEX_RADIUS)
    for (let r = rMin; r <= rMax; r += 1) coords.push([q, r])
  }
  return coords
})()

export const CELL_TYPES = [
  { id: "R1–6", stage: "Photoreceptor", color: "#f6df72" },
  { id: "L1", stage: "Lamina · ON", color: "#7de4bb" },
  { id: "L2", stage: "Lamina · OFF", color: "#55cfe2" },
  { id: "Mi1", stage: "Medulla", color: "#c4ed82" },
  { id: "Tm3", stage: "Medulla", color: "#ffb86d" },
  { id: "T4a", stage: "Motion · F→B", color: "#ff7f6a" },
  { id: "T4b", stage: "Motion · B→F", color: "#d688ff" },
  { id: "T5a", stage: "OFF motion", color: "#ff5ea8" },
]

export const SCENTED_FLOWERS = [
  { x: 0, z: 13.2, color: 0xf16d88 },
  { x: -6.8, z: 9.2, color: 0xd98fe8 },
  { x: 6.6, z: 7, color: 0xf49c5f },
  { x: -6.1, z: 1, color: 0xe8d266 },
] as const

export const TRIAL_STAGES: Array<{ id: TrialStage; label: string }> = [
  { id: "grounded", label: "叶面待机" },
  { id: "takeoff", label: "感觉触发起飞" },
  { id: "forest", label: "林间穿越" },
  { id: "approach", label: "气味源接近" },
  { id: "landing", label: "花盘降落" },
  { id: "success", label: "稳定接触" },
]

// Calibrated against the FlyBody joint-local axes. These offsets keep every
// claw below the thorax during flight; left/right values differ because the
// source model mirrors joint frames rather than joint-angle signs.
export const FLIGHT_LEG_FOLD = {
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
