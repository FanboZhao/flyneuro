// Decoder-only subset of Lulzx/fly-brain's FLYN codec.
// Source: https://github.com/Lulzx/fly-brain (MIT, commit ba0b4f815c00e81a2ef1f36165df2b1891e5e39c)

const TOP = 2 ** 24
const PBITS = 12
const PONE = 1 << PBITS
const MOVE = 5
const MIN = 0x80000000 | 0
const MAGIC = 0x4e594c46

class Decoder {
  readonly bytes: Uint8Array
  readonly state = new Int32Array(3)

  constructor(bytes: Uint8Array, position = 0) {
    this.bytes = bytes
    this.state[0] = -1
    this.state[2] = position
    let code = 0
    for (let i = 0; i < 5; i += 1) code = (code << 8) | this.next()
    this.state[1] = code
  }

  next() {
    const position = this.state[2]
    this.state[2] = position + 1
    return position < this.bytes.length ? this.bytes[position] : 0
  }

  bit(probabilities: Uint16Array, index: number) {
    const state = this.state
    let range = state[0]
    let code = state[1]
    const probability = probabilities[index]
    const bound = Math.imul(range >>> PBITS, probability)
    let bit: number
    if ((code ^ MIN) < (bound ^ MIN)) {
      range = bound
      probabilities[index] = probability + ((PONE - probability) >> MOVE)
      bit = 0
    } else {
      code = (code - bound) | 0
      range = (range - bound) | 0
      probabilities[index] = probability - (probability >> MOVE)
      bit = 1
    }
    if ((range >>> 24) === 0) {
      let position = state[2]
      do {
        range <<= 8
        code = (code << 8) | (position < this.bytes.length ? this.bytes[position] : 0)
        position += 1
      } while ((range >>> 24) === 0)
      state[2] = position
    }
    state[0] = range
    state[1] = code
    return bit
  }

  direct(bitCount: number) {
    const state = this.state
    let range = state[0]
    let code = state[1]
    let position = state[2]
    let value = 0
    while (bitCount > 0) {
      const count = bitCount < 16 ? bitCount : 16
      bitCount -= count
      range >>>= count
      const chunk = ((code >>> 0) / range) | 0
      code = (code - Math.imul(chunk, range)) | 0
      value = value * (1 << count) + chunk
      while ((range >>> 24) === 0) {
        range <<= 8
        code = (code << 8) | (position < this.bytes.length ? this.bytes[position] : 0)
        position += 1
      }
    }
    state[0] = range
    state[1] = code
    state[2] = position
    return value
  }
}

const probabilities = (size: number) => new Uint16Array(size).fill(PONE >> 1)

class UInt {
  readonly lengthModel: Uint16Array
  readonly magnitudeModel: Uint16Array

  constructor(contextCount: number) {
    this.lengthModel = probabilities(contextCount * 32)
    this.magnitudeModel = probabilities(contextCount * 32 * 4)
  }

  decode(decoder: Decoder, context: number) {
    const state = decoder.state
    const bytes = decoder.bytes
    const base = context * 32
    let range = state[0]
    let code = state[1]
    let position = state[2]
    let tree = 1
    for (let i = 0; i < 5; i += 1) {
      const index = base + tree
      const probability = this.lengthModel[index]
      const bound = Math.imul(range >>> PBITS, probability)
      if ((code ^ MIN) < (bound ^ MIN)) {
        range = bound
        this.lengthModel[index] = probability + ((PONE - probability) >> MOVE)
        tree <<= 1
      } else {
        code = (code - bound) | 0
        range = (range - bound) | 0
        this.lengthModel[index] = probability - (probability >> MOVE)
        tree = (tree << 1) | 1
      }
      while ((range >>> 24) === 0) {
        range <<= 8
        code = (code << 8) | (position < bytes.length ? bytes[position] : 0)
        position += 1
      }
    }
    const bitLength = tree - 32
    let value = 1
    if (bitLength > 0) {
      const modelBase = (base + bitLength) * 4
      for (let shift = 0; shift < 2 && shift < bitLength; shift += 1) {
        const index = modelBase + (shift === 0 ? 1 : 2 + (value & 1))
        const probability = this.magnitudeModel[index]
        const bound = Math.imul(range >>> PBITS, probability)
        if ((code ^ MIN) < (bound ^ MIN)) {
          range = bound
          this.magnitudeModel[index] = probability + ((PONE - probability) >> MOVE)
          value <<= 1
        } else {
          code = (code - bound) | 0
          range = (range - bound) | 0
          this.magnitudeModel[index] = probability - (probability >> MOVE)
          value = (value << 1) | 1
        }
        while ((range >>> 24) === 0) {
          range <<= 8
          code = (code << 8) | (position < bytes.length ? bytes[position] : 0)
          position += 1
        }
      }
      if (bitLength >= 3) {
        state[0] = range
        state[1] = code
        state[2] = position
        const rest = decoder.direct(bitLength - 2)
        range = state[0]
        code = state[1]
        position = state[2]
        value = value * 2 ** (bitLength - 2) + rest
      }
    }
    state[0] = range
    state[1] = code
    state[2] = position
    return value - 1
  }
}

class SInt extends UInt {
  decodeSigned(decoder: Decoder, context: number) {
    const zigzag = this.decode(decoder, context)
    return zigzag & 1 ? -(zigzag + 1) / 2 : zigzag / 2
  }
}

export type FlyBrainNeuronTable = {
  count: number
  soma: Float32Array
  superclass: Uint8Array
}

export function decodeFlyBrainNeurons(bytes: Uint8Array): FlyBrainNeuronTable {
  const headerBytes = bytes.slice(0, 12)
  const header = new Uint32Array(headerBytes.buffer)
  if (header[0] !== MAGIC || header[1] !== 1) throw new Error("Unsupported FLYN neuron table")
  const count = header[2]
  const decoder = new Decoder(bytes.subarray(12))
  const idModel = new UInt(1)
  const superclassModel = new UInt(32)
  const classModel = new UInt(32)
  const transmitterModel = new UInt(32)
  const sideModel = new UInt(32)
  const hasSomaModel = probabilities(2)
  const somaModel = new SInt(3)
  const soma = new Float32Array(count * 3)
  const superclass = new Uint8Array(count)
  const previous = [0, 0, 0]
  let previousHasSoma = 1

  for (let i = 0; i < count; i += 1) {
    idModel.decode(decoder, 0)
    const group = superclassModel.decode(decoder, 0)
    superclass[i] = group
    classModel.decode(decoder, group)
    transmitterModel.decode(decoder, group)
    sideModel.decode(decoder, group)
    const hasSoma = decoder.bit(hasSomaModel, previousHasSoma)
    previousHasSoma = hasSoma
    for (let axis = 0; axis < 3; axis += 1) {
      if (hasSoma) previous[axis] += somaModel.decodeSigned(decoder, axis)
      soma[i * 3 + axis] = hasSoma ? previous[axis] : Number.NaN
    }
  }
  return { count, soma, superclass }
}
