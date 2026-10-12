export const clamp = (value: number, minimum = 0, maximum = 1) =>
  Math.max(minimum, Math.min(maximum, value));

export const lerp = (start: number, end: number, fraction: number) =>
  start + (end - start) * fraction;

export type Vec3 = [number, number, number];

export const dot = (left: ArrayLike<number>, right: ArrayLike<number>) =>
  left[0] * right[0] + left[1] * right[1] + left[2] * right[2];

export const cross = (left: ArrayLike<number>, right: ArrayLike<number>): Vec3 => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0],
];

export const normalizeVector = (vector: ArrayLike<number>): Vec3 => {
  const magnitude = Math.hypot(vector[0], vector[1], vector[2]);

  return [vector[0] / magnitude, vector[1] / magnitude, vector[2] / magnitude];
};

export const readVector = (buffer: ArrayLike<number>, vectorIndex: number): Vec3 => [
  buffer[3 * vectorIndex],
  buffer[3 * vectorIndex + 1],
  buffer[3 * vectorIndex + 2],
];

export const angle = (left: ArrayLike<number>, right: ArrayLike<number>) =>
  Math.acos(clamp(dot(left, right), -1, 1));

export const subtractVectors = (left: ArrayLike<number>, right: ArrayLike<number>): Vec3 => [
  left[0] - right[0],
  left[1] - right[1],
  left[2] - right[2],
];

export function hashSeed(text: string) {
  let hashValue = 2166136261;

  for (let characterIndex = 0; characterIndex < text.length; characterIndex++) {
    hashValue = Math.imul(hashValue ^ text.charCodeAt(characterIndex), 16777619);
  }

  return hashValue >>> 0;
}

/** Independent streams prevent a new subsystem from changing existing geography. */
export function createSeededRandom(seed: string) {
  let state = hashSeed(seed);

  return () => {
    state += 0x6d2b79f5;
    let mixedState = state;
    mixedState = Math.imul(mixedState ^ (mixedState >>> 15), mixedState | 1);
    mixedState ^= mixedState + Math.imul(mixedState ^ (mixedState >>> 7), mixedState | 61);

    return ((mixedState ^ (mixedState >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSpherePoint(randomNumber: () => number): Vec3 {
  const y = randomNumber() * 2 - 1;
  const longitude = randomNumber() * Math.PI * 2;
  const horizontalRadius = Math.sqrt(1 - y * y);

  return [horizontalRadius * Math.cos(longitude), y, horizontalRadius * Math.sin(longitude)];
}

const fade = (fraction: number) =>
  fraction * fraction * fraction * (fraction * (fraction * 6 - 15) + 10);

/** Continuous seeded 3D value noise: no UV seam or polar singularity. */
export function createNoise(seed: string) {
  const seedHash = hashSeed(seed);

  const latticeValue = (x: number, y: number, z: number) => {
    let mixedHash =
      Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ seedHash;
    mixedHash = Math.imul(mixedHash ^ (mixedHash >>> 13), 1274126177);

    return ((mixedHash ^ (mixedHash >>> 16)) >>> 0) / 2147483648 - 1;
  };

  return (x: number, y: number, z: number) => {
    const gridX = Math.floor(x);
    const gridY = Math.floor(y);
    const gridZ = Math.floor(z);
    const blendX = fade(x - gridX);
    const blendY = fade(y - gridY);
    const blendZ = fade(z - gridZ);

    return lerp(
      lerp(
        lerp(latticeValue(gridX, gridY, gridZ), latticeValue(gridX + 1, gridY, gridZ), blendX),
        lerp(
          latticeValue(gridX, gridY + 1, gridZ),
          latticeValue(gridX + 1, gridY + 1, gridZ),
          blendX,
        ),
        blendY,
      ),
      lerp(
        lerp(
          latticeValue(gridX, gridY, gridZ + 1),
          latticeValue(gridX + 1, gridY, gridZ + 1),
          blendX,
        ),
        lerp(
          latticeValue(gridX, gridY + 1, gridZ + 1),
          latticeValue(gridX + 1, gridY + 1, gridZ + 1),
          blendX,
        ),
        blendY,
      ),
      blendZ,
    );
  };
}

/** Small binary min-heap shared by distance envelopes and Priority-Flood. */
export class MinHeap {
  ids: number[] = [];
  keys: number[] = [];

  get size() {
    return this.ids.length;
  }

  push(id: number, key: number) {
    let heapIndex = this.ids.length;
    this.ids.push(id);
    this.keys.push(key);

    while (heapIndex) {
      const parentIndex = (heapIndex - 1) >> 1;

      if (this.keys[parentIndex] <= key) {
        break;
      }

      this.ids[heapIndex] = this.ids[parentIndex];
      this.keys[heapIndex] = this.keys[parentIndex];
      heapIndex = parentIndex;
    }

    this.ids[heapIndex] = id;
    this.keys[heapIndex] = key;
  }

  pop(): [number, number] {
    const id = this.ids[0];
    const key = this.keys[0];
    const lastId = this.ids.pop()!;
    const lastKey = this.keys.pop()!;

    if (this.ids.length) {
      let heapIndex = 0;

      while (heapIndex * 2 + 1 < this.ids.length) {
        let childIndex = heapIndex * 2 + 1;

        if (childIndex + 1 < this.ids.length && this.keys[childIndex + 1] < this.keys[childIndex]) {
          childIndex++;
        }

        if (this.keys[childIndex] >= lastKey) {
          break;
        }

        this.ids[heapIndex] = this.ids[childIndex];
        this.keys[heapIndex] = this.keys[childIndex];
        heapIndex = childIndex;
      }

      this.ids[heapIndex] = lastId;
      this.keys[heapIndex] = lastKey;
    }

    return [id, key];
  }
}
