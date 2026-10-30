import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  buildQr3mfMeshes,
  computeMinSizeMm,
  type Mesh as QrMesh,
  type Qr3mfOptions,
} from '../lib/qr3mf'

interface Print3DPreviewProps {
  /** URL the QR code encodes; decides the code's density. */
  profileUrl: string
  options: Qr3mfOptions
}

/** Same colors as the .3mf basematerials, so the preview matches the slicer. */
const BASE_COLOR = 0xffffff
const QR_COLOR = 0x1f2937
const BACKGROUND_COLOR = 0xf3f4f6 // Tailwind gray-100, matches the fallback tile

/**
 * The model is rescaled so its longest side always spans this many world units.
 * The camera never has to move when the size slider changes, which keeps
 * the user's drag-rotation intact across control tweaks.
 */
const PLATE_WORLD_UNITS = 100

interface SceneContext {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  model: THREE.Group
  baseMaterial: THREE.MeshStandardMaterial
  qrMaterial: THREE.MeshStandardMaterial
  render: () => void
}

function toGeometry(mesh: QrMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(mesh.vertices, 3),
  )
  geometry.setIndex(mesh.triangles)
  return geometry
}

function disposeModelChildren(model: THREE.Group) {
  for (const child of [...model.children]) {
    if (child instanceof THREE.Mesh) child.geometry.dispose()
    model.remove(child)
  }
}

/**
 * Live 3D preview of the printable QR tag, built from the same meshes the
 * .3mf exporter packages. Renders on demand (control changes and drags)
 * rather than a continuous animation loop.
 *
 * Default export so the modal can lazy-load it — three.js is by far the
 * largest dependency on this page and is only needed once the modal opens.
 */
export default function Print3DPreview({ profileUrl, options }: Print3DPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<SceneContext | null>(null)
  const [supported, setSupported] = useState(true)

  const {
    sizeMm,
    thicknessMm,
    lanyardLoop,
    quietZoneComponents,
    reliefMm,
    textLines,
    textFont,
    textAlign,
  } = options
  // Arrays get a new identity every render; key the rebuild on content.
  const textKey = JSON.stringify(textLines ?? [])

  // One-time scene setup: renderer, camera, lights, controls.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    if (typeof WebGL2RenderingContext === 'undefined') {
      setSupported(false)
      return
    }

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true })
    } catch {
      setSupported(false)
      return
    }

    const width = container.clientWidth || 320
    const height = container.clientHeight || width
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(width, height)
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(BACKGROUND_COLOR)

    // The meshes live in the XY plane with thickness along Z, so orbit
    // around Z-up to match how the tag sits on a print bed.
    const camera = new THREE.PerspectiveCamera(36, width / height, 1, 2000)
    camera.up.set(0, 0, 1)
    camera.position.set(0, -170, 130)
    camera.lookAt(0, 0, 0)

    scene.add(new THREE.AmbientLight(0xffffff, 1.1))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(-100, -200, 300)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.5)
    fill.position.set(200, 100, -100)
    scene.add(fill)

    const model = new THREE.Group()
    scene.add(model)

    // Flat shading keeps the box faces crisp even though corner vertices
    // are shared across faces in the exported meshes.
    const baseMaterial = new THREE.MeshStandardMaterial({
      color: BASE_COLOR,
      flatShading: true,
    })
    const qrMaterial = new THREE.MeshStandardMaterial({
      color: QR_COLOR,
      flatShading: true,
    })

    const render = () => renderer.render(scene, camera)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enablePan = false
    controls.addEventListener('change', render)

    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        const w = container.clientWidth
        const h = container.clientHeight
        if (!w || !h) return
        renderer.setSize(w, h)
        camera.aspect = w / h
        camera.updateProjectionMatrix()
        render()
      })
      resizeObserver.observe(container)
    }

    sceneRef.current = {
      renderer,
      scene,
      camera,
      controls,
      model,
      baseMaterial,
      qrMaterial,
      render,
    }

    return () => {
      sceneRef.current = null
      resizeObserver?.disconnect()
      controls.dispose()
      disposeModelChildren(model)
      baseMaterial.dispose()
      qrMaterial.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  // Rebuild the meshes whenever a setting changes.
  useEffect(() => {
    const ctx = sceneRef.current
    if (!ctx) return

    // Widening the quiet zone can briefly leave the chosen size below the
    // new minimum until the modal's clamp effect runs; clamp here too so
    // the preview never builds an out-of-range model.
    const size = Math.max(sizeMm, computeMinSizeMm(profileUrl, quietZoneComponents))
    const meshes = buildQr3mfMeshes(profileUrl, {
      sizeMm: size,
      thicknessMm,
      lanyardLoop,
      quietZoneComponents,
      reliefMm,
      textLines: JSON.parse(textKey) as string[],
      textFont,
      textAlign,
    })

    disposeModelChildren(ctx.model)
    const baseGeometry = toGeometry(meshes.base)
    ctx.model.add(
      new THREE.Mesh(baseGeometry, ctx.baseMaterial),
      new THREE.Mesh(toGeometry(meshes.qr), ctx.qrMaterial),
    )

    // Center the whole tag (text bands and lanyard tab included) on the
    // origin and normalize its longest side so the fixed camera frames it
    // at any physical size.
    baseGeometry.computeBoundingBox()
    const box = baseGeometry.boundingBox ?? new THREE.Box3()
    const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y)
    const scale = PLATE_WORLD_UNITS / span
    ctx.model.scale.setScalar(scale)
    ctx.model.position.set(
      (-(box.min.x + box.max.x) / 2) * scale,
      (-(box.min.y + box.max.y) / 2) * scale,
      (-thicknessMm * scale) / 2,
    )

    ctx.render()
  }, [
    profileUrl,
    sizeMm,
    thicknessMm,
    lanyardLoop,
    quietZoneComponents,
    reliefMm,
    textKey,
    textFont,
    textAlign,
  ])

  if (!supported) {
    return (
      <div className="flex aspect-square w-full items-center justify-center rounded-lg bg-gray-100 p-4 text-center text-sm text-gray-500">
        Live preview isn't available in this browser, but the download still
        works.
      </div>
    )
  }

  return (
    <div>
      <div
        ref={containerRef}
        role="img"
        aria-label="3D preview of the printable QR tag"
        className="aspect-square w-full touch-none overflow-hidden rounded-lg bg-gray-100"
      />
      <p className="mt-1 text-center text-xs text-gray-400">Drag to rotate</p>
    </div>
  )
}
