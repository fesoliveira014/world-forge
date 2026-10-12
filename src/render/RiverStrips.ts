import * as THREE from 'three';
import type { Layer, World } from '../core/model';
import { clamp } from '../core/math';
import { CATEGORICAL, RIVER_SOURCE_COLORS } from './palette';
import { RiverGeometry, riverHalfWidth } from './RiverGeometry';
import { RiverRibbon, type RiverPoint } from './RiverRibbon';
import { WaterSurface, WATER_LIFT } from './WaterSurface';
import { clipMapMaterial, projectMesh, type Projection } from './projection';
import { mapReliefScale, type MapStyle } from './MapStyle';

/** Shared downstream phase on connected courses. Deltas keep a single mouth;
 * their distributaries are represented by seasonal surface cell shading.
 */
export function createRiverStrips(
  world: World,
  threshold: number,
  widthScale: number,
  relief: number,
  season: number,
  projection: Projection = 'globe',
  layer: Layer = 'world',
  network = new RiverGeometry(world),
  style: MapStyle = 'natural',
) {
  const { grid, drainage, rivers } = world;
  const cornerCount = drainage.receiver.length;
  const courses = rivers.courses;
  const downstreamDistance = new Float64Array(cornerCount).fill(-1);
  const reachLengths = new Float64Array(cornerCount);
  const surface = new WaterSurface(
    world,
    relief,
    CATEGORICAL.includes(layer),
    projection === 'map',
    style === 'relief',
  );
  const firstPosition = new THREE.Vector3();
  const secondPosition = new THREE.Vector3();

  for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex++) {
    const receiverCorner = drainage.receiver[cornerIndex];

    if (receiverCorner < 0) {
      downstreamDistance[cornerIndex] = 0;
      continue;
    }

    firstPosition.fromArray(grid.corners, cornerIndex * 3);
    secondPosition.fromArray(grid.corners, receiverCorner * 3);
    reachLengths[cornerIndex] = firstPosition.angleTo(secondPosition);
  }

  for (let courseIndex = 0; courseIndex < courses.corner.length; courseIndex++) {
    const cornerIndex = courses.corner[courseIndex];
    reachLengths[cornerIndex] *= courses.sinuosity[courseIndex];
  }

  for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex++) {
    if (downstreamDistance[cornerIndex] >= 0) {
      continue;
    }

    const chain: number[] = [];
    let next = cornerIndex;

    while (next >= 0 && downstreamDistance[next] === -1) {
      downstreamDistance[next] = -2;
      chain.push(next);
      next = drainage.receiver[next];
    }

    let total = next >= 0 ? Math.max(0, downstreamDistance[next]) : 0;

    while (chain.length) {
      const upstreamCorner = chain.pop()!;
      total += reachLengths[upstreamCorner];
      downstreamDistance[upstreamCorner] = total;
    }
  }

  const warmest = new Float32Array(cornerCount);
  const flowActivity = new Float32Array(cornerCount);

  for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex++) {
    let maximumTemperature = -Infinity;
    let selectedTemperature = 0;

    for (let seasonIndex = 0; seasonIndex < 4; seasonIndex++) {
      let temperature = 0;

      for (let incidentIndex = 0; incidentIndex < 3; incidentIndex++) {
        temperature +=
          world.water.seasonalTemperature[seasonIndex][
            grid.triangles[cornerIndex * 3 + incidentIndex]
          ] / 3;
      }

      maximumTemperature = Math.max(maximumTemperature, temperature);

      if (seasonIndex === season) {
        selectedTemperature = temperature;
      }
    }

    warmest[cornerIndex] = maximumTemperature;
    const relative =
      season < 0
        ? 1
        : rivers.seasonalDischarge[season][cornerIndex] /
          Math.max(1, drainage.discharge[cornerIndex]);
    flowActivity[cornerIndex] =
      season < 0 ? 1 : clamp((selectedTemperature + 1) / 3) * clamp(relative);
  }

  // The strongest visible tributary continues into the trunk. Other tributaries
  // end at its centerline, with their own width, rather than twisting into its frame.
  const visibleChannels = new Uint8Array(cornerCount);
  const strongestUpstream = new Int32Array(cornerCount).fill(-1);

  for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex++) {
    const receiverCorner = drainage.receiver[cornerIndex];
    const discharge = drainage.discharge[cornerIndex];

    if (
      receiverCorner < 0 ||
      !rivers.channel[cornerIndex] ||
      discharge < threshold ||
      (warmest[cornerIndex] <= 0 && warmest[receiverCorner] <= 0)
    ) {
      continue;
    }

    if (
      [0, 1, 2].every(
        (incidentIndex) => world.terrain.ocean[grid.triangles[cornerIndex * 3 + incidentIndex]],
      )
    ) {
      continue;
    }

    visibleChannels[cornerIndex] = 1;

    if (
      strongestUpstream[receiverCorner] < 0 ||
      discharge > drainage.discharge[strongestUpstream[receiverCorner]]
    ) {
      strongestUpstream[receiverCorner] = cornerIndex;
    }
  }

  const ribbon = new RiverRibbon(surface);

  for (let start = 0; start < cornerCount; start++) {
    if (!visibleChannels[start] || strongestUpstream[start] >= 0) {
      continue;
    }

    const chain: RiverPoint[] = [];
    let cornerIndex = start;

    while (true) {
      const receiverCorner = drainage.receiver[cornerIndex];
      const continues =
        !!visibleChannels[receiverCorner] && strongestUpstream[receiverCorner] === cornerIndex;
      const discharge = drainage.discharge[cornerIndex];
      const downstreamDischarge =
        strongestUpstream[receiverCorner] === cornerIndex
          ? drainage.discharge[receiverCorner]
          : discharge;
      const points = network.getCoursePoints(cornerIndex);
      const count = points.length / 3;
      const along = new Float64Array(count);

      for (let sampleIndex = 1; sampleIndex < count; sampleIndex++) {
        firstPosition.fromArray(points, (sampleIndex - 1) * 3);
        secondPosition.fromArray(points, sampleIndex * 3);
        along[sampleIndex] = along[sampleIndex - 1] + firstPosition.angleTo(secondPosition);
      }

      const length = along[count - 1];
      // Water and bank pigment share the same sampled curve. Display width
      // must never simplify its bends away.
      for (let sampleIndex = 0; sampleIndex < count; sampleIndex++) {
        const alongFraction = length > 0 ? along[sampleIndex] / length : 1;
        const position = new THREE.Vector3().fromArray(points, sampleIndex * 3).normalize();
        const sample: RiverPoint = {
          position,
          width: riverHalfWidth(
            discharge + (downstreamDischarge - discharge) * alongFraction,
            widthScale,
          ),
          phase:
            -downstreamDistance[cornerIndex] +
            (downstreamDistance[cornerIndex] - downstreamDistance[receiverCorner]) * alongFraction,
          activity:
            flowActivity[cornerIndex] +
            (flowActivity[receiverCorner] - flowActivity[cornerIndex]) * alongFraction,
          source: rivers.source[cornerIndex],
        };

        // Anchored lake nodes can coincide. Reuse one cross-section, not a
        // zero-length span. Ordinary reach boundaries are shared the same way.
        if (chain.length && position.distanceToSquared(chain[chain.length - 1].position) < 1e-14) {
          chain[chain.length - 1] = sample;
        } else {
          chain.push(sample);
        }
      }

      if (!continues) {
        break;
      }

      cornerIndex = receiverCorner;
    }

    ribbon.addPath(chain);
  }

  const geometry = ribbon.buildGeometry();
  const material = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      inkMode: { value: style === 'illustrated' },
      reliefMode: { value: style === 'relief' },
      sourceMode: { value: layer === 'sources' },
      sourceColors: { value: RIVER_SOURCE_COLORS.map((color) => new THREE.Color(color)) },
    },
    vertexShader: /* glsl */ `
      attribute float activity;
      attribute float sourceId;
      varying vec2 flowCoordinates;
      varying float flowActivity;
      varying float waterSource;

      void main() {
        flowCoordinates = uv;
        flowActivity = activity;
        waterSource = sourceId;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float time;
      uniform bool sourceMode;
      uniform bool inkMode;
      uniform bool reliefMode;
      uniform vec3 sourceColors[7];
      varying vec2 flowCoordinates;
      varying float flowActivity;
      varying float waterSource;

      void main() {
        // Longitudinal phase agrees at shared nodes, including confluences.
        float phase = fract(flowCoordinates.x * 70.0 - time * 0.7 + abs(flowCoordinates.y) * 0.12);
        float pulse = pow(0.5 + 0.5 * cos(phase * 6.2831853), 8.0);
        vec3 baseColor = sourceMode
          ? sourceColors[int(waterSource + 0.5)]
          : vec3(0.10, 0.49, 0.64);
        vec3 waterColor = mix(baseColor, vec3(0.78, 0.99, 0.93), pulse * (sourceMode ? 0.25 : 0.85));
        waterColor = mix(vec3(0.36, 0.46, 0.50), waterColor, flowActivity);
        if (inkMode) {
          waterColor = mix(vec3(0.16, 0.20, 0.19), vec3(0.34, 0.42, 0.39), pulse * 0.18);
          waterColor = mix(vec3(0.40, 0.43, 0.38), waterColor, flowActivity);
        } else if (reliefMode) {
          waterColor = mix(vec3(0.10, 0.30, 0.38), vec3(0.38, 0.65, 0.67), pulse * 0.35);
          waterColor = mix(vec3(0.50, 0.60, 0.61), waterColor, flowActivity);
        }
        gl_FragColor = vec4(
          waterColor,
          (1.0 - smoothstep(0.68, 1.0, abs(flowCoordinates.y))) * mix(0.30, 0.95, flowActivity)
        );
        #include <colorspace_fragment>
      }
    `,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    // Plan-oblique cartography keeps the connected water network readable
    // across intervening relief facets. Globe water still tests terrain depth.
    depthTest: !(projection === 'map' && style === 'relief'),
  });
  const object = new THREE.Group();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 2;
  object.add(mesh);

  if (projection === 'map') {
    projectMesh(geometry, WATER_LIFT.river, mapReliefScale(style));
    clipMapMaterial(material);
  }

  return {
    object,
    update: (time: number) => {
      material.uniforms.time.value = time;
    },
  };
}
