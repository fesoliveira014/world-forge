import * as THREE from 'three';

export type Projection = 'globe' | 'map';

export const MAP_WIDTH = 2 * Math.PI;

export const MAP_HEIGHT = Math.PI;

/** Plan-oblique shear: sea level stays north-up; height rises toward map north. */
export const MAP_HEIGHT_SHEAR = 0.8;

/** Plate carrée: x is longitude and y is latitude, both in radians. */
export function mapPoint(x: number, y: number, z: number): [number, number] {
  return [Math.atan2(z, x), Math.atan2(y, Math.hypot(x, z))];
}

export function spherePoint(longitude: number, latitude: number, target: THREE.Vector3) {
  const horizontalRadius = Math.cos(latitude);

  return target.set(
    horizontalRadius * Math.cos(longitude),
    Math.sin(latitude),
    horizontalRadius * Math.sin(longitude),
  );
}

type MapVertex = { sources: number[]; weights: number[]; x: number; y: number };

type MapCopies = { first: number; vertices: MapVertex[] };

/** Refresh only seam/pole duplicates after a seasonal field or palette changes. */
export function updateMapAttributes(geometry: THREE.BufferGeometry, names: string[]) {
  const copies = geometry.userData.mapCopies as MapCopies | undefined;

  if (!copies) {
    return;
  }

  for (const name of names) {
    const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;

    for (let vertexIndex = 0; vertexIndex < copies.vertices.length; vertexIndex++) {
      const createMapVertex = copies.vertices[vertexIndex];

      for (let componentIndex = 0; componentIndex < attribute.itemSize; componentIndex++) {
        let value = 0;

        for (let sourceIndex = 0; sourceIndex < createMapVertex.sources.length; sourceIndex++) {
          value +=
            attribute.getComponent(createMapVertex.sources[sourceIndex], componentIndex) *
            createMapVertex.weights[sourceIndex];
        }

        attribute.setComponent(copies.first + vertexIndex, componentIndex, value);
      }
    }

    attribute.needsUpdate = true;
  }
}

/** Flatten an indexed spherical mesh in place. Ordinary vertices stay indexed; only
 * triangles at the cut and the two poles gain vertices. All field attributes survive.
 * Seam copies extend past the frame and are clipped by the material, not stretched
 * across the map. A pole is a whole top/bottom edge, so its incident sector is a quad.
 */
export function projectMesh(geometry: THREE.BufferGeometry, depth = 0, heightScale = 0) {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const index = geometry.getIndex()!;
  const count = position.count;
  if (heightScale > 0) {
    const heights = new Float32Array(count);
    for (let vertexIndex = 0; vertexIndex < count; vertexIndex++) {
      heights[vertexIndex] =
        Math.max(
          0,
          Math.hypot(
            position.getX(vertexIndex),
            position.getY(vertexIndex),
            position.getZ(vertexIndex),
          ) -
            1 -
            depth,
        ) * heightScale;
    }
    geometry.setAttribute('mapHeight', new THREE.BufferAttribute(heights, 1));
  }
  const longitude = new Float64Array(count);
  const latitude = new Float64Array(count);

  for (let vertexIndex = 0; vertexIndex < count; vertexIndex++) {
    [longitude[vertexIndex], latitude[vertexIndex]] = mapPoint(
      position.getX(vertexIndex),
      position.getY(vertexIndex),
      position.getZ(vertexIndex),
    );
  }

  const extra: MapVertex[] = [];
  const appended: number[] = [];
  const indices = new Uint32Array(index.array);

  const createMapVertex = (
    vertexIndex: number,
    x = longitude[vertexIndex],
    y = latitude[vertexIndex],
  ): MapVertex => ({
    sources: [vertexIndex],
    weights: [1],
    x,
    y,
  });

  const appendMapVertex = (mapVertex: MapVertex, shift = 0) => {
    extra.push({ ...mapVertex, x: mapVertex.x + shift });

    return count + extra.length - 1;
  };

  const appendTriangle = (
    firstVertex: MapVertex,
    secondVertex: MapVertex,
    thirdVertex: MapVertex,
  ) => {
    const minLongitude = Math.min(firstVertex.x, secondVertex.x, thirdVertex.x);
    const maxLongitude = Math.max(firstVertex.x, secondVertex.x, thirdVertex.x);
    appended.push(
      appendMapVertex(firstVertex),
      appendMapVertex(secondVertex),
      appendMapVertex(thirdVertex),
    );

    if (minLongitude < -Math.PI || maxLongitude > Math.PI) {
      const shift = minLongitude < -Math.PI ? MAP_WIDTH : -MAP_WIDTH;
      appended.push(
        appendMapVertex(firstVertex, shift),
        appendMapVertex(secondVertex, shift),
        appendMapVertex(thirdVertex, shift),
      );
    }
  };

  const unwrapLongitude = (longitude: number, anchor: number) =>
    longitude + Math.round((anchor - longitude) / MAP_WIDTH) * MAP_WIDTH;

  for (let triangleOffset = 0; triangleOffset < indices.length; triangleOffset += 3) {
    const firstIndex = index.getX(triangleOffset);
    const secondIndex = index.getX(triangleOffset + 1);
    const thirdIndex = index.getX(triangleOffset + 2);
    const firstLongitude = longitude[firstIndex];
    const secondLongitude = longitude[secondIndex];
    const thirdLongitude = longitude[thirdIndex];

    if (
      Math.max(firstLongitude, secondLongitude, thirdLongitude) -
        Math.min(firstLongitude, secondLongitude, thirdLongitude) <=
        Math.PI &&
      Math.max(
        Math.abs(latitude[firstIndex]),
        Math.abs(latitude[secondIndex]),
        Math.abs(latitude[thirdIndex]),
      ) <
        Math.PI / 2 - 1e-7
    ) {
      continue;
    }

    const triangleIndices = [firstIndex, secondIndex, thirdIndex];
    const triangleLongitudes = [firstLongitude, secondLongitude, thirdLongitude];
    const pole = triangleIndices.findIndex(
      (vertexIndex) => Math.abs(latitude[vertexIndex]) > Math.PI / 2 - 1e-7,
    );

    if (pole < 0 && Math.max(...triangleLongitudes) - Math.min(...triangleLongitudes) <= Math.PI) {
      continue;
    }

    // Replace this one face with locally unwrapped faces. Degenerate original is invisible.
    indices[triangleOffset + 1] = indices[triangleOffset + 2] = indices[triangleOffset];
    const unwrapped = triangleLongitudes.map((longitude) =>
      unwrapLongitude(longitude, triangleLongitudes[0]),
    );

    if (pole < 0 && Math.max(...unwrapped) - Math.min(...unwrapped) <= Math.PI) {
      appendTriangle(
        ...(triangleIndices.map((vertexIndex, triangleVertexIndex) =>
          createMapVertex(vertexIndex, unwrapped[triangleVertexIndex]),
        ) as [MapVertex, MapVertex, MapVertex]),
      );
      continue;
    }

    // The jittered grid may put the pole inside a face instead of at a vertex.
    // Intersect its x/z triangle with the polar axis for interpolated field values.
    let poleVertex: MapVertex;

    if (pole >= 0) {
      poleVertex = createMapVertex(triangleIndices[pole]);
    } else {
      const [firstIndex, secondIndex, thirdIndex] = triangleIndices;
      const ax = position.getX(firstIndex);
      const az = position.getZ(firstIndex);
      const bx = position.getX(secondIndex);
      const bz = position.getZ(secondIndex);
      const cx = position.getX(thirdIndex);
      const cz = position.getZ(thirdIndex);
      const determinant = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      const firstWeight = ((bz - cz) * -cx + (cx - bx) * -cz) / determinant;
      const secondWeight = ((cz - az) * -cx + (ax - cx) * -cz) / determinant;
      poleVertex = {
        sources: triangleIndices,
        weights: [firstWeight, secondWeight, 1 - firstWeight - secondWeight],
        x: 0,
        y:
          (Math.sign(latitude[firstIndex] + latitude[secondIndex] + latitude[thirdIndex]) *
            Math.PI) /
          2,
      };
    }

    for (let triangleVertexIndex = 0; triangleVertexIndex < 3; triangleVertexIndex++) {
      if (pole === triangleVertexIndex || pole === (triangleVertexIndex + 1) % 3) {
        continue;
      }

      const startVertex = createMapVertex(triangleIndices[triangleVertexIndex]);
      const endVertex = createMapVertex(
        triangleIndices[(triangleVertexIndex + 1) % 3],
        unwrapLongitude(triangleLongitudes[(triangleVertexIndex + 1) % 3], startVertex.x),
      );
      const topA = { ...poleVertex, x: startVertex.x };
      const topB = { ...poleVertex, x: endVertex.x };
      appendTriangle(startVertex, endVertex, topB);
      appendTriangle(startVertex, topB, topA);
    }
  }

  if (geometry.hasAttribute('surfaceTerrain')) {
    geometry.setAttribute('spherePosition', position.clone());
  }

  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const expanded = new Float32Array((count + extra.length) * attribute.itemSize);
    expanded.set(attribute.array);
    geometry.setAttribute(name, new THREE.BufferAttribute(expanded, attribute.itemSize));
  }

  geometry.userData.mapCopies = { first: count, vertices: extra } satisfies MapCopies;
  updateMapAttributes(geometry, Object.keys(geometry.attributes));
  const mapped = geometry.getAttribute('position') as THREE.BufferAttribute;

  for (let vertexIndex = 0; vertexIndex < count; vertexIndex++) {
    mapped.setXYZ(vertexIndex, longitude[vertexIndex], latitude[vertexIndex], depth);
  }

  for (let triangleVertexIndex = 0; triangleVertexIndex < extra.length; triangleVertexIndex++) {
    mapped.setXYZ(
      count + triangleVertexIndex,
      extra[triangleVertexIndex].x,
      extra[triangleVertexIndex].y,
      depth,
    );
  }

  if (heightScale > 0) {
    const heights = geometry.getAttribute('mapHeight');
    for (let vertexIndex = 0; vertexIndex < mapped.count; vertexIndex++) {
      const height = heights.getX(vertexIndex);
      mapped.setY(vertexIndex, mapped.getY(vertexIndex) + height * MAP_HEIGHT_SHEAR);
      mapped.setZ(vertexIndex, depth + height);
    }
    geometry.deleteAttribute('mapHeight');
  }

  const combined = new Uint32Array(indices.length + appended.length);
  combined.set(indices);
  combined.set(appended, indices.length);
  geometry.setIndex(new THREE.BufferAttribute(combined, 1));
  if (heightScale > 0) {
    geometry.computeVertexNormals();
  }
  geometry.computeBoundingSphere();
  // The drift preview is globe-only. Do not retain a second large dual position buffer.
  delete geometry.userData.base;
}

/** Clip the duplicate seam triangles to the rectangular map. Works with the existing
 * basic palettes and custom natural/river shaders; no extra render target is needed. */
export function clipMapMaterial(material: THREE.Material) {
  material.side = THREE.DoubleSide;

  const patch = (shader: { vertexShader: string; fragmentShader: string }) => {
    shader.vertexShader =
      'varying float mapLongitude;\n' +
      shader.vertexShader.replace(/void main\s*\(\s*\)\s*\{/, '$&\nmapLongitude = position.x;');
    shader.fragmentShader =
      'varying float mapLongitude;\n' +
      shader.fragmentShader.replace(
        /void main\s*\(\s*\)\s*\{/,
        '$&\nif (abs(mapLongitude) > 3.14159265359) discard;',
      );
  };

  if (material instanceof THREE.ShaderMaterial) {
    patch(material);
  } else {
    const previous = material.onBeforeCompile;
    const key = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer);
      patch(shader);
    };
    material.customProgramCacheKey = () => `${key}:plate-carree-clip`;
  }
}

/** Four vertices per segment: two pieces at the seam, or one piece and a degenerate.
 * Flow tracers use this bounded output directly, retaining spherical advection history. */
export function writeMapSegment(
  source: ArrayLike<number>,
  startOffset: number,
  endOffset: number,
  output: Float32Array,
  offset: number,
  depth: number,
  heightScale = 0,
  radialLift = depth,
) {
  const [startLongitude, startLatitude] = mapPoint(
    source[startOffset],
    source[startOffset + 1],
    source[startOffset + 2],
  );
  const [endLongitude, endLatitude] = mapPoint(
    source[endOffset],
    source[endOffset + 1],
    source[endOffset + 2],
  );
  let endX = endLongitude;
  let endY = endLatitude;
  let startX = endLongitude;
  let startY = endLatitude;

  if (Math.abs(endLongitude - startLongitude) > Math.PI) {
    const unwrapped = endLongitude + (startLongitude > 0 ? MAP_WIDTH : -MAP_WIDTH);
    endX = startLongitude > 0 ? Math.PI : -Math.PI;
    endY =
      startLatitude +
      ((endLatitude - startLatitude) * (endX - startLongitude)) / (unwrapped - startLongitude);
    startX = -endX;
    startY = endY;
  }

  output[offset] = startLongitude;
  output[offset + 1] = startLatitude;
  output[offset + 2] = depth;
  output[offset + 3] = endX;
  output[offset + 4] = endY;
  output[offset + 5] = depth;
  output[offset + 6] = startX;
  output[offset + 7] = startY;
  output[offset + 8] = depth;
  output[offset + 9] = endLongitude;
  output[offset + 10] = endLatitude;
  output[offset + 11] = depth;

  if (heightScale > 0) {
    const startHeight =
      Math.max(
        0,
        Math.hypot(source[startOffset], source[startOffset + 1], source[startOffset + 2]) -
          1 -
          radialLift,
      ) * heightScale;
    const endHeight =
      Math.max(
        0,
        Math.hypot(source[endOffset], source[endOffset + 1], source[endOffset + 2]) -
          1 -
          radialLift,
      ) * heightScale;
    let seamHeight = endHeight;
    if (Math.abs(endLongitude - startLongitude) > Math.PI) {
      const unwrapped = endLongitude + (startLongitude > 0 ? MAP_WIDTH : -MAP_WIDTH);
      seamHeight =
        startHeight +
        ((endHeight - startHeight) * (endX - startLongitude)) / (unwrapped - startLongitude);
    }
    const heights = [startHeight, seamHeight, seamHeight, endHeight];
    for (let vertexIndex = 0; vertexIndex < 4; vertexIndex++) {
      output[offset + vertexIndex * 3 + 1] += heights[vertexIndex] * MAP_HEIGHT_SHEAR;
      output[offset + vertexIndex * 3 + 2] += heights[vertexIndex];
    }
  }
}

export function projectLines(
  geometry: THREE.BufferGeometry,
  depth = 0.004,
  heightScale = 0,
  radialLift = depth,
) {
  const source = geometry.getAttribute('position');
  const positions = new Float32Array(source.count * 6);

  for (let segmentIndex = 0; segmentIndex < source.count; segmentIndex += 2) {
    writeMapSegment(
      source.array,
      segmentIndex * 3,
      (segmentIndex + 1) * 3,
      positions,
      segmentIndex * 6,
      depth,
      heightScale,
      radialLift,
    );
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const color = geometry.getAttribute('color');

  if (color) {
    const colors = new Float32Array(color.count * 6);

    for (let segmentIndex = 0; segmentIndex < color.count; segmentIndex += 2) {
      for (let vertexIndex = 0; vertexIndex < 4; vertexIndex++) {
        for (let componentIndex = 0; componentIndex < 3; componentIndex++) {
          colors[(segmentIndex * 2 + vertexIndex) * 3 + componentIndex] = color.getComponent(
            segmentIndex + (vertexIndex % 2),
            componentIndex,
          );
        }
      }
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  geometry.computeBoundingSphere();
}
