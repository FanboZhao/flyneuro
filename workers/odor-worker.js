// Deterministic, browser-scale odor model for the autonomous forest task.
// Four flowers continuously release odor into a wind-borne mean plume, with
// advecting puffs adding intermittent fluctuations. The source core remains
// present between puffs and on the upwind side of each flower.
// Only locally sampled signals are sent to the fly, never flower coordinates.

const SOURCES = [
  { x: 0, y: 2.55, z: 13.2, strength: 1.5 },
  { x: -6.8, y: 2.55, z: 9.2, strength: 0.62 },
  { x: 6.6, y: 2.55, z: 7, strength: 0.58 },
  { x: -6.1, y: 2.55, z: 1, strength: 0.44 },
]
const WIND = { x: 0.035, y: -0.015, z: -0.58 }
const MAX_AGE = 54
const PUFFS = 256
const PUFFS_PER_SOURCE = PUFFS / SOURCES.length
const WIND_SPEED = Math.hypot(WIND.x, WIND.z)
const WIND_X = WIND.x / WIND_SPEED
const WIND_Z = WIND.z / WIND_SPEED

let running = true
let elapsed = 0
let adaptation = [0, 0]
let lastSampleTime = 0

const hash = (n, seed = 0) => {
  const value = Math.sin(n * 91.73 + seed * 37.19) * 43758.5453
  return value - Math.floor(value)
}

function puffAt(index, time) {
  const sourceIndex = index % SOURCES.length
  const source = SOURCES[sourceIndex]
  const laneIndex = Math.floor(index / SOURCES.length)
  const period = MAX_AGE / PUFFS_PER_SOURCE
  const age = ((time - laneIndex * period) % MAX_AGE + MAX_AGE) % MAX_AGE
  const phase = laneIndex + sourceIndex * 101 + Math.floor((time - laneIndex * period) / MAX_AGE) * PUFFS_PER_SOURCE
  const sway = Math.sin(age * (0.72 + hash(phase, 4) * 0.28) + hash(phase, 5) * 6.28)
  const wake = 0.16 + age * 0.045
  const dilution = (0.65 / (0.65 + age * 0.05)) ** 1.25
  return {
    x: source.x + WIND.x * age + sway * wake + (hash(phase, 1) - 0.5) * wake * 1.4,
    y: Math.max(0.45, source.y + WIND.y * age + Math.sin(age * 0.31 + phase) * wake * 0.22),
    z: source.z + WIND.z * age,
    age,
    sigma: 0.16 + age * 0.055,
    strength: source.strength * (0.62 + hash(phase, 2) * 0.72) * dilution,
  }
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

// Continuous emission keeps concentration highest at each flower, including
// just upwind of it. The finite source radius also avoids a point singularity.
function sourceConcentrationAt(x, y, z) {
  let total = 0
  for (const source of SOURCES) {
    const dx = (x - source.x) / 1.05
    const dy = (y - source.y) / 0.8
    const dz = (z - source.z) / 1.05
    total += source.strength * 0.62 * Math.exp(-0.5 * (dx * dx + dy * dy + dz * dz))
  }
  return total
}

// The time-averaged plume widens and dilutes downwind. A smooth release gate
// connects it to the source core without the old hard cut-off near the flower.
function meanFieldAt(x, y, z) {
  let total = sourceConcentrationAt(x, y, z)
  for (const source of SOURCES) {
    const dx = x - source.x
    const dz = z - source.z
    const downwind = dx * WIND_X + dz * WIND_Z
    const distance = Math.max(0, downwind)
    const crosswind = dx * -WIND_Z + dz * WIND_X
    const centerY = Math.max(0.45, source.y + WIND.y * distance / WIND_SPEED)
    const width = 0.7 + distance * 0.105
    const verticalWidth = 0.65 + distance * 0.065
    const cross = crosswind / width
    const vertical = (y - centerY) / verticalWidth
    const release = smoothstep(-0.45, 0.55, downwind)
    const dilution = 1 / (1 + distance * 0.12)
    total += source.strength * 0.24 * release * dilution * Math.exp(-0.5 * (cross * cross + vertical * vertical))
  }
  return Math.min(1.5, total)
}

function concentrationAt(x, y, z) {
  let fluctuation = 0
  for (let i = 0; i < PUFFS; i++) {
    const p = puffAt(i, elapsed)
    const dx = x - p.x
    const dy = (y - p.y) * 0.7
    const dz = z - p.z
    const d2 = dx * dx + dy * dy + dz * dz
    const reach = p.sigma * 3.25
    if (d2 < reach * reach) fluctuation += p.strength * Math.exp(-d2 / (2 * p.sigma * p.sigma))
  }
  return Math.min(1.5, meanFieldAt(x, y, z) + fluctuation * 0.055)
}

function sourceCoreAt(x, y, z) {
  let strongest = 0
  for (const source of SOURCES) {
    const dx = x - source.x
    const dy = (y - source.y) * 0.55
    const dz = z - source.z
    strongest = Math.max(strongest, Math.exp(-(dx * dx + dy * dy + dz * dz) / (2 * 0.95 * 0.95)))
  }
  return strongest
}

function sample(data) {
  const now = Number(data.now) || performance.now()
  const dt = lastSampleTime ? Math.min(0.2, Math.max(0, (now - lastSampleTime) / 1000)) : 0.05
  lastSampleTime = now
  if (running) elapsed += dt * Math.max(0.25, Math.min(2, Number(data.speed) || 1))
  const x = Number(data.x)
  const y = Number(data.y)
  const z = Number(data.z)
  const heading = Number(data.heading) || 0
  const rightX = Math.cos(heading)
  const rightZ = -Math.sin(heading)
  const separation = 0.115
  const sensorY = y + 0.09
  const left = concentrationAt(x - rightX * separation, sensorY, z - rightZ * separation)
  const right = concentrationAt(x + rightX * separation, sensorY, z + rightZ * separation)
  const raw = [left, right]
  const rates = raw.map((value, side) => {
    const tau = 2.8
    adaptation[side] += (value - adaptation[side]) * (1 - Math.exp(-dt / tau))
    const hill = value * value / (0.0225 + value * value)
    return 3 + 112 * hill / (1 + adaptation[side] * 1.7)
  })

  const forwardX = -Math.sin(heading)
  const forwardZ = -Math.cos(heading)
  const windLength = Math.hypot(WIND.x, WIND.z)
  const windX = WIND.x / windLength
  const windZ = WIND.z / windLength
  const headwind = Math.max(0, -(forwardX * windX + forwardZ * windZ))
  const lateral = rightX * windX + rightZ * windZ
  const windLeftHz = 6 + 58 * Math.max(0, Math.min(1, headwind - lateral * 0.58))
  const windRightHz = 6 + 58 * Math.max(0, Math.min(1, headwind + lateral * 0.58))

  const epsilon = 0.22
  const inverseStep = 1 / (2 * epsilon)
  const gradientX = (meanFieldAt(x + epsilon, sensorY, z) - meanFieldAt(x - epsilon, sensorY, z)) * inverseStep
  const gradientZ = (meanFieldAt(x, sensorY, z + epsilon) - meanFieldAt(x, sensorY, z - epsilon)) * inverseStep
  // Near-source steering is derived from the same continuously emitted odor,
  // rather than from a separate broad, source-centred homing signal.
  const coreGradient = [
    (sourceConcentrationAt(x + epsilon, sensorY, z) - sourceConcentrationAt(x - epsilon, sensorY, z)) * inverseStep,
    (sourceConcentrationAt(x, sensorY, z + epsilon) - sourceConcentrationAt(x, sensorY, z - epsilon)) * inverseStep,
  ]
  postMessage({
    type: "sample",
    left,
    right,
    leftHz: rates[0],
    rightHz: rates[1],
    windLeftHz,
    windRightHz,
    wind: [WIND.x, WIND.y, WIND.z],
    gradient: [gradientX, gradientZ],
    coreGradient,
    homing: Math.min(1, sourceConcentrationAt(x, sensorY, z)),
    field: meanFieldAt(x, sensorY, z),
    proximity: sourceCoreAt(x, sensorY, z),
  })
}

self.onmessage = ({ data }) => {
  if (data.type === "sample") sample(data)
  else if (data.type === "run") running = data.running !== false
  else if (data.type === "reset") {
    elapsed = 0
    adaptation = [0, 0]
    lastSampleTime = 0
  }
}
