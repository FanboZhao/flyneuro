import { useEffect, useRef } from "react"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { decodeFlyBrainNeurons } from "@/lib/fly-brain-codec"
import { assetUrl } from "@/lib/asset-url"
import type { CnsMetrics } from "@/simulation/types"

export function WholeBrainCanvas({
  running,
  active,
  metrics,
}: {
  running: boolean
  active: boolean
  metrics: CnsMetrics
}) {
  const holderRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef({ running, active })
  useEffect(() => {
    runtimeRef.current = { running, active }
  }, [running, active])

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
    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: "high-performance",
    })
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

    void fetch(assetUrl("data/fly-brain-neurons.flyn"))
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
      {metrics.status !== "ready" && (
        <div className="brain-loading">{metrics.message || "正在载入全脑连接图…"}</div>
      )}
      <div className="brain-source-label">
        <span>REAL SOMA POSITIONS</span>
        <strong>CONNECTOME LIF SPIKES</strong>
      </div>
      <div className="brain-axis-label">拖动旋转 · 滚轮缩放</div>
    </div>
  )
}
