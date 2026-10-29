// Experimental browser motor readout from identified CNS cells. Role weights,
// rate filtering and steering adaptation follow fly-brain/src/sim/motor.js (MIT).
// The mapping from these commands to this site's visual FlyBody is site-specific.
const ROLES = {
  forward: { DNg100: 1, DNg97: 1, DNp09: 1, DNa05: 0.2, DNa07: 0.2, DNp26: 0.2, DNg25: 0.2, DNa01: 0.1, DNa02: 0.1 },
  backward: { MDN: 1 },
  turn: { DNa02: 1, DNa01: 0.6, DNp09: 0.5 },
  takeoff: { DNp02: 1, DNp04: 1 },
  flight: { DNa08: 1, DNg02_a: 1, DNg02_b: 1, DNg02_c: 1, DNg02_e: 1, DNg02_g: 1 },
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value))

export class MotorReadout {
  constructor(types, sides) {
    const collect = (role, side = 0) => {
      const result = []
      for (let i = 0; i < types.length; i++) {
        const weight = ROLES[role][types[i]]
        if (weight && (!side || sides[i] === side)) result.push([i, weight])
      }
      return result
    }
    this.pools = {
      forward: collect("forward"), backward: collect("backward"),
      turnL: collect("turn", 1), turnR: collect("turn", 2),
      takeoff: collect("takeoff"), flight: collect("flight"),
      wingPower: [],
    }
    for (let i = 0; i < types.length; i++) {
      if (/^(DLMn|DVMn)\b/.test(types[i])) this.pools.wingPower.push([i, 1])
    }
    const unique = new Set(Object.values(this.pools).flatMap((pool) => pool.map(([index]) => index)))
    this.indices = Uint32Array.from(unique)
    this.forwardIndices = Uint32Array.from(this.pools.forward, ([index]) => index)
    this.takeoffIndices = Uint32Array.from(this.pools.takeoff, ([index]) => index)
    this.flightIndices = Uint32Array.from(this.pools.flight, ([index]) => index)
    this.rate = new Float32Array(types.length)
    this.lastCount = new Uint32Array(types.length)
    this.turnFiltered = 0
    this.turnBase = 0
  }

  reset() {
    this.rate.fill(0)
    this.lastCount.fill(0)
    this.turnFiltered = 0
    this.turnBase = 0
  }

  mean(pool) {
    let value = 0, weight = 0
    for (const [index, w] of pool) { value += this.rate[index] * w; weight += w }
    return weight ? value / weight : 0
  }

  update(spikeCount, dtMs) {
    const duration = Math.max(0.5, dtMs)
    const k = 1 - Math.exp(-duration / 40)
    for (const index of this.indices) {
      const count = spikeCount[index]
      this.rate[index] += k * ((count - this.lastCount[index]) * 1000 / duration - this.rate[index])
      this.lastCount[index] = count
    }
    const forwardHz = this.mean(this.pools.forward)
    const backwardHz = this.mean(this.pools.backward)
    const turnLHz = this.mean(this.pools.turnL)
    const turnRHz = this.mean(this.pools.turnR)
    const rawTurn = turnLHz - turnRHz
    const turnK = 1 - Math.exp(-duration / 50)
    this.turnFiltered += turnK * (rawTurn - this.turnFiltered)
    this.turnBase += (1 - Math.exp(-duration / 4000)) * (this.turnFiltered - this.turnBase)
    const netForward = forwardHz - 2 * backwardHz
    const forward = netForward > 4 ? 1 - Math.exp(-(netForward - 4) / 12)
      : backwardHz > 4 ? -0.35 * (1 - Math.exp(-(backwardHz - 4) / 12)) : 0
    return {
      // Preserve sustained odor-guided steering. The older adaptive baseline
      // was useful for open-loop demonstrations but cancelled the persistent
      // left/right asymmetry required to follow an odor gradient.
      turn: clamp(this.turnFiltered / 45, -0.65, 0.65),
      forward: clamp(forward, -0.35, 1),
      forwardHz, backwardHz, turnLHz, turnRHz,
      takeoffHz: this.mean(this.pools.takeoff),
      flightHz: this.mean(this.pools.flight),
      wingPowerHz: this.mean(this.pools.wingPower),
    }
  }
}
