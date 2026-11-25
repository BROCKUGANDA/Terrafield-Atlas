'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { REGION_PRESETS } from '@/lib/regions';
import { MissionPatch } from '@/components/ui-mc/logo';
import { CoordReadout } from '@/components/ui-mc/kit';
import { cn } from '@/lib/utils';
import { useSourceSigns } from '@/components/system/source-signs';
import { createEventLayer, LiveGlobeEvents, locatedEvents, type LocatedEvent } from './live-globe-events';

/**
 * EarthGlobe — fully procedural, dependency-free stylized mission network globe.
 *
 * NOTHING here is an imagery product: no textures or external assets.
 * Polled NASA EONET event positions overlay a stylized network: graticule
 * Earth, curated real-coordinate ground stations, dashed uplink arcs and an
 * orbiting satellite. It always renders, even fully offline.
 */

export interface GlobeStation {
  lat: number;
  lon: number;
  label: string;
}

/** Fallback stations: the exact curated demo presets from src/lib/regions.ts. */
const DEFAULT_STATIONS: GlobeStation[] = REGION_PRESETS.map((r) => ({
  lat: r.lat,
  lon: r.lon,
  label: r.name,
}));

/* ------------------------------------------------------------------ */
/* Procedural helpers                                                  */
/* ------------------------------------------------------------------ */

/** Deterministic seeded PRNG (mulberry32) — SSR-safe, stable every mount. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Geographic lat/lon (degrees) → cartesian point on a sphere of given radius. */
function latLonToVec3(lat: number, lon: number, radius: number): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return new THREE.Vector3(
    -(radius * Math.sin(phi) * Math.cos(theta)),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

/* ------------------------------------------------------------------ */
/* Inline GLSL — globe surface fresnel + atmosphere halo + dashed arcs */
/* ------------------------------------------------------------------ */

const GLOBE_VERT = /* glsl */ `
  varying vec3 vNormalV;
  varying vec3 vViewDirV;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewDirV = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const GLOBE_FRAGMENT = /* glsl */ `
  uniform vec3 uBase;
  uniform vec3 uRim;
  varying vec3 vNormalV;
  varying vec3 vViewDirV;
  void main() {
    vec3 n = normalize(vNormalV);
    vec3 v = normalize(vViewDirV);
    float fres = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 2.2);
    float lambert = clamp(dot(n, normalize(vec3(-0.35, 0.55, 0.75))), 0.0, 1.0);
    vec3 col = uBase * (0.62 + 0.38 * lambert);
    col += uRim * fres * 0.85;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const ATMO_VERT = /* glsl */ `
  varying vec3 vNormalV;
  void main() {
    vNormalV = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ATMO_FRAG = /* glsl */ `
  uniform vec3 uGlow;
  varying vec3 vNormalV;
  void main() {
    float intensity = pow(max(0.0, 0.72 - dot(normalize(vNormalV), vec3(0.0, 0.0, 1.0))), 3.0);
    intensity = clamp(intensity, 0.0, 1.0);
    gl_FragColor = vec4(uGlow * intensity, intensity);
  }
`;

/** Marching-dash line shader (uses the lineDistance attribute set by
 *  computeLineDistances(); uOffset is animated to make dashes travel). */
const DASH_VERT = /* glsl */ `
  attribute float lineDistance;
  varying float vLineDistance;
  void main() {
    vLineDistance = lineDistance;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DASH_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uOffset;
  uniform float uDash;
  uniform float uGap;
  varying float vLineDistance;
  void main() {
    float d = mod(vLineDistance + uOffset, uDash + uGap);
    if (d > uDash) discard;
    gl_FragColor = vec4(uColor, uOpacity);
  }
`;

/* ------------------------------------------------------------------ */
/* Arc pairing (curated demo stations, visually spread)               */
/* ------------------------------------------------------------------ */

const ARC_PAIRS: [string, string][] = [
  ['nakuru', 'punjab'],
  ['nakuru', 'iowa'],
  ['punjab', 'normandy'],
  ['cordoba', 'wa-wheatbelt'],
  ['saskatchewan', 'cordoba'],
  ['zambia-central', 'wa-wheatbelt'],
];

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function EarthGlobe({
  className,
  stations,
  onStationHover,
}: {
  className?: string;
  /** Optional override; defaults to the curated demo-region presets. */
  stations?: GlobeStation[];
  /** Hover callback (parent-driven HUD chip). Null when not hovering. */
  onStationHover?: (station: GlobeStation | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const liveQuery = useSourceSigns();
  const liveData = liveQuery.data;
  const eventLayerRef = useRef<ReturnType<typeof createEventLayer> | null>(null);
  const eventsRef = useRef<LocatedEvent[]>([]);
  useEffect(() => {
    const feed = liveData?.eonet;
    eventsRef.current = feed?.ok ? locatedEvents(feed.events) : [];
    eventLayerRef.current?.update(eventsRef.current);
  }, [liveData]);
  const hoverCbRef = useRef(onStationHover);
  useEffect(() => {
    hoverCbRef.current = onStationHover;
  }, [onStationHover]);

  const [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState<GlobeStation | null>(null);

  const stationList = stations ?? DEFAULT_STATIONS;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    /* ---------------- renderer (with graceful failure) --------------- */
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      // No WebGL available — surface the static fallback after this frame.
      const failRaf = requestAnimationFrame(() => setFailed(true));
      return () => cancelAnimationFrame(failRaf);
    }
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    renderer.setPixelRatio(pixelRatio);
    renderer.setClearColor(0x000000, 0);

    const canvas = renderer.domElement;
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none'; // drag on the globe must not scroll the page
    canvas.style.cursor = 'grab';
    container.appendChild(canvas);

    /* ---------------- scene graph ----------------------------------- */
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0.4, 3.5);
    camera.lookAt(0, 0, 0);

    const tiltGroup = new THREE.Group(); // X tilt (clamped)
    const spinGroup = new THREE.Group(); // Y rotation (drag / auto-rotate)
    tiltGroup.add(spinGroup);
    scene.add(tiltGroup);
    const eventLayer = createEventLayer();
    eventLayerRef.current = eventLayer;
    eventLayer.update(eventsRef.current);
    spinGroup.add(eventLayer.group);

    // Globe sphere — custom shader: deep navy base, aqua fresnel rim.
    const sphereGeo = new THREE.SphereGeometry(1, 64, 40);
    const sphereMat = new THREE.ShaderMaterial({
      vertexShader: GLOBE_VERT,
      fragmentShader: GLOBE_FRAGMENT,
      uniforms: {
        uBase: { value: new THREE.Color('#0B1322') },
        uRim: { value: new THREE.Color('#4CC3FF') },
      },
    });
    const globeMesh = new THREE.Mesh(sphereGeo, sphereMat);
    spinGroup.add(globeMesh);

    // Atmosphere halo — slightly larger back-side shell, additive.
    const atmoGeo = new THREE.SphereGeometry(1.07, 48, 32);
    const atmoMat = new THREE.ShaderMaterial({
      vertexShader: ATMO_VERT,
      fragmentShader: ATMO_FRAG,
      uniforms: { uGlow: { value: new THREE.Color('#4CC3FF') } },
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const atmoMesh = new THREE.Mesh(atmoGeo, atmoMat);
    atmoMesh.renderOrder = 4;
    spinGroup.add(atmoMesh);

    /* ---------------- graticule (20° x 20°, LineSegments) ------------ */
    const graticulePositions: number[] = [];
    const GR = 1.006; // lifted off the surface to avoid z-fighting
    const push = (a: THREE.Vector3, b: THREE.Vector3) => {
      graticulePositions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    };
    for (let lat = -60; lat <= 60; lat += 20) {
      let prev = latLonToVec3(lat, -180, GR);
      for (let lon = -175; lon <= 180; lon += 5) {
        const next = latLonToVec3(lat, lon, GR);
        push(prev, next);
        prev = next;
      }
    }
    for (let lon = -180; lon < 180; lon += 20) {
      let prev = latLonToVec3(-90, lon, GR);
      for (let lat = -85; lat <= 90; lat += 5) {
        const next = latLonToVec3(lat, lon, GR);
        push(prev, next);
        prev = next;
      }
    }
    const graticuleGeo = new THREE.BufferGeometry();
    graticuleGeo.setAttribute('position', new THREE.Float32BufferAttribute(graticulePositions, 3));
    const graticuleMat = new THREE.LineBasicMaterial({
      color: 0x4cc3ff,
      transparent: true,
      opacity: 0.28,
    });
    const graticule = new THREE.LineSegments(graticuleGeo, graticuleMat);
    spinGroup.add(graticule);

    /* ---------------- ground stations (curated demo regions) --------- */
    interface StationEntry {
      station: GlobeStation;
      ring: THREE.Mesh;
      ringMat: THREE.MeshBasicMaterial;
      phase: number;
    }
    const stationNodeGeo = new THREE.SphereGeometry(0.016, 12, 10);
    const stationNodeMat = new THREE.MeshBasicMaterial({ color: 0x45e39a });
    const hitGeo = new THREE.SphereGeometry(0.062, 10, 8);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false }); // raycast-only
    const ringGeo = new THREE.RingGeometry(0.03, 0.045, 32);
    const entries: StationEntry[] = [];
    const hitMeshes: THREE.Mesh[] = [];

    stationList.forEach((station, index) => {
      const pos = latLonToVec3(station.lat, station.lon, 1.004);
      const node = new THREE.Mesh(stationNodeGeo, stationNodeMat);
      node.position.copy(pos);
      node.renderOrder = 2;
      spinGroup.add(node);

      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x45e39a,
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.copy(pos);
      ring.renderOrder = 3;
      ring.userData.stationIndex = index;
      spinGroup.add(ring);

      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.copy(pos);
      hit.userData.stationIndex = index;
      spinGroup.add(hit);
      hitMeshes.push(hit);

      entries.push({ station, ring, ringMat, phase: (index * 1.37) % (Math.PI * 2) });
    });

    /* ---------------- uplink arcs (marching dashes) ------------------ */
    const arcMaterials: THREE.ShaderMaterial[] = [];
    // Arc endpoints resolve against whatever station list is active,
    // matching the curated preset keys by coordinate.
    const findStation = (key: string): GlobeStation | undefined => {
      const preset = REGION_PRESETS.find((r) => r.key === key);
      if (preset) {
        const match = stationList.find(
          (s) => Math.abs(s.lat - preset.lat) < 0.01 && Math.abs(s.lon - preset.lon) < 0.01,
        );
        if (match) return match;
      }
      return stationList.find((s) => s.label.toLowerCase().includes(key.split('-')[0]));
    };
    ARC_PAIRS.forEach(([keyA, keyB], arcIndex) => {
      const from = findStation(keyA);
      const to = findStation(keyB);
      if (!from || !to) return;

      const vA = latLonToVec3(from.lat, from.lon, 1.002);
      const vB = latLonToVec3(to.lat, to.lon, 1.002);
      const angle = vA.angleTo(vB);
      const mid = vA.clone().add(vB).multiplyScalar(0.5).normalize().multiplyScalar(1 + 0.16 + (angle / Math.PI) * 0.22);
      const curve = new THREE.QuadraticBezierCurve3(vA, mid, vB);
      const pts = curve.getPoints(48);

      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.ShaderMaterial({
        vertexShader: DASH_VERT,
        fragmentShader: DASH_FRAG,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uColor: { value: new THREE.Color('#FC3D21') },
          uOpacity: { value: 0.55 },
          uOffset: { value: arcIndex * 0.13 },
          uDash: { value: 0.26 },
          uGap: { value: 0.18 },
        },
      });
      const line = new THREE.Line(geo, mat);
      line.computeLineDistances();
      line.renderOrder = 3;
      arcMaterials.push(mat);
      spinGroup.add(line);
    });

    /* ---------------- orbit ring + satellite ------------------------- */
    const orbitGroup = new THREE.Group();
    orbitGroup.rotation.x = 0.45;
    orbitGroup.rotation.z = -0.18;
    scene.add(orbitGroup);

    const ORBIT_A = 1.5;
    const ORBIT_B = 1.08;
    const ellipsePoint = (t: number): THREE.Vector3 =>
      new THREE.Vector3(ORBIT_A * Math.cos(t), 0, ORBIT_B * Math.sin(t));

    const orbitPts: THREE.Vector3[] = [];
    for (let i = 0; i < 128; i++) orbitPts.push(ellipsePoint((i / 128) * Math.PI * 2));
    const orbitGeo = new THREE.BufferGeometry().setFromPoints(orbitPts);
    const orbitMat = new THREE.LineBasicMaterial({
      color: 0x97aee0,
      transparent: true,
      opacity: 0.6,
    });
    const orbitRing = new THREE.LineLoop(orbitGeo, orbitMat);
    orbitGroup.add(orbitRing);

    const satelliteGeo = new THREE.SphereGeometry(0.042, 12, 10);
    const satelliteMat = new THREE.MeshBasicMaterial({ color: 0xfc3d21 });
    const satellite = new THREE.Mesh(satelliteGeo, satelliteMat);
    orbitGroup.add(satellite);

    const TRAIL_POINTS = 16;
    const TRAIL_SPAN = 0.34; // radians of orbit behind the satellite
    const trailPositions = new Float32Array(TRAIL_POINTS * 3);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
    const trailMat = new THREE.LineBasicMaterial({
      color: 0xfc3d21,
      transparent: true,
      opacity: 0.5,
    });
    const trail = new THREE.Line(trailGeo, trailMat);
    orbitGroup.add(trail);

    /* ---------------- starfield (seeded, two clouds) ----------------- */
    const rng = mulberry32(0x54455241); // "TERR"
    const makeStarCloud = (count: number, size: number, opacity: number): THREE.Points => {
      const positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const u = rng() * 2 - 1;
        const az = rng() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        const r = 11 + rng() * 7;
        positions[i * 3] = s * Math.cos(az) * r;
        positions[i * 3 + 1] = u * r;
        positions[i * 3 + 2] = s * Math.sin(az) * r;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({
        color: 0xeaf0fb,
        size: size * pixelRatio, // gl_PointSize is framebuffer pixels
        sizeAttenuation: false,
        transparent: true,
        opacity,
        depthWrite: false,
      });
      return new THREE.Points(geo, mat);
    };
    const starsA = makeStarCloud(320, 1.7, 0.9);
    const starsB = makeStarCloud(180, 1.15, 0.4);
    scene.add(starsA, starsB);

    /* ---------------- initial orientation --------------------------- */
    // Face the primary demo region (Nakuru preset) toward the camera.
    const focusLat = stationList[0]?.lat ?? -0.28;
    const focusLon = stationList[0]?.lon ?? 36.07;
    const focusVec = latLonToVec3(focusLat, focusLon, 1);
    let spin = -Math.atan2(focusVec.x, focusVec.z);
    let tilt = 0.22;
    spinGroup.rotation.y = spin;
    tiltGroup.rotation.x = tilt;

    /* ---------------- interaction state ----------------------------- */
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const AUTO_ROTATE = 0.05; // rad/s
    const DRAG_ROTATE = 0.0045; // rad per horizontal px
    const DRAG_TILT = 0.0032; // rad per vertical px
    const TILT_CLAMP = 0.6;

    const drag = { active: false, lastX: 0, lastY: 0, lastT: 0, vel: 0 };
    let spinVel = 0; // rad/s, inertia after release
    let lastInteract = -1e9;
    let raf = 0;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    let lastHover: GlobeStation | null = null;
    const setHover = (station: GlobeStation | null) => {
      if (lastHover === station) return;
      lastHover = station;
      hoverCbRef.current?.(station);
      setHovered(station);
    };

    const onPointerDown = (e: PointerEvent) => {
      drag.active = true;
      drag.vel = 0;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      drag.lastT = e.timeStamp;
      spinVel = 0;
      lastInteract = performance.now();
      canvas.style.cursor = 'grabbing';
      setHover(null);
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (drag.active) {
        const dx = e.clientX - drag.lastX;
        const dy = e.clientY - drag.lastY;
        const dt = Math.max(e.timeStamp - drag.lastT, 1);
        spin += dx * DRAG_ROTATE;
        tilt = THREE.MathUtils.clamp(tilt + dy * DRAG_TILT, -TILT_CLAMP, TILT_CLAMP);
        spinGroup.rotation.y = spin;
        tiltGroup.rotation.x = tilt;
        const instV = dx / dt; // px/ms
        drag.vel = drag.vel * 0.75 + instV * 0.25;
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        drag.lastT = e.timeStamp;
        lastInteract = performance.now();
        return;
      }
      // Hover raycast (stations only, globe mesh occludes far-side nodes).
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects([globeMesh, ...hitMeshes], false);
      const first = hits[0];
      const idx = first && first.object !== globeMesh ? (first.object.userData.stationIndex as number) : undefined;
      setHover(idx === undefined ? null : entries[idx]?.station ?? null);
    };

    const endDrag = (e: PointerEvent) => {
      if (!drag.active) return;
      drag.active = false;
      spinVel = THREE.MathUtils.clamp(drag.vel * DRAG_ROTATE * 1000, -1.4, 1.4); // rad/s
      lastInteract = performance.now();
      canvas.style.cursor = 'grab';
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };

    const onPointerLeave = () => setHover(null);

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', onPointerLeave);

    const onContextLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      setFailed(true);
    };
    canvas.addEventListener('webglcontextlost', onContextLost, false);

    /* ---------------- sizing ---------------------------------------- */
    const resize = () => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      renderer.setSize(w, h, false);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    /* ---------------- animation loop -------------------------------- */
    const clock = new THREE.Clock();
    let elapsed = 0;
    const SAT_BASE_ANGLE = 1.2;
    const SAT_SPEED = 0.3;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const delta = Math.min(clock.getDelta(), 0.05);
      elapsed += delta;

      if (!drag.active && Math.abs(spinVel) > 0.004) {
        spin += spinVel * delta;
        spinVel *= Math.exp(-2.8 * delta);
        if (spinVel < 0.004 && spinVel > -0.004) spinVel = 0;
      }
      const idle = performance.now() - lastInteract > 3000;
      if (!reduceMotion && idle && !drag.active) spin += AUTO_ROTATE * delta;
      if (spin > Math.PI) spin -= Math.PI * 2;
      else if (spin < -Math.PI) spin += Math.PI * 2;
      spinGroup.rotation.y = spin;

      // Marching dashes on uplink arcs.
      if (!reduceMotion) {
        for (const m of arcMaterials) m.uniforms.uOffset.value -= delta * 0.5;
      }

      // Satellite + trail along the tilted ellipse.
      const satAngle = reduceMotion ? SAT_BASE_ANGLE : SAT_BASE_ANGLE + elapsed * SAT_SPEED;
      satellite.position.copy(ellipsePoint(satAngle));
      for (let i = 0; i < TRAIL_POINTS; i++) {
        const p = ellipsePoint(satAngle - (i / (TRAIL_POINTS - 1)) * TRAIL_SPAN);
        trailPositions[i * 3] = p.x;
        trailPositions[i * 3 + 1] = p.y;
        trailPositions[i * 3 + 2] = p.z;
      }
      trailGeo.attributes.position.needsUpdate = true;
      trailGeo.computeBoundingSphere();

      // Billboard + pulse the station rings (camera-facing).
      scene.updateMatrixWorld();
      const now = elapsed * 2.2;
      for (const entry of entries) {
        if (reduceMotion) {
          entry.ring.scale.setScalar(1);
          entry.ringMat.opacity = 0.4;
        } else {
          const s = 0.78 + 0.32 * (0.5 + 0.5 * Math.sin(now + entry.phase));
          entry.ring.scale.setScalar(s);
          entry.ringMat.opacity = 0.28 + 0.24 * (0.5 + 0.5 * Math.sin(now + entry.phase));
        }
        entry.ring.lookAt(camera.position);
      }

      renderer.render(scene, camera);
    };
    tick();

    /* ---------------- strict-mode-safe cleanup ---------------------- */
    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      eventLayerRef.current = null;
      eventLayer.dispose();
      scene.traverse((obj) => {
        const anyObj = obj as THREE.Mesh | THREE.Line | THREE.Points;
        if (anyObj.geometry) anyObj.geometry.dispose();
        const mat = anyObj.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
      renderer.dispose();
      renderer.forceContextLoss();
      if (canvas.parentElement === container) container.removeChild(canvas);
      setHover(null);
    };
    // stationList identity is stable (module-level default or parent-memoized prop).
  }, [stationList]);

  return (
    <div
      className={cn('relative h-full w-full overflow-hidden', className)}
      role="group"
      aria-label="Stylized mission globe with demo stations and polled NASA EONET wildfire event positions"
    >
      <div ref={containerRef} className="absolute inset-0" aria-hidden />
      <LiveGlobeEvents failed={failed} query={liveQuery} />

      {/* Standalone hover chip (only when the parent does not handle hover). */}
      {!failed && hovered && !onStationHover && (
        <div className="anim-fade-up hud hud-calm absolute bottom-2.5 left-2.5 z-10 max-w-[70%] px-3 py-2">
          <p className="truncate font-mono text-[11px] uppercase tracking-wide-mc text-signal glow-signal">
            {hovered.label}
          </p>
          <p className="mt-0.5 flex items-center gap-2">
            <CoordReadout lat={hovered.lat} lon={hovered.lon} />
            <span className="font-mono text-[9px] uppercase tracking-wide-mc text-faint">demo preset</span>
          </p>
        </div>
      )}

      {/* Context-loss / no-WebGL fallback — never a blank surface. */}
      {failed && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-void/95 text-center">
          <MissionPatch className="h-16 w-16 sm:h-20 sm:w-20" animated={false} />
          <p className="max-w-[16rem] font-mono text-[10px] uppercase leading-relaxed tracking-wide-mc text-faint">
            3D layer offline — static mission patch shown
          </p>
        </div>
      )}
    </div>
  );
}
