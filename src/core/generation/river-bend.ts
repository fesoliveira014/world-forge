import { clamp } from '../math';

type Point = [number, number];

/** A bounded migration sketch in valley coordinates. Growth depends on elapsed
 * landscape time and bank mobility. A geometric intersection cuts off a loop;
 * age alone never selects a river's pattern. Units are physical metres.
 */
export function evolveBend(
  length: number,
  space: number,
  duration: number,
  mobility: number,
  variation: number,
) {
  const growth =
    (1 - Math.exp(-duration / 0.4)) * clamp(mobility * (0.35 + variation * 0.65), 0, 1.3);
  const amplitude = Math.min(space * 0.65, length * 0.22, 20000) * Math.min(1, growth);
  const longitudinal =
    Math.min(length * (variation > 0.72 ? 0.19 : 0.1), amplitude * 3.5) * Math.min(1, growth);
  const sign = variation > 0.5 ? 1 : -1;
  const count = amplitude >= 100 ? 16 : Math.max(1, Math.ceil(length / 40000));
  let points: Point[] = [];

  for (let sampleIndex = 0; sampleIndex <= count; sampleIndex++) {
    const alongFraction = sampleIndex / count;
    points.push([
      length * alongFraction + longitudinal * Math.sin(4 * Math.PI * alongFraction),
      sign * amplitude * Math.sin(2 * Math.PI * alongFraction),
    ]);
  }

  points[0] = [0, 0];
  points[points.length - 1] = [length, 0];
  const loops: Point[][] = [];

  // Two lobes at most; no repeated global path search or recursive cutoffs.
  for (let cutoff = 0; cutoff < 2; cutoff++) {
    let found = false;

    for (let firstSegment = 0; firstSegment + 3 < points.length && !found; firstSegment++) {
      for (
        let secondSegment = firstSegment + 2;
        secondSegment + 1 < points.length;
        secondSegment++
      ) {
        const firstPoint = points[firstSegment];
        const secondPoint = points[secondSegment];
        const firstDirectionX = points[firstSegment + 1][0] - firstPoint[0];
        const firstDirectionY = points[firstSegment + 1][1] - firstPoint[1];
        const secondDirectionX = points[secondSegment + 1][0] - secondPoint[0];
        const secondDirectionY = points[secondSegment + 1][1] - secondPoint[1];
        const determinant = firstDirectionX * secondDirectionY - firstDirectionY * secondDirectionX;

        if (Math.abs(determinant) < 1e-6) {
          continue;
        }

        const firstFraction =
          ((secondPoint[0] - firstPoint[0]) * secondDirectionY -
            (secondPoint[1] - firstPoint[1]) * secondDirectionX) /
          determinant;
        const secondFraction =
          ((secondPoint[0] - firstPoint[0]) * firstDirectionY -
            (secondPoint[1] - firstPoint[1]) * firstDirectionX) /
          determinant;

        if (
          firstFraction <= 0 ||
          firstFraction >= 1 ||
          secondFraction <= 0 ||
          secondFraction >= 1
        ) {
          continue;
        }

        const neck: Point = [
          firstPoint[0] + firstDirectionX * firstFraction,
          firstPoint[1] + firstDirectionY * firstFraction,
        ];
        loops.push([neck, ...points.slice(firstSegment + 1, secondSegment + 1), neck]);
        points = [...points.slice(0, firstSegment + 1), neck, ...points.slice(secondSegment + 1)];
        found = true;
        break;
      }
    }

    if (!found) {
      break;
    }
  }

  return { points, loops };
}
