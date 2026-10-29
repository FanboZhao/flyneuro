import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import * as THREE from "three"
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js"
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js"

const [, , sourceDirectory, outputFile] = process.argv
if (!sourceDirectory || !outputFile) {
  throw new Error("Usage: node scripts/build-flybody-model.mjs <flybody assets directory> <output.glb>")
}

if (typeof globalThis.FileReader === "undefined") {
  globalThis.FileReader = class FileReader {
    result = null
    onloadend = null
    onerror = null

    readAsArrayBuffer(blob) {
      blob.arrayBuffer()
        .then((buffer) => {
          this.result = buffer
          this.onloadend?.({ target: this })
        })
        .catch((error) => this.onerror?.(error))
    }
  }
}

const xml = await readFile(path.join(sourceDirectory, "fruitfly.xml"), "utf8")
const attributes = (tag) => Object.fromEntries(
  [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
)
const vector = (value, fallback = [0, 0, 0]) => value ? value.trim().split(/\s+/).map(Number) : fallback
const quaternion = (value) => {
  const [w, x, y, z] = vector(value, [1, 0, 0, 0])
  return new THREE.Quaternion(x, y, z, w).normalize()
}

const meshFiles = new Map()
for (const match of xml.matchAll(/<mesh\b[^>]*\/>/g)) {
  const item = attributes(match[0])
  if (item.name && item.file) meshFiles.set(item.name, item.file)
}

const materialDefinitions = new Map()
for (const match of xml.matchAll(/<material\b[^>]*\/>/g)) {
  const item = attributes(match[0])
  if (!item.name || !item.rgba) continue
  const [r, g, b, a] = vector(item.rgba, [0.674, 0.35, 0.143, 1])
  materialDefinitions.set(item.name, { r, g, b, a })
}

const createMaterial = (name = "body") => {
  const value = materialDefinitions.get(name) ?? materialDefinitions.get("body") ?? { r: 0.674, g: 0.35, b: 0.143, a: 1 }
  const transparent = value.a < 0.999
  return new THREE.MeshPhysicalMaterial({
    name: `flybody-${name}`,
    color: new THREE.Color(value.r, value.g, value.b),
    roughness: name === "red" ? 0.28 : name === "membrane" ? 0.24 : 0.57,
    metalness: 0,
    clearcoat: ["red", "ocelli", "black"].includes(name) ? 0.42 : 0.08,
    clearcoatRoughness: 0.34,
    transparent,
    opacity: value.a,
    side: name === "membrane" ? THREE.DoubleSide : THREE.FrontSide,
    depthWrite: !transparent,
  })
}

const materials = new Map()
const getMaterial = (name) => {
  const key = name || "body"
  if (!materials.has(key)) materials.set(key, createMaterial(key))
  return materials.get(key)
}

function vertexBudget(file) {
  if (file === "head_red.obj") return 26000
  if (/^(head|thorax)_/.test(file)) return 14000
  if (/^wing_/.test(file)) return 8500
  if (/^(abdomen|femur|coxa|tibia)_/.test(file)) return 5200
  if (/^(antenna|haustellum|rostrum)_/.test(file)) return 4200
  return 2600
}

function clusterGeometry(source, budget) {
  const prepared = source.clone()
  for (const key of Object.keys(prepared.attributes)) if (key !== "position") prepared.deleteAttribute(key)
  let geometry = mergeVertices(prepared, 1e-5)
  const count = geometry.attributes.position.count
  if (count <= budget) {
    geometry.computeVertexNormals()
    return geometry
  }

  geometry.computeBoundingBox()
  const box = geometry.boundingBox
  const size = new THREE.Vector3()
  box.getSize(size)
  const maxDimension = Math.max(size.x, size.y, size.z) || 1
  const positions = geometry.attributes.position
  const originalIndices = geometry.index.array
  let resolution = Math.max(8, Math.ceil(Math.sqrt(budget) * 1.25))
  let result

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const cellSize = maxDimension / resolution
    const cells = new Map()
    const remap = new Uint32Array(positions.count)
    const sums = []

    for (let index = 0; index < positions.count; index += 1) {
      const x = positions.getX(index)
      const y = positions.getY(index)
      const z = positions.getZ(index)
      const key = `${Math.floor((x - box.min.x) / cellSize)},${Math.floor((y - box.min.y) / cellSize)},${Math.floor((z - box.min.z) / cellSize)}`
      let target = cells.get(key)
      if (target === undefined) {
        target = sums.length
        cells.set(key, target)
        sums.push([0, 0, 0, 0])
      }
      remap[index] = target
      const sum = sums[target]
      sum[0] += x
      sum[1] += y
      sum[2] += z
      sum[3] += 1
    }

    const vertices = new Float32Array(sums.length * 3)
    sums.forEach((sum, index) => {
      vertices[index * 3] = sum[0] / sum[3]
      vertices[index * 3 + 1] = sum[1] / sum[3]
      vertices[index * 3 + 2] = sum[2] / sum[3]
    })
    const faces = []
    const seen = new Set()
    for (let index = 0; index < originalIndices.length; index += 3) {
      const a = remap[originalIndices[index]]
      const b = remap[originalIndices[index + 1]]
      const c = remap[originalIndices[index + 2]]
      if (a === b || b === c || a === c) continue
      const signature = [a, b, c].sort((left, right) => left - right).join(":")
      if (seen.has(signature)) continue
      seen.add(signature)
      faces.push(a, b, c)
    }

    result = new THREE.BufferGeometry()
    result.setAttribute("position", new THREE.BufferAttribute(vertices, 3))
    result.setIndex(faces)
    result.computeVertexNormals()
    result.computeBoundingBox()
    result.computeBoundingSphere()

    if (sums.length <= budget * 1.08 && sums.length >= budget * 0.45) break
    resolution = Math.max(6, Math.round(resolution * Math.sqrt(budget / Math.max(1, sums.length))))
  }

  geometry.dispose()
  return result
}

const objectLoader = new OBJLoader()
const meshCache = new Map()
async function loadMesh(file) {
  if (!meshCache.has(file)) {
    const parsed = objectLoader.parse(await readFile(path.join(sourceDirectory, file), "utf8"))
    const geometries = []
    parsed.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      geometries.push(clusterGeometry(object.geometry, vertexBudget(file)))
    })
    meshCache.set(file, geometries)
  }
  return meshCache.get(file)
}

const root = new THREE.Group()
root.name = "FlyBody"
root.userData = {
  source: "TuragaLab/flybody",
  sourceCommit: "d015e9bfe441bd90ae431bac24c55cb74bdbce26",
  license: "Apache-2.0",
  note: "Web LOD generated from the official visual OBJ assets; geometry was vertex-cluster simplified.",
}

const worldStart = xml.indexOf("<worldbody")
const worldEnd = xml.indexOf("</worldbody>")
const world = xml.slice(worldStart, worldEnd)
const stack = [root]
for (const match of world.matchAll(/<\/body>|<body\b[^>]*>|<geom\b[^>]*\/>/g)) {
  const tag = match[0]
  if (tag === "</body>") {
    stack.pop()
    continue
  }
  const item = attributes(tag)
  if (tag.startsWith("<body")) {
    const body = new THREE.Group()
    body.name = item.name || `body-${stack.length}`
    body.position.fromArray(vector(item.pos))
    body.quaternion.copy(quaternion(item.quat))
    body.userData.flybodyBody = true
    stack.at(-1).add(body)
    stack.push(body)
    continue
  }
  if (!item.mesh) continue
  const file = meshFiles.get(item.mesh)
  if (!file) continue
  const visual = new THREE.Group()
  visual.name = `visual-${item.mesh}`
  visual.position.fromArray(vector(item.pos))
  visual.quaternion.copy(quaternion(item.quat))
  visual.scale.setScalar(0.1)
  const geometries = await loadMesh(file)
  geometries.forEach((geometry, index) => {
    const mesh = new THREE.Mesh(geometry.clone(), getMaterial(item.material))
    mesh.name = geometries.length > 1 ? `${item.mesh}-${index}` : item.mesh
    visual.add(mesh)
  })
  stack.at(-1).add(visual)
}

root.updateMatrixWorld(true)
const bounds = new THREE.Box3().setFromObject(root)
const boundsSize = bounds.getSize(new THREE.Vector3())
let vertexCount = 0
let triangleCount = 0
root.traverse((object) => {
  if (!(object instanceof THREE.Mesh)) return
  vertexCount += object.geometry.attributes.position.count
  triangleCount += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3
})

const exporter = new GLTFExporter()
const glb = await exporter.parseAsync(root, {
  binary: true,
  onlyVisible: true,
  trs: true,
  maxTextureSize: 1024,
})
await mkdir(path.dirname(outputFile), { recursive: true })
await writeFile(outputFile, Buffer.from(glb))
console.log(JSON.stringify({
  outputFile,
  vertexCount,
  triangleCount: Math.round(triangleCount),
  meshes: meshCache.size,
  bounds: boundsSize.toArray().map((value) => Number(value.toFixed(4))),
}))
