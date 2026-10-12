import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { World, Layer } from '../core/model';
import { nearestCell } from '../core/grid/build';
import { sampleCellColor, CATEGORICAL } from './palette';
import type { FlowParticles } from './FlowParticles';
import type { createRiverStrips } from './RiverStrips';
import { BANK_LAYERS, createLayerMaterial, createRiverbankTexture } from './RiverbankTexture';
import { exposedLandFraction } from '../core/generation/lake-state';
import { ResourceMarkers, type ResourceFilter } from './ResourceMarkers';
import {
  buildCellMesh,
  buildOverlayMeshes,
  surfaceHeight,
  cornerHeight,
  displayRadiusAtHeight,
} from './WorldMeshes';
import { createNaturalMaterial, updateNaturalSurface } from './NaturalSurface';
import { createArtMaterial, mapReliefScale, type MapStyle } from './MapStyle';
import { CartographicSymbols, loadSymbolAtlas } from './CartographicSymbols';
import { createCoastlines } from './Coastlines';
import {
  clipMapMaterial,
  MAP_HEIGHT,
  MAP_WIDTH,
  projectLines,
  projectMesh,
  spherePoint,
  updateMapAttributes,
  type Projection,
} from './projection';

export interface WorldViewProps {
  mapStyle: MapStyle;
  projection: Projection;
  coastlines: boolean;
  world: World | null;
  layer: Layer;
  season: number;
  gridLines: boolean;
  boundaries: boolean;
  animated: boolean;
  particleCount: number;
  flowSpeed: number;
  riverWidth: number;
  rivers: boolean;
  vectors: boolean;
  rotation: boolean;
  relief: number;
  riverThreshold: number;
  drift: number;
  selected: number | null;
  onSelect: (cell: number | null) => void;
  resourceFilter: ResourceFilter;
  selectedDeposit: string | null;
  onSelectDeposit: (id: string | null) => void;
  command: { kind: 'in' | 'out' | 'reset'; id: number };
}

interface View {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls: OrbitControls;
  root: THREE.Group;
  surface: THREE.Mesh | null;
  dual: THREE.Mesh | null;
  overlay: THREE.Group;
  selection: THREE.LineSegments | null;
  coasts: THREE.LineSegments | null;
  world: World | null;
  frame: number;
  flow: FlowParticles | null;
  river: ReturnType<typeof createRiverStrips> | null;
  bankTexture: THREE.DataTexture | null;
  bankSeason: number;
  resources: ResourceMarkers | null;
  symbols: CartographicSymbols | null;
  symbolAtlas: THREE.Texture | null;
  atmosphere: THREE.Object3D;
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;

    if (mesh.geometry) {
      mesh.geometry.dispose();
    }

    if (mesh.material) {
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        material.dispose();
      }
    }
  });
  object.removeFromParent();
}

export default function WorldView(props: WorldViewProps) {
  const style = props.layer === 'world' ? props.mapStyle : 'natural';
  const mapHeightScale = mapReliefScale(style);
  const axis = useRef<SVGSVGElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<View | null>(null);
  const latest = useRef(props);
  const [error, setError] = useState('');
  latest.current = props;

  useEffect(() => {
    const container = host.current!;
    const flat = props.projection === 'map';
    let renderer: THREE.WebGLRenderer;

    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      setError('WebGL is unavailable. Enable hardware acceleration to explore the world.');

      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor('#080e15', 0);
    container.appendChild(renderer.domElement);
    renderer.domElement.setAttribute(
      'aria-label',
      flat
        ? 'Interactive map. Drag to pan, scroll to zoom, click a cell to inspect.'
        : 'Interactive planet. Drag to rotate, scroll to zoom, click a cell to inspect.',
    );
    renderer.domElement.setAttribute('role', 'img');
    const scene = new THREE.Scene();
    const camera = flat
      ? new THREE.OrthographicCamera(-Math.PI, Math.PI, Math.PI / 2, -Math.PI / 2, 0.01, 100)
      : new THREE.PerspectiveCamera(38, 1, 0.01, 100);

    if (flat) {
      camera.position.set(0, 0, 6);
    } else {
      camera.position.set(2.25, 0.85, 2.05);
    }

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 1.18;
    controls.maxDistance = 5.5;
    controls.enablePan = false;
    controls.rotateSpeed = 0.5;
    controls.autoRotateSpeed = 0.35;

    if (flat) {
      controls.enableRotate = false;
      controls.enablePan = true;
      controls.screenSpacePanning = true;
      controls.minZoom = 1;
      controls.maxZoom = 24;
      controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      controls.touches.ONE = THREE.TOUCH.PAN;
      controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    }

    const root = new THREE.Group();
    const overlay = new THREE.Group();
    scene.add(root);
    root.add(overlay);
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.025, 80, 48),
      new THREE.ShaderMaterial({
        vertexShader: /* glsl */ `
          varying vec3 surfaceNormal;
          varying vec3 viewDirection;

          void main() {
            vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
            surfaceNormal = normalize(normalMatrix * normal);
            viewDirection = normalize(-viewPosition.xyz);
            gl_Position = projectionMatrix * viewPosition;
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec3 surfaceNormal;
          varying vec3 viewDirection;

          void main() {
            float rim = pow(
              1.0 - abs(dot(normalize(surfaceNormal), normalize(viewDirection))),
              3.5
            );
            gl_FragColor = vec4(0.22, 0.55, 0.7, rim * 0.23);
          }
        `,
        transparent: true,
        depthWrite: false,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    root.add(atmosphere);
    atmosphere.visible = !flat;
    const poles = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, -1.18, 0),
        new THREE.Vector3(0, 1.18, 0),
      ]),
      new THREE.LineDashedMaterial({
        color: '#cfb983',
        transparent: true,
        opacity: 0.55,
        dashSize: 0.014,
        gapSize: 0.013,
      }),
    );
    poles.computeLineDistances();
    root.add(poles);
    poles.visible = !flat;
    const state: View = {
      renderer,
      scene,
      camera,
      controls,
      root,
      surface: null,
      dual: null,
      overlay,
      selection: null,
      coasts: null,
      world: null,
      frame: 0,
      flow: null,
      river: null,
      bankTexture: null,
      bankSeason: latest.current.season,
      resources: null,
      symbols: null,
      symbolAtlas: null,
      atmosphere,
    };
    view.current = state;
    const observer = new ResizeObserver(() => {
      const viewportWidth = container.clientWidth;
      const viewportHeight = container.clientHeight;

      if (!viewportWidth || !viewportHeight) {
        return;
      }

      renderer.setSize(viewportWidth, viewportHeight);

      if (camera instanceof THREE.OrthographicCamera) {
        const halfHeight =
          Math.max(MAP_HEIGHT / 2, (MAP_WIDTH * viewportHeight) / (2 * viewportWidth)) * 1.12;
        camera.left = (-halfHeight * viewportWidth) / viewportHeight;
        camera.right = -camera.left;
        camera.top = halfHeight;
        camera.bottom = -halfHeight;
      } else {
        camera.aspect = viewportWidth / viewportHeight;
      }

      camera.updateProjectionMatrix();
    });
    observer.observe(container);
    const down = { x: 0, y: 0 };

    const onDown = (event: PointerEvent) => {
      down.x = event.clientX;
      down.y = event.clientY;
    };

    const raycaster = new THREE.Raycaster();
    const sphere = new THREE.Sphere(new THREE.Vector3(), 1);
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const hit = new THREE.Vector3();

    const onUp = (event: PointerEvent) => {
      if (
        Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5 ||
        !state.world ||
        (latest.current.layer === 'tectonics' && latest.current.drift !== 0)
      ) {
        return;
      }

      const rect = container.getBoundingClientRect();
      const deposit = state.resources?.pick(
        camera,
        event.clientX - rect.left,
        event.clientY - rect.top,
        rect.width,
        rect.height,
      );
      if (deposit) {
        latest.current.onSelectDeposit(deposit);
        return;
      }
      latest.current.onSelectDeposit(null);
      raycaster.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          (-(event.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );

      if (flat) {
        if (
          latest.current.layer === 'world' &&
          latest.current.mapStyle === 'relief' &&
          state.surface
        ) {
          const intersection = raycaster
            .intersectObject(state.surface, false)
            .find((entry) => Math.abs(entry.point.x) <= Math.PI);
          if (!intersection?.face) {
            latest.current.onSelect(null);
            return;
          }
          const geometry = state.surface.geometry;
          const vertices = geometry.getAttribute('position');
          const spherical = geometry.getAttribute('spherePosition');
          const { a, b, c } = intersection.face;
          const triangle = new THREE.Triangle(
            new THREE.Vector3().fromBufferAttribute(vertices, a),
            new THREE.Vector3().fromBufferAttribute(vertices, b),
            new THREE.Vector3().fromBufferAttribute(vertices, c),
          );
          const weights = triangle.getBarycoord(
            root.worldToLocal(intersection.point.clone()),
            new THREE.Vector3(),
          );
          if (!weights) {
            return;
          }
          hit.set(0, 0, 0);
          const point = new THREE.Vector3();
          for (const [vertex, weight] of [
            [a, weights.x],
            [b, weights.y],
            [c, weights.z],
          ]) {
            hit.addScaledVector(point.fromBufferAttribute(spherical, vertex), weight);
          }
          hit.normalize();
          const grid = state.world.grid;
          latest.current.onSelect(
            nearestCell(grid, hit.x, hit.y, hit.z, latest.current.selected ?? 0),
          );
          return;
        }
        if (
          !raycaster.ray.intersectPlane(plane, hit) ||
          Math.abs(hit.x) > Math.PI ||
          Math.abs(hit.y) > Math.PI / 2
        ) {
          latest.current.onSelect(null);

          return;
        }

        spherePoint(hit.x, hit.y, hit);
      } else {
        if (!raycaster.ray.intersectSphere(sphere, hit)) {
          latest.current.onSelect(null);

          return;
        }

        root.worldToLocal(hit).normalize();
      }

      const grid = state.world.grid;
      latest.current.onSelect(nearestCell(grid, hit.x, hit.y, hit.z, latest.current.selected ?? 0));
    };

    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    let previous = performance.now();
    let flowTime = 0;
    const north = new THREE.Vector3();
    const orientation = new THREE.Quaternion();

    const animate = () => {
      state.frame = requestAnimationFrame(animate);
      controls.autoRotate = !flat && latest.current.rotation;
      controls.update();

      if (camera instanceof THREE.OrthographicCamera) {
        // Keep panning bounded by the visible map, including after zooming out.
        const xLimit = Math.max(0, Math.PI - camera.right / camera.zoom);
        const yLimit = Math.max(0, Math.PI / 2 - camera.top / camera.zoom);
        const x = THREE.MathUtils.clamp(controls.target.x, -xLimit, xLimit);
        const y = THREE.MathUtils.clamp(controls.target.y, -yLimit, yLimit);
        camera.position.x += x - controls.target.x;
        camera.position.y += y - controls.target.y;
        controls.target.set(x, y, 0);
      }

      const now = performance.now();
      const delta = Math.min(0.05, (now - previous) / 1000);
      previous = now;

      if (latest.current.animated && !document.hidden) {
        flowTime += delta * latest.current.flowSpeed;
        state.flow?.update(delta, latest.current.flowSpeed);
        state.river?.update(flowTime);
      }

      // Camera-relative axis: y-up is geographical north in the simulation.
      orientation.copy(camera.quaternion).invert();
      north.set(0, 1, 0).applyQuaternion(orientation);
      const svg = axis.current;

      if (svg) {
        const x = north.x * 26;
        const y = -north.y * 26;
        const nearPole = Math.hypot(x, y) < 9;
        const line = svg.querySelector('line')!;
        line.setAttribute('x1', String(36 - x));
        line.setAttribute('y1', String(36 - y));
        line.setAttribute('x2', String(36 + x));
        line.setAttribute('y2', String(36 + y));
        const northLabel = svg.querySelector('[data-north]')!;
        const south = svg.querySelector('[data-south]')!;
        northLabel.setAttribute('x', String(36 + x * 1.25));
        northLabel.setAttribute('y', String(36 + y * 1.25 - (nearPole ? 11 : 0)));
        south.setAttribute('x', String(36 - x * 1.25));
        south.setAttribute('y', String(36 - y * 1.25 + (nearPole ? 11 : 0)));
        northLabel.setAttribute('opacity', north.z < 0 ? '.5' : '1');
        south.setAttribute('opacity', north.z > 0 ? '.5' : '1');
      }

      state.resources?.updateViewport(renderer, camera);
      state.symbols?.updateViewport(renderer);
      renderer.render(scene, camera);
    };

    animate();

    return () => {
      cancelAnimationFrame(state.frame);
      observer.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      disposeObject(root);
      state.bankTexture?.dispose();
      state.symbolAtlas?.dispose();
      renderer.dispose();
      container.replaceChildren();
      view.current = null;
    };
  }, [props.projection]);

  useEffect(() => {
    const sceneView = view.current;
    const world = props.world;

    if (!sceneView) {
      return;
    }

    if (sceneView.surface) {
      disposeObject(sceneView.surface);
    }

    if (sceneView.dual) {
      disposeObject(sceneView.dual);
    }

    sceneView.surface = null;
    sceneView.dual = null;

    if (sceneView.world !== world) {
      sceneView.bankTexture?.dispose();
      sceneView.bankTexture = null;
    }

    sceneView.world = world;

    if (!world) {
      return;
    }

    // Read the current season when constructing geometry. The following effect
    // handles season changes without rebuilding the surface mesh.
    const initialSeason = latest.current.season;

    if (!sceneView.bankTexture) {
      sceneView.bankTexture = createRiverbankTexture(world, initialSeason);
      sceneView.bankSeason = initialSeason;
    }

    const grid = world.grid;
    const position = new Float32Array(grid.count * 3);

    for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
      const displayRadius = displayRadiusAtHeight(
        surfaceHeight(world, cellIndex),
        props.relief,
        world.config.radius,
      );

      for (let axisIndex = 0; axisIndex < 3; axisIndex++) {
        position[cellIndex * 3 + axisIndex] =
          grid.positions[cellIndex * 3 + axisIndex] * displayRadius;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(grid.count * 3), 3));
    geometry.setAttribute(
      'bankLand',
      new THREE.BufferAttribute(
        Float32Array.from({ length: grid.count }, (_, cellIndex) =>
          exposedLandFraction(world.terrain, world.drainage, cellIndex),
        ),
        1,
      ),
    );
    geometry.setIndex(new THREE.BufferAttribute(grid.triangles, 1));
    geometry.computeVertexNormals();
    updateNaturalSurface(geometry, world, initialSeason);
    const flat = props.projection === 'map';
    const material = createNaturalMaterial(world.config.seed, flat, sceneView.bankTexture);

    if (flat) {
      projectMesh(geometry, 0, mapHeightScale);
      clipMapMaterial(material);
    }

    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.worldShading = 'natural';
    sceneView.surface = mesh;
    sceneView.root.add(mesh);
  }, [props.world, props.relief, props.projection, mapHeightScale]);

  useEffect(() => {
    const sceneView = view.current;
    const world = props.world;

    if (!sceneView || !world || !sceneView.surface || !sceneView.bankTexture) {
      return;
    }

    if (sceneView.bankSeason !== props.season) {
      const updated = createRiverbankTexture(world, props.season);
      sceneView.bankTexture.image = updated.image;
      sceneView.bankTexture.needsUpdate = true;
      sceneView.bankSeason = props.season;
    }

    const categorical = CATEGORICAL.includes(props.layer);

    if (categorical && !sceneView.dual) {
      sceneView.dual = buildCellMesh(world, props.relief, props.projection, sceneView.bankTexture);
      sceneView.root.add(sceneView.dual);
    }

    sceneView.surface.visible = !categorical;

    if (sceneView.dual) {
      sceneView.dual.visible = categorical;
    }

    const natural = props.layer === 'world';

    const materialStyle = natural ? style : 'analytic';
    if (sceneView.surface.userData.worldShading !== materialStyle) {
      (sceneView.surface.material as THREE.Material).dispose();
      sceneView.surface.material = natural
        ? style === 'natural'
          ? createNaturalMaterial(
              world.config.seed,
              props.projection === 'map',
              sceneView.bankTexture,
            )
          : createArtMaterial(
              world.config.seed,
              style,
              props.projection === 'map',
              sceneView.bankTexture,
            )
        : createLayerMaterial(sceneView.bankTexture, props.projection === 'map');

      if (props.projection === 'map') {
        clipMapMaterial(sceneView.surface.material as THREE.Material);
      }

      sceneView.surface.userData.worldShading = materialStyle;
    }
    sceneView.atmosphere.visible = props.projection === 'globe' && style !== 'illustrated';

    for (const mesh of [sceneView.surface, sceneView.dual]) {
      const enabled = (mesh?.material as THREE.Material | undefined)?.userData.bankEnabled;

      if (enabled) {
        enabled.value = BANK_LAYERS.includes(props.layer) ? 1 : 0;
      }
    }

    const colors = sceneView.surface.geometry.getAttribute('color') as THREE.BufferAttribute;
    const target = new THREE.Color();

    if (natural) {
      updateNaturalSurface(sceneView.surface.geometry, world, props.season);
    } else {
      for (let cellIndex = 0; cellIndex < world.grid.count; cellIndex++) {
        sampleCellColor(world, cellIndex, props.layer, props.season, target);
        colors.setXYZ(cellIndex, target.r, target.g, target.b);
      }

      colors.needsUpdate = true;
      updateMapAttributes(sceneView.surface.geometry, ['color']);
    }

    if (categorical && sceneView.dual) {
      const colorAttribute = sceneView.dual.geometry.getAttribute('color') as THREE.BufferAttribute;
      const cellIndices = sceneView.dual.geometry.getAttribute('cell') as THREE.BufferAttribute;
      let last = -1;

      for (let vertexIndex = 0; vertexIndex < cellIndices.count; vertexIndex++) {
        const cellIndex = cellIndices.getX(vertexIndex);

        if (cellIndex !== last) {
          sampleCellColor(world, cellIndex, props.layer, props.season, target);
          last = cellIndex;
        }

        colorAttribute.setXYZ(vertexIndex, target.r, target.g, target.b);
      }

      colorAttribute.needsUpdate = true;
    }

    // Purely kinematic plate displacement. Current-day fields are not regenerated.
    if (sceneView.dual && props.projection === 'globe') {
      const positionAttribute = sceneView.dual.geometry.getAttribute(
        'position',
      ) as THREE.BufferAttribute;
      const base = sceneView.dual.geometry.userData.base as Float32Array;
      const cellIndices = sceneView.dual.geometry.getAttribute('cell') as THREE.BufferAttribute;
      const position = new THREE.Vector3();
      const axis = new THREE.Vector3();

      for (let vertexIndex = 0; vertexIndex < positionAttribute.count; vertexIndex++) {
        position.fromArray(base, vertexIndex * 3);

        if (props.layer === 'tectonics' && props.drift !== 0) {
          const plate =
            world.geology.plates[
              world.geology.plate[world.transfer[cellIndices.getX(vertexIndex)]]
            ];
          axis.fromArray(plate.omega);
          const speed = axis.length();
          axis.normalize();
          position.applyAxisAngle(axis, ((props.drift * Math.PI) / 180) * speed);
        }

        positionAttribute.setXYZ(vertexIndex, position.x, position.y, position.z);
      }

      positionAttribute.needsUpdate = true;
    }
  }, [
    props.world,
    props.layer,
    props.season,
    props.relief,
    props.drift,
    props.projection,
    style,
    mapHeightScale,
  ]);

  useEffect(() => {
    const sceneView = view.current;
    const world = props.world;

    if (!sceneView) {
      return;
    }

    while (sceneView.overlay.children.length) {
      disposeObject(sceneView.overlay.children[0]);
    }

    sceneView.flow = null;
    sceneView.river = null;

    if (!world) {
      return;
    }

    if (props.drift !== 0 && props.layer === 'tectonics') {
      return;
    }

    const effects = buildOverlayMeshes(sceneView.overlay, world, {
      mapStyle: props.mapStyle,
      projection: props.projection,
      layer: props.layer,
      season: props.season,
      gridLines: props.gridLines,
      boundaries: props.boundaries,
      particleCount: props.particleCount,
      riverWidth: props.riverWidth,
      rivers: props.rivers,
      vectors: props.vectors,
      relief: props.relief,
      riverThreshold: props.riverThreshold,
    });
    sceneView.flow = effects.flow;
    sceneView.river = effects.river;
  }, [
    props.world,
    props.layer,
    props.season,
    props.gridLines,
    props.boundaries,
    props.particleCount,
    props.riverWidth,
    props.rivers,
    props.vectors,
    props.relief,
    props.riverThreshold,
    props.drift,
    props.projection,
    props.mapStyle,
  ]);

  useEffect(() => {
    const sceneView = view.current;
    const world = props.world;

    if (!sceneView) {
      return;
    }

    if (sceneView.coasts) {
      disposeObject(sceneView.coasts);
    }

    sceneView.coasts = null;

    if (!world || !props.coastlines || (props.layer === 'tectonics' && props.drift !== 0)) {
      return;
    }

    sceneView.coasts = createCoastlines(world, props.relief, props.projection, style);
    sceneView.root.add(sceneView.coasts);
  }, [
    props.world,
    props.relief,
    props.projection,
    props.coastlines,
    props.layer,
    props.drift,
    style,
  ]);

  useEffect(() => {
    const sceneView = view.current;
    const world = props.world;

    if (!sceneView) {
      return;
    }

    if (sceneView.selection) {
      disposeObject(sceneView.selection);
    }

    sceneView.selection = null;

    if (!world || props.selected === null || (props.layer === 'tectonics' && props.drift !== 0)) {
      return;
    }

    const cellIndex = props.selected;
    const grid = world.grid;
    const points: THREE.Vector3[] = [];

    for (
      let neighborOffset = grid.offsets[cellIndex];
      neighborOffset < grid.offsets[cellIndex + 1];
      neighborOffset++
    ) {
      const cornerIndex = grid.cellCorners[neighborOffset];
      const displayRadius =
        displayRadiusAtHeight(cornerHeight(world, cornerIndex), props.relief, world.config.radius) +
        0.004;
      points.push(
        new THREE.Vector3(
          grid.corners[cornerIndex * 3] * displayRadius,
          grid.corners[cornerIndex * 3 + 1] * displayRadius,
          grid.corners[cornerIndex * 3 + 2] * displayRadius,
        ),
      );
    }

    const segments = points.flatMap((point, pointIndex) => [
      point,
      points[(pointIndex + 1) % points.length],
    ]);
    const geometry = new THREE.BufferGeometry().setFromPoints(segments);

    if (props.projection === 'map') {
      projectLines(geometry, 0.016, mapHeightScale, 0.004);
    }

    sceneView.selection = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: '#fff4c9', depthTest: false }),
    );
    sceneView.selection.renderOrder = 4;
    sceneView.root.add(sceneView.selection);
  }, [
    props.selected,
    props.world,
    props.relief,
    props.layer,
    props.drift,
    props.projection,
    mapHeightScale,
  ]);

  useEffect(() => {
    const sceneView = view.current;
    if (!sceneView) {
      return;
    }
    if (sceneView.symbols) {
      disposeObject(sceneView.symbols);
    }
    sceneView.symbols = null;
    if (!props.world || style !== 'illustrated') {
      return;
    }
    if (!sceneView.symbolAtlas) {
      sceneView.symbolAtlas = loadSymbolAtlas();
    }
    sceneView.symbols = new CartographicSymbols(
      props.world,
      props.relief,
      props.season,
      props.projection,
      sceneView.symbolAtlas,
    );
    sceneView.root.add(sceneView.symbols);
  }, [props.world, props.relief, props.season, props.projection, style]);

  useEffect(() => {
    const sceneView = view.current;
    if (!sceneView) {
      return;
    }
    if (sceneView.resources) {
      disposeObject(sceneView.resources);
    }
    sceneView.resources = null;
    if (props.world && props.layer === 'resources') {
      sceneView.resources = new ResourceMarkers(
        props.world,
        props.resourceFilter,
        props.projection,
        props.relief,
        props.selectedDeposit,
      );
      sceneView.root.add(sceneView.resources);
    }
  }, [
    props.world,
    props.layer,
    props.resourceFilter,
    props.projection,
    props.relief,
    props.selectedDeposit,
  ]);

  useEffect(() => {
    const sceneView = view.current;

    if (!sceneView) {
      return;
    }

    const viewCommand = props.command;

    if (sceneView.camera instanceof THREE.OrthographicCamera) {
      sceneView.camera.zoom =
        viewCommand.kind === 'reset'
          ? 1
          : THREE.MathUtils.clamp(
              sceneView.camera.zoom * (viewCommand.kind === 'in' ? 1.25 : 0.8),
              1,
              24,
            );

      if (viewCommand.kind === 'reset') {
        sceneView.camera.position.set(0, 0, 6);
        sceneView.controls.target.set(0, 0, 0);
      }

      sceneView.camera.updateProjectionMatrix();
      sceneView.controls.update();

      return;
    }

    if (viewCommand.kind === 'reset') {
      sceneView.camera.position.set(2.25, 0.85, 2.05);
      sceneView.controls.target.set(0, 0, 0);
    } else {
      sceneView.camera.position.multiplyScalar(viewCommand.kind === 'in' ? 0.8 : 1.25);
    }

    sceneView.camera.position.clampLength(1.18, 5.5);
    sceneView.controls.update();
  }, [props.command]);

  return (
    <>
      <div ref={host} className="globe-canvas" />
      <svg
        ref={axis}
        className="axis-indicator"
        viewBox="0 0 72 84"
        role="img"
        aria-label={
          props.projection === 'map'
            ? 'North is up, east is right.'
            : 'Rotation axis: N is north, S is south. Dimmed pole points away.'
        }
      >
        <circle cx="36" cy="36" r="19" fill="none" stroke="currentColor" opacity=".12" />
        <line x1="36" y1="60" x2="36" y2="12" stroke="currentColor" strokeWidth="1" />
        <circle cx="36" cy="36" r="2" fill="currentColor" />
        <text data-north x="36" y="8">
          N
        </text>
        <text data-south x="36" y="66">
          S
        </text>
        <text x="36" y="80" className="axis-caption">
          {props.projection === 'map' ? 'NORTH UP' : 'SPIN AXIS'}
        </text>
      </svg>
      {error && <div className="globe-error">{error}</div>}
    </>
  );
}
