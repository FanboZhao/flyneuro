// Browser implementation of the exported FlyVis flow/0000/000 rate network.
// Model export and dynamics: Lulzx/fly-brain (MIT), derived from TuragaLab/flyvis.
// One independent 45,669-node state per eye; both states share 1,513,231 weights.
const N_COLUMNS = 721
const DT_MS = 20
const MODEL_URL = "/data/flyvis-flow-0000-000.bin"
const META_URL = "/data/flyvis-flow-0000-000.json"
const CNS_MAP_URL = "/data/flyvis_map.json"
const TYPES = ["R1–6", "L1", "L2", "Mi1", "Tm3", "T4a", "T4b", "T5a"]
const DIRECTIONS = ["T4a", "T4b", "T4c", "T4d", "T5a", "T5b", "T5c", "T5d"]

let model = null
let selected = "T4a"
let images = null
let running = true
let speed = 1
let stepFraction = 0
let timer = 0
let stepCount = 0
let lastReport = 0
let lastFrameAt = 0
let lesionEye = null

const clamp = (v, low, high) => Math.max(low, Math.min(high, v))

function parseModel(buffer, meta, cnsMap) {
  const { N, E, types } = meta
  let offset = 0
  const take = (ArrayType, count) => {
    const size = count * ArrayType.BYTES_PER_ELEMENT
    const values = new ArrayType(buffer.slice(offset, offset + size))
    offset += size
    return values
  }
  const tid = take(Uint8Array, N)
  const u = take(Int16Array, N)
  const v = take(Int16Array, N)
  const bias = take(Float32Array, N)
  const tau = take(Float32Array, N)
  const indptr = take(Int32Array, N + 1)
  const target = take(Int32Array, E)
  const weight = take(Float32Array, E)
  if (offset !== buffer.byteLength || indptr[N] !== E) throw new Error("FlyVis model layout mismatch")
  const kdt = Float32Array.from(tau, (value) => 0.02 / Math.max(value, 0.02))
  const typeIndex = Object.fromEntries(types.map((name) => [name, new Int32Array(N_COLUMNS).fill(-1)]))
  for (let i = 0; i < N; i++) {
    const q = u[i], r = v[i]
    if (q < -15 || q > 15 || r < Math.max(-15, -q - 15) || r > Math.min(15, -q + 15)) continue
    let col = 0
    for (let x = -15; x < q; x++) col += Math.min(15, -x + 15) - Math.max(-15, -x - 15) + 1
    col += r - Math.max(-15, -q - 15)
    typeIndex[types[tid[i]]][col] = i
  }
  const baseline = new Float32Array(N)
  const scratch = new Float32Array(N)
  const grey = new Float32Array(N)
  for (let i = 0; i < N_COLUMNS * 8; i++) grey[i] = 0.5
  const cnsPairs = ["L", "R"].map((side) => {
    const pairs = cnsMap.eyes[side].pairs
    return { neuron: Uint32Array.from(pairs, (pair) => pair[0]), node: Int32Array.from(pairs, (pair) => pair[1]) }
  })
  const parsed = { N, E, bias, kdt, indptr, target, weight, typeIndex, baseline, scratch, grey, cnsPairs,
    eyes: [new Float32Array(N), new Float32Array(N)],
    acc: [new Float32Array(N), new Float32Array(N)],
    input: [new Float32Array(N), new Float32Array(N)] }
  baseline.set(bias)
  for (let i = 0; i < 150; i++) stepEye(parsed, baseline, scratch, grey)
  parsed.eyes[0].set(baseline)
  parsed.eyes[1].set(baseline)
  return parsed
}

function stepEye(state, voltage, acc, input) {
  const { N, bias, kdt, indptr, target, weight } = state
  acc.fill(0)
  for (let source = 0; source < N; source++) {
    const rate = voltage[source]
    if (rate <= 0) continue
    for (let edge = indptr[source], stop = indptr[source + 1]; edge < stop; edge++) {
      acc[target[edge]] += weight[edge] * rate
    }
  }
  for (let i = 0; i < N; i++) voltage[i] += kdt[i] * (-voltage[i] + bias[i] + acc[i] + input[i])
}

function setInput(destination, luminance) {
  // The exported FlyVis stimulus maps the same 721-column luminance to R1-R8.
  for (let receptor = 0; receptor < 8; receptor++) destination.set(luminance, receptor * N_COLUMNS)
}

function mapForType(state, eye, typeName) {
  const result = new Float32Array(N_COLUMNS)
  const cellTypes = typeName === "R1–6" ? ["R1", "R2", "R3", "R4", "R5", "R6"] : [typeName]
  const voltage = state.eyes[eye]
  for (const name of cellTypes) {
    const indexes = state.typeIndex[name]
    if (!indexes) continue
    for (let col = 0; col < N_COLUMNS; col++) {
      const index = indexes[col]
      if (index >= 0) result[col] += (voltage[index] - state.baseline[index]) / cellTypes.length
    }
  }
  return result
}

function meanActivity(state, eye, typeName) {
  const indexes = state.typeIndex[typeName]
  if (!indexes) return 0
  const voltage = state.eyes[eye]
  const baseline = state.baseline
  let total = 0, count = 0
  for (let col = 0; col < N_COLUMNS; col++) {
    const index = indexes[col]
    if (index < 0) continue
    total += Math.max(0, voltage[index] - baseline[index])
    count++
  }
  return count ? total / count : 0
}

function directionalValue(state, eye, typeName, column) {
  const index = state.typeIndex[typeName]?.[column] ?? -1
  return index < 0 ? 0 : Math.max(0, state.eyes[eye][index] - state.baseline[index])
}

function report() {
  const state = model
  if (!state) return
  const directional = {}
  for (const typeName of DIRECTIONS) {
    directional[typeName] = [meanActivity(state, 0, typeName), meanActivity(state, 1, typeName)]
  }
  const horizontalA = directional.T4a[0] + directional.T4a[1] + directional.T5a[0] + directional.T5a[1]
  const horizontalB = directional.T4b[0] + directional.T4b[1] + directional.T5b[0] + directional.T5b[1]
  const verticalC = directional.T4c[0] + directional.T4c[1] + directional.T5c[0] + directional.T5c[1]
  const verticalD = directional.T4d[0] + directional.T4d[1] + directional.T5d[0] + directional.T5d[1]
  const yaw = clamp((horizontalB - horizontalA) / (horizontalA + horizontalB + 0.08), -1, 1)
  const lift = clamp((verticalD - verticalC) / (verticalC + verticalD + 0.08), -1, 1)
  const left = mapForType(state, 0, selected)
  const right = mapForType(state, 1, selected)
  const flow = new Float32Array(42 * 2)
  for (let i = 0; i < 42; i++) {
    const column = Math.min(N_COLUMNS - 1, Math.round((i + 0.5) * N_COLUMNS / 42))
    const eye = i % 2
    const a = directionalValue(state, eye, "T4a", column) + directionalValue(state, eye, "T5a", column)
    const b = directionalValue(state, eye, "T4b", column) + directionalValue(state, eye, "T5b", column)
    const c = directionalValue(state, eye, "T4c", column) + directionalValue(state, eye, "T5c", column)
    const d = directionalValue(state, eye, "T4d", column) + directionalValue(state, eye, "T5d", column)
    flow[i * 2] = (b - a) / (a + b + 0.08)
    flow[i * 2 + 1] = (d - c) / (c + d + 0.08)
  }
  const selectedMean = (left.reduce((sum, value) => sum + value, 0) + right.reduce((sum, value) => sum + value, 0)) / (N_COLUMNS * 2)
  const capacity = state.cnsPairs[0].neuron.length + state.cnsPairs[1].neuron.length
  const driveIndex = new Uint32Array(capacity)
  const driveRate = new Float32Array(capacity)
  let driven = 0
  for (let eye = 0; eye < 2; eye++) {
    if ((eye === 0 && lesionEye === "L") || (eye === 1 && lesionEye === "R")) continue
    const pairs = state.cnsPairs[eye]
    const voltage = state.eyes[eye]
    for (let i = 0; i < pairs.neuron.length; i++) {
      const node = pairs.node[i]
      const delta = voltage[node] - state.baseline[node]
      if (delta <= 0.02) continue
      driveIndex[driven] = pairs.neuron[i]
      driveRate[driven] = Math.min(200, 60 * delta)
      driven++
    }
  }
  const cnsIndices = driveIndex.slice(0, driven)
  const cnsRates = driveRate.slice(0, driven)
  postMessage({ type: "activity", selected, left, right, flow, selectedMean,
    yaw, lift, directional, stepCount, frameAgeMs: performance.now() - lastFrameAt,
    lesionEye, cnsIndices, cnsRates }, [left.buffer, right.buffer, flow.buffer, cnsIndices.buffer, cnsRates.buffer])
}

function tick() {
  if (!running || !model || !images) return
  stepFraction += speed
  const steps = Math.min(2, Math.floor(stepFraction))
  stepFraction -= steps
  if (!steps) return
  for (let eye = 0; eye < 2; eye++) setInput(model.input[eye], images[eye])
  for (let step = 0; step < steps; step++) {
    for (let eye = 0; eye < 2; eye++) stepEye(model, model.eyes[eye], model.acc[eye], model.input[eye])
    stepCount++
  }
  if (stepCount - lastReport >= 5) {
    lastReport = stepCount
    report()
  }
}

self.onmessage = (event) => {
  const message = event.data
  if (message.type === "frame") {
    images = [message.left, message.right]
    lastFrameAt = performance.now()
  } else if (message.type === "select") {
    if (TYPES.includes(message.selected)) selected = message.selected
  } else if (message.type === "run") {
    running = message.running
  } else if (message.type === "speed") {
    speed = clamp(message.speed, 0.25, 2)
  } else if (message.type === "lesion") {
    lesionEye = message.eye === "L" || message.eye === "R" ? message.eye : null
  } else if (message.type === "reset" && model) {
    model.eyes[0].set(model.baseline)
    model.eyes[1].set(model.baseline)
    stepCount = 0
    lastReport = 0
    stepFraction = 0
  }
}

Promise.all([
  fetch(MODEL_URL).then((response) => { if (!response.ok) throw new Error(`weights ${response.status}`); return response.arrayBuffer() }),
  fetch(META_URL).then((response) => { if (!response.ok) throw new Error(`metadata ${response.status}`); return response.json() }),
  fetch(CNS_MAP_URL).then((response) => { if (!response.ok) throw new Error(`CNS map ${response.status}`); return response.json() }),
]).then(([buffer, meta, cnsMap]) => {
  model = parseModel(buffer, meta, cnsMap)
  postMessage({ type: "ready", neuronsPerEye: model.N, edgesPerEye: model.E, backend: "CPU worker" })
  timer = setInterval(tick, DT_MS)
}).catch((error) => postMessage({ type: "error", message: String(error) }))
