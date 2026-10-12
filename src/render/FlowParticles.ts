import * as THREE from 'three';
import type { World } from '../core/model';
import { nearestCell } from '../core/grid/build';
import { createSeededRandom } from '../core/math';
import { writeMapSegment, type Projection } from './projection';

const TAIL = 22;

const TICK = 1 / 20;

/** A bounded pool of tracers advected through the displayed seasonal field.
 * Cached graph walks provide spherical nearest-neighbor lookup; no global spatial scans per frame.
 * Trails are one dynamic draw call. Respawning clears history, so coast/calm resets never draw jumps.
 */
export class FlowParticles {
  readonly object: THREE.LineSegments;
  private readonly field: Float32Array;
  private readonly history: Float32Array;
  private readonly positions: Float32Array;
  private readonly cells: Int32Array;
  private readonly surfaceCells: Int32Array;
  private readonly age: Float32Array;
  private readonly randomNumber: () => number;
  private readonly point = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly candidate = new THREE.Vector3();
  private readonly probe = new THREE.Vector3();
  private accumulator = 0;
  private hasFlow = false;

  constructor(
    private readonly world: World,
    private readonly kind: 'wind' | 'current',
    season: number,
    private readonly count: number,
    private readonly relief: number,
    private readonly projection: Projection = 'globe',
  ) {
    this.randomNumber = createSeededRandom(world.config.seed + `/tracers/${kind}/${season}`);
    this.field = new Float32Array(world.process.count * 3);

    for (let seasonIndex = 0; seasonIndex < 4; seasonIndex++) {
      if (season < 0 || season === seasonIndex) {
        const seasonField = world.climate[kind][seasonIndex];

        for (let componentIndex = 0; componentIndex < seasonField.length; componentIndex++) {
          this.field[componentIndex] += seasonField[componentIndex] * (season < 0 ? 0.25 : 1);
        }
      }
    }

    this.history = new Float32Array(count * TAIL * 3);
    const pieces = projection === 'map' ? 2 : 1;
    this.positions = new Float32Array(count * (TAIL - 1) * 6 * pieces);
    this.cells = new Int32Array(count);
    this.surfaceCells = new Int32Array(count);
    this.age = new Float32Array(count);
    const fade = new Float32Array(count * (TAIL - 1) * 2 * pieces);

    for (let particleIndex = 0; particleIndex < count; particleIndex++) {
      for (let tailIndex = 0; tailIndex < TAIL - 1; tailIndex++) {
        const segmentOffset = (particleIndex * (TAIL - 1) + tailIndex) * 2 * pieces;

        for (let pieceIndex = 0; pieceIndex < pieces; pieceIndex++) {
          fade[segmentOffset + pieceIndex * 2] = Math.pow(1 - tailIndex / (TAIL - 1), 1.4);
          fade[segmentOffset + pieceIndex * 2 + 1] = Math.pow(
            1 - (tailIndex + 1) / (TAIL - 1),
            1.4,
          );
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute('fade', new THREE.BufferAttribute(fade, 1));
    this.object = new THREE.LineSegments(
      geometry,
      new THREE.ShaderMaterial({
        uniforms: { tint: { value: new THREE.Color(kind === 'wind' ? '#fff2ca' : '#95f4ee') } },
        vertexShader: /* glsl */ `
          attribute float fade;
          varying float opacity;

          void main() {
            opacity = fade;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 tint;
          varying float opacity;

          void main() {
            gl_FragColor = vec4(tint, opacity * 0.92);
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.object.frustumCulled = false;
    this.hasFlow = this.field.some(
      (component) => Math.abs(component) > (kind === 'wind' ? 0.08 : 0.0006),
    );

    if (!this.hasFlow) {
      return;
    }

    for (let particleIndex = 0; particleIndex < count; particleIndex++) {
      this.spawnParticle(particleIndex);
      this.age[particleIndex] = this.randomNumber() * 9;
    }

    // Populate short paths immediately, including for users who prefer reduced motion.
    for (let tailIndex = 0; tailIndex < TAIL; tailIndex++) {
      this.advanceParticles(TICK);
    }
  }

  private sampleVelocity(particleIndex: number, position: THREE.Vector3): number {
    const grid = this.world.process;
    const processCell = nearestCell(
      grid,
      position.x,
      position.y,
      position.z,
      this.cells[particleIndex],
    );
    this.cells[particleIndex] = processCell;
    let x = 0;
    let y = 0;
    let z = 0;
    let weight = 0;

    const accumulateSample = (neighborCell: number) => {
      const angularOffset = Math.max(
        1e-7,
        1 -
          (position.x * grid.positions[neighborCell * 3] +
            position.y * grid.positions[neighborCell * 3 + 1] +
            position.z * grid.positions[neighborCell * 3 + 2]),
      );
      const sampleWeight = 1 / angularOffset;
      weight += sampleWeight;
      x += this.field[neighborCell * 3] * sampleWeight;
      y += this.field[neighborCell * 3 + 1] * sampleWeight;
      z += this.field[neighborCell * 3 + 2] * sampleWeight;
    };

    accumulateSample(processCell);

    for (
      let neighborOffset = grid.offsets[processCell];
      neighborOffset < grid.offsets[processCell + 1];
      neighborOffset++
    ) {
      accumulateSample(grid.neighbors[neighborOffset]);
    }

    this.velocity.set(x / weight, y / weight, z / weight);
    this.velocity.addScaledVector(position, -this.velocity.dot(position));

    return this.velocity.length();
  }

  private spawnParticle(particleIndex: number) {
    const grid = this.world.process;
    let okay = false;

    for (let trial = 0; trial < 50; trial++) {
      const processCell = Math.floor(this.randomNumber() * grid.count);
      this.cells[particleIndex] = processCell;
      this.point.fromArray(grid.positions, processCell * 3);
      const surfaceCell = nearestCell(
        this.world.grid,
        this.point.x,
        this.point.y,
        this.point.z,
        this.surfaceCells[particleIndex],
      );
      this.surfaceCells[particleIndex] = surfaceCell;

      if (this.kind === 'current' && !this.world.terrain.ocean[surfaceCell]) {
        continue;
      }

      if (this.sampleVelocity(particleIndex, this.point) < (this.kind === 'wind' ? 0.1 : 0.001)) {
        continue;
      }

      okay = true;
      break;
    }

    this.age[particleIndex] = okay ? 0 : 100;
    const surfaceCell = this.surfaceCells[particleIndex];
    const displayRadius =
      1 +
      (Math.max(0, this.world.terrain.height[surfaceCell]) / this.world.config.radius) *
        this.relief +
      0.012;
    this.point.multiplyScalar(displayRadius);

    // A zero-length path remains invisible when there is no nonzero current (strength = 0).
    for (let tailIndex = 0; tailIndex < TAIL; tailIndex++) {
      this.point.toArray(this.history, (particleIndex * TAIL + tailIndex) * 3);
    }
  }

  update(delta: number, speed: number) {
    if (!this.hasFlow) {
      return;
    }

    this.accumulator += Math.min(0.05, delta) * speed;

    while (this.accumulator >= TICK) {
      this.advanceParticles(TICK);
      this.accumulator -= TICK;
    }
  }

  private advanceParticles(timeStep: number) {
    const world = this.world;
    const timeScale = this.kind === 'wind' ? 140000 : 5000000;

    for (let particleIndex = 0; particleIndex < this.count; particleIndex++) {
      const offset = particleIndex * TAIL * 3;

      if (this.age[particleIndex] > 9) {
        this.spawnParticle(particleIndex);
        continue;
      }

      this.point.fromArray(this.history, offset).normalize();
      const speed = this.sampleVelocity(particleIndex, this.point);

      if (speed < (this.kind === 'wind' ? 0.08 : 0.0006)) {
        this.spawnParticle(particleIndex);
        continue;
      }

      // Bound the angular step so a tracer cannot jump over resolved coast cells.
      const angularTimeStep = Math.min((timeStep * timeScale) / world.config.radius, 0.006 / speed);
      this.candidate.copy(this.point).addScaledVector(this.velocity, angularTimeStep).normalize();
      const cell = nearestCell(
        world.grid,
        this.candidate.x,
        this.candidate.y,
        this.candidate.z,
        this.surfaceCells[particleIndex],
      );
      let blocked = this.kind === 'current' && !world.terrain.ocean[cell];

      if (this.kind === 'current' && !blocked) {
        let probeCell = this.surfaceCells[particleIndex];

        for (let tailIndex = 1; tailIndex <= 3; tailIndex++) {
          this.probe
            .copy(this.point)
            .lerp(this.candidate, tailIndex / 4)
            .normalize();
          probeCell = nearestCell(world.grid, this.probe.x, this.probe.y, this.probe.z, probeCell);

          if (!world.terrain.ocean[probeCell]) {
            blocked = true;
            break;
          }
        }
      }

      if (blocked) {
        this.spawnParticle(particleIndex);
        continue;
      }

      this.surfaceCells[particleIndex] = cell;
      this.history.copyWithin(offset + 3, offset, offset + (TAIL - 1) * 3);
      const displayRadius =
        1 +
        (Math.max(0, world.terrain.height[cell]) / this.world.config.radius) * this.relief +
        0.012;
      this.candidate.multiplyScalar(displayRadius).toArray(this.history, offset);
      this.age[particleIndex] += timeStep;
    }

    for (let particleIndex = 0; particleIndex < this.count; particleIndex++) {
      for (let tailIndex = 0; tailIndex < TAIL - 1; tailIndex++) {
        const historyOffset = (particleIndex * TAIL + tailIndex) * 3;
        const vertexOffset = (particleIndex * (TAIL - 1) + tailIndex) * 6;

        if (this.projection === 'map') {
          writeMapSegment(
            this.history,
            historyOffset,
            historyOffset + 3,
            this.positions,
            vertexOffset * 2,
            0.012,
          );
        } else {
          for (let axisIndex = 0; axisIndex < 6; axisIndex++) {
            this.positions[vertexOffset + axisIndex] = this.history[historyOffset + axisIndex];
          }
        }
      }
    }

    (this.object.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}
