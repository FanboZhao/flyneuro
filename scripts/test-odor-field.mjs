import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

const messages = []
const context = { self: {}, postMessage: (message) => messages.push(message), performance: { now: () => 0 } }
const source = readFileSync(new URL("../public/workers/odor-worker.js", import.meta.url), "utf8")
runInNewContext(`${source}\nself.inspect = { concentrationAt, meanFieldAt, sources: SOURCES, setTime: (time) => { elapsed = time } }`, context)
const { concentrationAt, meanFieldAt, sources, setTime } = context.self.inspect

for (const flower of sources) {
  for (let time = 0; time <= 3; time += 0.15) {
    setTime(time)
    assert.ok(concentrationAt(flower.x, flower.y + 0.09, flower.z) > 0.2,
      `odor vanished at flower ${flower.x}, ${flower.z} at t=${time}`)
    assert.ok(concentrationAt(flower.x, flower.y + 0.09, flower.z + 1) > 0.1,
      `odor vanished just upwind of flower ${flower.x}, ${flower.z} at t=${time}`)
    assert.ok(concentrationAt(flower.x, flower.y + 1.15, flower.z) > 0.05,
      `odor vanished at cruising height above flower ${flower.x}, ${flower.z} at t=${time}`)
  }
}

const sourceY = sources[0].y + 0.09
assert.ok(meanFieldAt(0, sourceY, 13.2) > meanFieldAt(0, sourceY, 11.2))
assert.ok(meanFieldAt(0, sourceY, 11.2) > meanFieldAt(0, sourceY, 9.2))
assert.ok(meanFieldAt(0, sourceY, 11.2) > meanFieldAt(4, sourceY, 11.2))
assert.ok(Math.abs(meanFieldAt(0, sourceY, 14.09) - meanFieldAt(0, sourceY, 14.11)) < 0.03,
  "odor field should have no sharp cut-off just upwind of the flower")

context.self.onmessage({ data: { type: "sample", x: 0, y: sources[0].y, z: sources[0].z, heading: 0, now: 100, speed: 1 } })
const reading = messages.at(-1)
assert.equal(reading.type, "sample")
assert.ok(reading.left > 0 && reading.right > 0 && reading.field > 0)
assert.ok(reading.leftHz > 3 && reading.rightHz > 3)
assert.ok(reading.gradient.every(Number.isFinite))
assert.ok(Math.abs(reading.field - meanFieldAt(0, sourceY, sources[0].z)) < 1e-9)

console.log("Odor field: continuous near-source signal, downwind gradient, and local sensor readings verified.")
