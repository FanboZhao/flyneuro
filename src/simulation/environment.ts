import * as THREE from "three"

export function seeded(index: number, seed = 1) {
  const value = Math.sin(index * 91.73 + seed * 37.19) * 43758.5453
  return value - Math.floor(value)
}

function makeStem(color = 0x315e39) {
  return new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.05, 0.7, 7),
    new THREE.MeshStandardMaterial({ color, roughness: 0.9 }),
  )
}

export function makeLeaf(color = 0x4d8a48) {
  const leaf = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 9, 6),
    new THREE.MeshStandardMaterial({ color, roughness: 0.95 }),
  )
  leaf.scale.set(0.45, 0.08, 1.1)
  return leaf
}

export function addFlower(scene: THREE.Scene, x: number, z: number, hue: number, scale: number) {
  const group = new THREE.Group()
  const stem = makeStem(0x315e39)
  stem.scale.y = scale
  stem.position.y = 0.35 * scale
  group.add(stem)
  const center = new THREE.Mesh(
    new THREE.SphereGeometry(0.11 * scale, 12, 8),
    new THREE.MeshStandardMaterial({
      color: 0xf8c85b,
      emissive: 0x3a2100,
      emissiveIntensity: 0.25,
    }),
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

export function addPlant(scene: THREE.Scene, x: number, z: number, scale: number, seed: number) {
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

export function addMushroom(
  scene: THREE.Scene,
  x: number,
  z: number,
  scale: number,
  color: number,
) {
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
