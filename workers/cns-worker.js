// Whole-CNS connectome LIF activity, run off the rendering thread.
// Graph/codec/kernel follow Lulzx/fly-brain (MIT); visual coupling is isolated here.
import { decodeGraph } from "./cns/graph.js"
import { decodeNeurons } from "./cns/neurons.js"
import { LIFNetwork } from "./cns/lif.js"
import { MotorReadout } from "./cns/motor-readout.js"

const URLS = {
  graph: new URL("../data/graph.flyg", self.location.href).href,
  neurons: new URL("../data/fly-brain-neurons.flyn", self.location.href).href,
  meta: new URL("../data/meta.json", self.location.href).href,
  size: new URL("../data/neuron_size.bin", self.location.href).href,
  sign: new URL("../data/ntsign.bin", self.location.href).href,
  params: new URL("../data/brain_params.json", self.location.href).href,
}

let net = null
let running = true
let speed = 1
let timer = 0
let lastReport = 0
let pendingDrive = null
let visualDriven = new Uint32Array(0)
let olfactoryDriven = new Uint32Array(0)
let navigationDriven = new Uint32Array(0)
let sensoryPools = null
let spikes = []
let spikeWindowMs = 0
let regionOf = null
let regionSpikes = [0, 0, 0]
let motorReadout = null
let mode = "forage"
let controllerMode = "embodied"
let stimulateTakeoffUntil = -1
let stimulateLandingUntil = -1
let flightStimulusOn = false
let takeoffDriveOn = false
let navigationLanding = false

const INTRINSIC_FORWARD_DRIVE = { forage: 6, patrol: 10, track: 14 }

const read = async (url, json = false) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return json ? response.json() : response.arrayBuffer()
}

function regionIndex(name) {
  if (/^(ol_|visual_projection|visual_centrifugal)/.test(name)) return 0
  if (/^(vnc_|descending|ascending|sensory_ascending|sensory_descending|efferent_)/.test(name)) return 2
  return 1
}

function makeScales(neurons, meta, size, params, mapped) {
  const N = neurons.N
  const groups = meta.superclasses.map(regionIndex)
  const values = [[], [], []]
  regionOf = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    const region = groups[neurons.superclass[i]]
    regionOf[i] = region
    if (size[i] > 0) values[region].push(size[i])
  }
  const median = values.map((items) => {
    items.sort((a, b) => a - b)
    return items[items.length >> 1] || 1
  })
  const inScale = new Float32Array(N)
  const sensoryMask = new Uint8Array(N)
  const alpha = params.sizeAlpha ?? 0.5
  for (let i = 0; i < N; i++) {
    const ratio = size[i] > 0 ? Math.min(20, Math.max(0.05, size[i] / median[regionOf[i]])) : 1
    inScale[i] = Math.min(1, Math.pow(ratio, -alpha))
    sensoryMask[i] = /sensory/.test(meta.superclasses[neurons.superclass[i]]) ? 1 : 0
  }
  for (const index of mapped) if (index < N) sensoryMask[index] = 1
  return { inScale, sensoryMask }
}

function applyVisualDrive(indices, rates) {
  if (!net) {
    pendingDrive = { indices, rates }
    return
  }
  for (let i = 0; i < visualDriven.length; i++) net.setDriveOne(visualDriven[i], 0)
  for (let i = 0; i < indices.length; i++) net.setDriveOne(indices[i], rates[i])
  visualDriven = indices
}

function makeSensoryPools(meta) {
  const pools = { odorLeft: [], odorRight: [], windLeft: [], windRight: [] }
  for (let i = 0; i < meta.N; i++) {
    const type = meta.types[i] || ""
    const instance = meta.instances[i] || ""
    // DM1, VA2 and DM6 form a broad appetitive fruit / fermentation blend.
    // The hemisphere comes from the FlyWire instance label because peripheral
    // sensory cells are unassigned in the compact central side table.
    if (/^ORN_(DM1|VA2|DM6)$/.test(type)) {
      if (/_L$/.test(instance)) pools.odorLeft.push(i)
      else if (/_R$/.test(instance)) pools.odorRight.push(i)
    }
    if (/^JO-/.test(type)) {
      if (/_L$/.test(instance)) pools.windLeft.push(i)
      else if (/_R$/.test(instance)) pools.windRight.push(i)
    }
  }
  return Object.fromEntries(Object.entries(pools).map(([key, pool]) => [key, Uint32Array.from(pool)]))
}

function applyOlfactoryDrive(data) {
  if (!net || !sensoryPools) return
  for (let i = 0; i < olfactoryDriven.length; i++) net.setDriveOne(olfactoryDriven[i], 0)
  const assignments = [
    [sensoryPools.odorLeft, data.leftHz || 0],
    [sensoryPools.odorRight, data.rightHz || 0],
    [sensoryPools.windLeft, data.windLeftHz || 0],
    [sensoryPools.windRight, data.windRightHz || 0],
  ]
  const driven = []
  for (const [pool, rate] of assignments) {
    for (let i = 0; i < pool.length; i++) {
      net.setDriveOne(pool[i], rate)
      driven.push(pool[i])
    }
  }
  olfactoryDriven = Uint32Array.from(driven)
}

// The autonomous odor-guidance adapter writes a small set of intended rates
// into identified motor-related CNS pools. The embodied body controller still
// reads only spikes produced by the LIF network; it never receives odor values,
// gradients, task stages, or flower coordinates directly.
function applyNavigationDrive(data) {
  if (!net || !motorReadout) return
  for (let i = 0; i < navigationDriven.length; i++) net.setDriveOne(navigationDriven[i], 0)
  const turn = Math.max(-1, Math.min(1, Number(data.turn) || 0))
  const landing = data.landing === true
  const blocked = data.blocked === true
  const launch = data.launch === true && !landing
  const homing = Math.max(0, Math.min(1.5, Number(data.homing) || 0))
  const approach = Math.max(0, Math.min(1, (homing - 0.08) / 0.46))
  const assignments = new Map()
  const addPool = (pool, rate) => {
    for (const [index] of pool) assignments.set(index, Math.max(assignments.get(index) || 0, rate))
  }
  const steering = new Set([...motorReadout.pools.turnL, ...motorReadout.pools.turnR].map(([index]) => index))
  for (const [index] of motorReadout.pools.forward) {
    if (!steering.has(index)) assignments.set(index, landing ? 0 : blocked ? 22 : 72 * (1 - 0.94 * approach))
  }
  addPool(motorReadout.pools.flight, landing ? 0 : 108)
  addPool(motorReadout.pools.takeoff, launch ? 165 : 0)
  addPool(motorReadout.pools.turnL, 12 + Math.max(0, turn) * 120)
  addPool(motorReadout.pools.turnR, 12 + Math.max(0, -turn) * 120)
  for (const [index, rate] of assignments) net.setDriveOne(index, rate)
  navigationDriven = Uint32Array.from(assignments.keys())
  navigationLanding = landing
}

function report() {
  if (!net) return
  const fired = Uint32Array.from(spikes)
  let active = 0
  for (let i = 0; i < net.N; i++) if (net.trace[i] > 0.02) active++
  const motor = motorReadout.update(net.spikeCount, spikeWindowMs)
  postMessage({ type: "frame", t: net.t, spikes: fired, spikesWindow: fired.length,
    windowMs: spikeWindowMs, active, regionSpikes, motor }, [fired.buffer])
  spikes = []
  spikeWindowMs = 0
  regionSpikes = [0, 0, 0]
  lastReport = performance.now()
}

function pump() {
  if (!running || !net) return
  const started = performance.now()
  const maxSteps = Math.max(2, Math.min(28, Math.round(speed * 16)))
  for (let step = 0; step < maxSteps && performance.now() - started < 24; step++) {
    // A bounded endogenous-drive surrogate enters the graph, never the body.
    // The body's motion reads only the resulting CNS spike counts.
    const forwardDrive = controllerMode === "embodied" ? INTRINSIC_FORWARD_DRIVE[mode] || 0 : 0
    if (forwardDrive) net.pulse(motorReadout.forwardIndices, forwardDrive * net.p.dt)
    if (takeoffDriveOn && net.t >= stimulateTakeoffUntil) {
      net.setDrive(motorReadout.takeoffIndices, 0)
      takeoffDriveOn = false
    }
    if (net.t < stimulateLandingUntil) {
      for (const [index] of motorReadout.pools.wingPower) net.addG(index, 0, -60 * net.p.dt)
    }
    if (navigationLanding) {
      for (const [index] of motorReadout.pools.flight) net.addG(index, 0, -260 * net.p.dt)
    }
    const fired = net.step()
    spikeWindowMs += net.p.dt
    for (let i = 0; i < fired.length; i++) {
      const index = fired[i]
      spikes.push(index)
      regionSpikes[regionOf[index]]++
    }
  }
  if (performance.now() - lastReport > 100) report()
  timer = setTimeout(pump, 24)
}

async function init() {
  try {
    postMessage({ type: "status", message: "正在载入连接图与神经元标注…" })
    const [graphBytes, neuronBytes, meta, sizeBytes, signBytes, params] = await Promise.all([
      read(URLS.graph), read(URLS.neurons), read(URLS.meta, true),
      read(URLS.size), read(URLS.sign), read(URLS.params, true),
    ])
    postMessage({ type: "status", message: "正在解码 1,051 万条连接…" })
    const graph = decodeGraph(new Uint8Array(graphBytes))
    const neurons = decodeNeurons(new Uint8Array(neuronBytes))
    if (graph.N !== neurons.N || graph.N !== meta.N) throw new Error("CNS graph and neuron table differ")
    const size = new Float32Array(sizeBytes)
    const sign = new Float32Array(signBytes)
    if (size.length !== graph.N || sign.length !== graph.N) throw new Error("CNS physiology table mismatch")
    const mapped = new Set()
    // Visual neurons are driven externally by the separate FlyVis optic-lobe worker.
    // Only its currently active pairs are sent at runtime; the full pair list is needed for the mask.
    const map = await read(new URL("../data/flyvis_map.json", self.location.href).href, true)
    for (const side of ["L", "R"]) for (const pair of map.eyes[side].pairs) mapped.add(pair[0])
    postMessage({ type: "status", message: "正在建立全脑 LIF 状态…" })
    const { inScale, sensoryMask } = makeScales(neurons, meta, size, params, mapped)
    net = new LIFNetwork(graph.N, graph.indptr, graph.indices, graph.weights, neurons.nt,
      { ...params, inScale, sensoryMask, preSign: sign })
    const lamina = []
    for (let i = 0; i < graph.N; i++) {
      if (meta.classes[neurons.cls[i]] === "Kenyon_Cell") net.setThr(i, params.kcThreshold)
      if (/^L[1-5]$/.test(meta.types[i])) lamina.push(i)
    }
    net.setBias(lamina, params.laminaBias)
    motorReadout = new MotorReadout(meta.types, neurons.side)
    sensoryPools = makeSensoryPools(meta)
    if (pendingDrive) {
      applyVisualDrive(pendingDrive.indices, pendingDrive.rates)
      pendingDrive = null
    }
    postMessage({ type: "ready", neurons: graph.N, edges: graph.E, backend: "JS LIF worker",
      motorPoolSizes: Object.fromEntries(Object.entries(motorReadout.pools).map(([key, pool]) => [key, pool.length])),
      sensoryPoolSizes: Object.fromEntries(Object.entries(sensoryPools).map(([key, pool]) => [key, pool.length])) })
    lastReport = performance.now()
    if (running) pump()
  } catch (error) {
    postMessage({ type: "error", message: String(error) })
  }
}

self.onmessage = ({ data }) => {
  if (data.type === "init") {
    running = data.running !== false
    speed = data.speed || 1
    mode = data.mode || "forage"
    controllerMode = data.controllerMode === "strict" ? "strict" : "embodied"
    void init()
  } else if (data.type === "drive") {
    applyVisualDrive(data.indices, data.rates)
  } else if (data.type === "olfaction") {
    applyOlfactoryDrive(data)
  } else if (data.type === "navigation") {
    applyNavigationDrive(data)
  } else if (data.type === "run") {
    running = data.running
    clearTimeout(timer)
    if (running && net) pump()
  } else if (data.type === "speed") {
    speed = Math.max(0.25, Math.min(2, data.speed))
  } else if (data.type === "mode") {
    if (Object.hasOwn(INTRINSIC_FORWARD_DRIVE, data.mode)) mode = data.mode
  } else if (data.type === "controllerMode") {
    controllerMode = data.controllerMode === "strict" ? "strict" : "embodied"
  } else if (data.type === "stimulateTakeoff" && net) {
    stimulateTakeoffUntil = net.t + 180
    net.setDrive(motorReadout.takeoffIndices, 150)
    net.setDrive(motorReadout.flightIndices, 150)
    takeoffDriveOn = true
    flightStimulusOn = true
  } else if (data.type === "stimulateLanding" && net) {
    stimulateLandingUntil = net.t + 300
    net.setDrive(motorReadout.flightIndices, 0)
    flightStimulusOn = false
  } else if (data.type === "reset" && net) {
    if (takeoffDriveOn) net.setDrive(motorReadout.takeoffIndices, 0)
    if (flightStimulusOn) net.setDrive(motorReadout.flightIndices, 0)
    for (let i = 0; i < visualDriven.length; i++) net.setDriveOne(visualDriven[i], 0)
    for (let i = 0; i < olfactoryDriven.length; i++) net.setDriveOne(olfactoryDriven[i], 0)
    for (let i = 0; i < navigationDriven.length; i++) net.setDriveOne(navigationDriven[i], 0)
    net.reset()
    motorReadout.reset()
    stimulateTakeoffUntil = -1
    stimulateLandingUntil = -1
    takeoffDriveOn = false
    flightStimulusOn = false
    spikes = []
    visualDriven = new Uint32Array(0)
    olfactoryDriven = new Uint32Array(0)
    navigationDriven = new Uint32Array(0)
    navigationLanding = false
    spikeWindowMs = 0
    regionSpikes = [0, 0, 0]
    report()
  }
}
