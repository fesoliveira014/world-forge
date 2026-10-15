/** Linear-sRGB color arithmetic, independent of the graphics adapter. */
export class LinearColor {
  r = 1;
  g = 1;
  b = 1;
  constructor(hex?: string) {
    if (hex) {
      this.set(hex);
    }
  }
  set(hex: string) {
    const value = Number.parseInt(hex.slice(1), 16);
    const linear = (value: number) =>
      value < 0.04045 ? value * 0.0773993808 : ((value + 0.055) * 0.9478672986) ** 2.4;
    this.r = linear(((value >> 16) & 255) / 255);
    this.g = linear(((value >> 8) & 255) / 255);
    this.b = linear((value & 255) / 255);
    return this;
  }
  copy(other: { r: number; g: number; b: number }) {
    this.r = other.r;
    this.g = other.g;
    this.b = other.b;
    return this;
  }
  lerp(other: { r: number; g: number; b: number }, fraction: number) {
    this.r += (other.r - this.r) * fraction;
    this.g += (other.g - this.g) * fraction;
    this.b += (other.b - this.b) * fraction;
    return this;
  }
  multiplyScalar(scale: number) {
    this.r *= scale;
    this.g *= scale;
    this.b *= scale;
    return this;
  }
  setHSL(h: number, s: number, l: number) {
    const p = l <= 0.5 ? l * (1 + s) : l + s - l * s;
    const q = 2 * l - p;
    const hue = (t: number) => {
      t = ((t % 1) + 1) % 1;
      return t < 1 / 6
        ? q + (p - q) * 6 * t
        : t < 0.5
          ? p
          : t < 2 / 3
            ? q + (p - q) * 6 * (2 / 3 - t)
            : q;
    };
    this.r = hue(h + 1 / 3);
    this.g = hue(h);
    this.b = hue(h - 1 / 3);
    return this;
  }
}
