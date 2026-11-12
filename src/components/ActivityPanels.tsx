import { useEffect, useMemo, useRef } from "react"
import * as THREE from "three"
import { HEX_COORDS } from "@/simulation/constants"

export function EyeImage({ side, label }: { side: "left" | "right"; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const resolution = 128
    canvas.width = resolution
    canvas.height = resolution
    const image = ctx.createImageData(resolution, resolution)
    const draw = (event: Event) => {
      const pixels = (event as CustomEvent<{ left: Uint8Array; right: Uint8Array }>).detail[side]
      for (let row = 0; row < resolution; row++) {
        const source = (resolution - row - 1) * resolution * 4
        image.data.set(pixels.subarray(source, source + resolution * 4), row * resolution * 4)
      }
      ctx.putImageData(image, 0, 0)
    }
    window.addEventListener("flyvis-eye-frame", draw)
    return () => window.removeEventListener("flyvis-eye-frame", draw)
  }, [side])
  return (
    <div className="eye-image">
      <span>{label}</span>
      <canvas ref={ref} />
    </div>
  )
}

export function RetinaMap({
  values,
  accent,
  label,
}: {
  values: ArrayLike<number>
  accent: string
  label: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const ratio = Math.min(window.devicePixelRatio, 2)
    const rect = canvas.getBoundingClientRect()
    canvas.width = Math.max(1, rect.width * ratio)
    canvas.height = Math.max(1, rect.height * ratio)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)
    const size = Math.min(rect.width / 34, rect.height / 31)
    const cx = rect.width / 2
    const cy = rect.height / 2
    HEX_COORDS.forEach(([q, r], i) => {
      const x = cx + size * Math.sqrt(3) * (q + r / 2)
      const y = cy + size * 1.5 * r
      const v = values[i] ?? 0
      const c = new THREE.Color("#17241f").lerp(new THREE.Color(accent), Math.pow(v, 1.35))
      ctx.fillStyle = `rgb(${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)} / ${0.45 + v * 0.55})`
      ctx.beginPath()
      for (let side = 0; side < 6; side += 1) {
        const angle = (Math.PI / 180) * (60 * side - 30)
        const px = x + Math.cos(angle) * size * 0.74
        const py = y + Math.sin(angle) * size * 0.74
        if (side === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      ctx.fill()
    })
  }, [values, accent])
  return (
    <div className="retina-frame">
      <span>{label}</span>
      <canvas ref={ref} />
    </div>
  )
}

export function TraceChart({
  samples,
  color,
}: {
  samples: Array<[number, number, number]>
  color: string
}) {
  const paths = useMemo(
    () =>
      [0, 1, 2].map((line) => {
        const points = Array.from({ length: 58 }, (_, i) => {
          const x = (i / 57) * 100
          const sample = samples[Math.max(0, samples.length - 58 + i)]?.[line] ?? 0
          const y = 36 - Math.max(-1, Math.min(1, sample)) * 26
          return `${x.toFixed(2)},${y.toFixed(2)}`
        })
        return `M${points.join(" L")}`
      }),
    [samples],
  )
  return (
    <svg
      className="trace-chart"
      viewBox="0 0 100 72"
      preserveAspectRatio="none"
      role="img"
      aria-label="神经活动时间曲线"
    >
      {[12, 29, 46, 63].map((y) => (
        <line key={y} x1="0" y1={y} x2="100" y2={y} className="grid-line" />
      ))}
      {paths.map((path, i) => (
        <path
          key={i}
          d={path}
          fill="none"
          stroke={i === 0 ? color : i === 1 ? "#68c7cc" : "#f2c46d"}
          strokeWidth={i === 0 ? 1.8 : 1.15}
          opacity={1 - i * 0.18}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <line x1="84" y1="4" x2="84" y2="68" className="cursor-line" />
    </svg>
  )
}

export function Metric({
  label,
  value,
  unit,
  accent,
}: {
  label: string
  value: string
  unit?: string
  accent?: string
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong style={accent ? { color: accent } : undefined}>
        {value}
        <small>{unit}</small>
      </strong>
    </div>
  )
}
