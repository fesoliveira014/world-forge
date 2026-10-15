import * as THREE from 'three';
import { FANTASY_PALETTES, type FantasyMapStyle, type FantasyPalette } from './FantasyStyle';

export const FANTASY_ATLAS_COLUMNS = 4;
export const FANTASY_ATLAS_ROWS = 4;
export const FANTASY_ATLAS_TILE_SIZE = 256;
/** Canvas is top-down; texture UVs are bottom-up. All glyph feet share this point. */
export const FANTASY_SYMBOL_ANCHOR = [0.5, 24 / FANTASY_ATLAS_TILE_SIZE] as const;
export const FANTASY_SYMBOL_GROUPS = {
  mountains: [0, 1, 2, 3],
  hills: [4, 5],
  conifers: [6, 7, 8, 9],
  broadleaf: [10, 11, 12, 13],
  marsh: [14, 15],
} as const;
/** Placement chooses an upright glyph by its role along a geographic range. */
export const FANTASY_MOUNTAIN_SINGLE_TILES = [0] as const;
export const FANTASY_MOUNTAIN_PAIR_TILES = [1] as const;
export const FANTASY_MOUNTAIN_RIDGE_TILES = [2, 3] as const;
/** Visible ink (alpha >= 0.25), measured across all three styles. Geographic
 * chain spacing uses these fractions of the quad, excluding transparent padding. */
export const FANTASY_MOUNTAIN_INK_FOOTPRINTS = [
  { width: 178 / 256, height: 186 / 256 },
  { width: 204 / 256, height: 189 / 256 },
  { width: 204 / 256, height: 176 / 256 },
  { width: 205 / 256, height: 159 / 256 },
] as const;

interface Brush {
  style: FantasyMapStyle;
  palette: FantasyPalette;
  random: () => number;
}
type Point = readonly [number, number];

function seeded(seed: number) {
  let state = seed | 0;
  return () => {
    state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
    state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
    state = state ^ (state >>> 16);
    return (state >>> 0) / 4294967296;
  };
}
function path(context: CanvasRenderingContext2D, points: readonly Point[], close = false) {
  context.beginPath();
  context.moveTo(...points[0]);
  for (let i = 1; i < points.length; i++) {
    context.lineTo(...points[i]);
  }
  if (close) {
    context.closePath();
  }
}
function polygon(
  context: CanvasRenderingContext2D,
  points: readonly Point[],
  color: string,
  opacity = 1,
) {
  context.globalAlpha = opacity;
  context.fillStyle = color;
  path(context, points, true);
  context.fill();
  context.globalAlpha = 1;
}
function line(
  context: CanvasRenderingContext2D,
  points: readonly Point[],
  color: string,
  width = 1,
  opacity = 1,
) {
  context.strokeStyle = color;
  context.lineWidth = width;
  context.globalAlpha = opacity;
  path(context, points);
  context.stroke();
  context.globalAlpha = 1;
}

/** Shaded-side strokes widen away from the summit. Clipping keeps hatchwork in
 * its face rather than drawing a repeated crosshatch texture over the icon. */
function mountain(
  context: CanvasRenderingContext2D,
  brush: Brush,
  x: number,
  base: number,
  width: number,
  height: number,
) {
  const { palette, style, random } = brush;
  const painted = style === 'painted';
  const engraved = style === 'engraved';
  const left = x - width * 0.53;
  const right = x + width * 0.5;
  const top = base - height;
  const peak: Point = [x - width * 0.035, top];
  const ridge: Point[] = [
    peak,
    [x + width * 0.04, top + height * 0.24],
    [x - width * 0.02, top + height * 0.41],
    [x + width * 0.14, top + height * 0.65],
    [x + width * 0.055, base - height * 0.08],
  ];
  const silhouette: Point[] = [
    [left, base],
    [left + width * 0.12, base - height * 0.29],
    [x - width * 0.19, top + height * 0.32],
    [x - width * 0.14, top + height * 0.34],
    peak,
    [x + width * 0.16, top + height * 0.34],
    [x + width * 0.22, top + height * 0.3],
    [right - width * 0.08, base - height * 0.22],
    [right, base],
    [x + width * 0.1, base + 2],
    [x - width * 0.25, base - 1],
  ];
  polygon(context, silhouette, painted ? palette.rock : palette.paper, engraved ? 0.93 : 0.98);
  const shadow: Point[] = [
    ...ridge,
    [right, base],
    [right - width * 0.08, base - height * 0.22],
    [x + width * 0.22, top + height * 0.3],
    [x + width * 0.16, top + height * 0.34],
  ];
  polygon(context, shadow, palette.mountainShadow, painted ? 0.84 : engraved ? 0.1 : 0.24);
  if (painted) {
    polygon(
      context,
      [
        peak,
        [x - width * 0.18, top + height * 0.4],
        [x - width * 0.12, base - height * 0.11],
        [left, base],
      ],
      '#c6b99b',
      0.6,
    );
    polygon(
      context,
      [
        ridge[2],
        [x + width * 0.28, base - height * 0.08],
        [right, base],
        [x + width * 0.22, top + height * 0.3],
      ],
      '#4f6766',
      0.35,
    );
    // Broken translucent strokes give facets a brushed rather than flat-vector edge.
    context.save();
    path(context, silhouette, true);
    context.clip();
    for (let stroke = 0; stroke < 22; stroke++) {
      const y = top + height * (0.25 + random() * 0.76);
      const at = x + (random() - 0.5) * width;
      line(
        context,
        [
          [at, y],
          [at + 2 + random() * 10, y - 2 - random() * 5],
        ],
        random() > 0.5 ? palette.snow : palette.mountainShadow,
        1 + random() * 2.2,
        0.1,
      );
    }
    context.restore();
  } else {
    context.save();
    path(context, shadow, true);
    context.clip();
    const spacing = engraved ? 4 : 7;
    for (let y = top + height * 0.13; y < base + 4; y += spacing) {
      const t = (y - top) / height;
      const startX = x + width * (0.02 + 0.07 * Math.sin(t * 7));
      line(
        context,
        [
          [startX, y],
          [startX + width * (0.1 + t * 0.39), y + height * 0.12],
        ],
        palette.ink,
        engraved ? 0.82 : 1.02,
        engraved ? 0.7 : 0.42,
      );
    }
    if (engraved) {
      for (let i = 0; i < 9; i++) {
        const t = 0.14 + i * 0.1;
        line(
          context,
          [
            [x + t * width * 0.3, top + height * 0.22],
            [x + width * (0.13 + t * 0.5), base + 2],
          ],
          palette.ink,
          0.6,
          0.28,
        );
      }
    }
    context.restore();
  }
  if (height > 85) {
    // Irregular snow line follows ridges; its dark fissures retain the summit's form.
    polygon(
      context,
      [
        peak,
        [x + width * 0.09, top + height * 0.2],
        [x + width * 0.055, top + height * 0.185],
        [x + width * 0.06, top + height * 0.29],
        [x - width * 0.015, top + height * 0.23],
        [x - width * 0.105, top + height * 0.3],
        [x - width * 0.08, top + height * 0.17],
        [x - width * 0.15, top + height * 0.29],
      ],
      palette.snow,
      painted ? 0.97 : 0.76,
    );
  }
  context.strokeStyle = palette.ink;
  context.lineWidth = painted ? 1.25 : engraved ? 1.4 : 1.9;
  context.globalAlpha = painted ? 0.62 : 0.94;
  // Leave the foothill open: a closed horizontal base makes a peak read as a
  // cut-out pyramid, particularly when several peaks overlap along a range.
  path(context, silhouette.slice(0, 9));
  context.stroke();
  context.globalAlpha = 1;
  line(context, ridge, palette.ink, engraved ? 1.05 : 1.35, painted ? 0.45 : 0.68);
  // Contour shoulders connect one peak's descending ridge to the next foothill.
  for (let i = 0; i < (engraved ? 4 : 2); i++) {
    const y = base - 5 - i * 6;
    context.beginPath();
    context.moveTo(left + 5 + i * 3, y);
    context.quadraticCurveTo(x - width * 0.23, y - 7 - i * 2, x - width * 0.035, y - 2);
    context.strokeStyle = palette.ink;
    context.lineWidth = 0.7;
    context.globalAlpha = painted ? 0.14 : 0.36;
    context.stroke();
  }
  context.globalAlpha = 1;
}

function mountainGroup(context: CanvasRenderingContext2D, brush: Brush, variant: number) {
  const configurations = [
    // An isolated summit and a lopsided pair let ranges taper without repeating
    // the same three-peak stamp at every geographic anchor.
    [[128, 230, 172, 181]],
    [
      [84, 227, 112, 126],
      [158, 230, 137, 184],
    ],
    // Overlapping foothills form one connected ridge, with opposite summit
    // rhythms for neighboring range interiors. Peaks remain upright.
    [
      [67, 223, 79, 98],
      [122, 229, 113, 170],
      [191, 229, 74, 111],
    ],
    [
      [78, 229, 99, 153],
      [139, 227, 105, 125],
      [198, 231, 63, 91],
    ],
  ];
  for (const [x, base, width, height] of configurations[variant]) {
    mountain(
      context,
      brush,
      x + (brush.random() - 0.5) * 3,
      base,
      width,
      height * (brush.style === 'engraved' ? 1.02 : brush.style === 'painted' ? 0.96 : 1),
    );
  }
  // The shared foot blends into underlying terrain and neighboring ridges.
  // This alpha-only mask is confined to the current atlas tile by its guard
  // clip; no rectangular background or neighboring glyph can be affected.
  context.save();
  context.globalCompositeOperation = 'destination-in';
  const fade = context.createLinearGradient(0, brush.style === 'painted' ? 188 : 211, 0, 235);
  fade.addColorStop(0, 'rgba(0, 0, 0, 1)');
  fade.addColorStop(0.55, 'rgba(0, 0, 0, 0.7)');
  fade.addColorStop(1, 'rgba(0, 0, 0, 0)');
  context.fillStyle = fade;
  context.fillRect(20, 20, 216, 216);
  context.restore();
}

function hill(
  context: CanvasRenderingContext2D,
  brush: Brush,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const { palette, style } = brush;
  context.beginPath();
  context.moveTo(x - width / 2, y);
  context.bezierCurveTo(
    x - width * 0.31,
    y - height * 0.12,
    x - width * 0.22,
    y - height,
    x,
    y - height,
  );
  context.bezierCurveTo(
    x + width * 0.2,
    y - height,
    x + width * 0.36,
    y - height * 0.13,
    x + width / 2,
    y,
  );
  context.quadraticCurveTo(x, y + 4, x - width / 2, y);
  context.fillStyle = style === 'painted' ? palette.meadow : palette.paper;
  context.fill();
  context.save();
  context.clip();
  if (style === 'painted') {
    polygon(
      context,
      [
        [x, y - height],
        [x + width / 2, y],
        [x - width * 0.04, y - 2],
      ],
      palette.forest,
      0.28,
    );
  } else {
    const count = style === 'engraved' ? 8 : 4;
    for (let i = 0; i < count; i++) {
      line(
        context,
        [
          [x + i * width * 0.04, y - height + i * 4 + 3],
          [x + i * width * 0.04 + width * 0.22, y + 4],
        ],
        palette.ink,
        0.8,
        style === 'engraved' ? 0.48 : 0.25,
      );
    }
  }
  context.restore();
  context.beginPath();
  context.moveTo(x - width / 2, y);
  context.bezierCurveTo(
    x - width * 0.31,
    y - height * 0.12,
    x - width * 0.22,
    y - height,
    x,
    y - height,
  );
  context.bezierCurveTo(
    x + width * 0.2,
    y - height,
    x + width * 0.36,
    y - height * 0.13,
    x + width / 2,
    y,
  );
  context.strokeStyle = palette.ink;
  context.lineWidth = style === 'engraved' ? 1.15 : 1.7;
  context.stroke();
}
function hillGroup(context: CanvasRenderingContext2D, brush: Brush, variant: number) {
  hill(context, brush, 76, 193, 100, variant ? 47 : 42);
  hill(context, brush, 162, 197, 114, variant ? 61 : 52);
  hill(context, brush, 117, 226, 139, variant ? 54 : 64);
  line(
    context,
    [
      [34, 230],
      [76, 227],
      [98, 231],
    ],
    brush.palette.ink,
    0.8,
    0.4,
  );
  line(
    context,
    [
      [152, 230],
      [194, 226],
      [226, 229],
    ],
    brush.palette.ink,
    0.8,
    0.4,
  );
}

function conifer(
  context: CanvasRenderingContext2D,
  brush: Brush,
  x: number,
  base: number,
  height: number,
) {
  const { palette, style, random } = brush;
  const width = height * (style === 'painted' ? 0.49 : 0.43);
  const top = base - height;
  const points: Point[] = [[x, top]];
  const tiers = style === 'engraved' ? 6 : 5;
  for (let i = 1; i <= tiers; i++) {
    const t = i / tiers;
    points.push(
      [x - (width * t) / 2, top + height * (0.1 + t * 0.7)],
      [x - width * t * 0.26, top + height * (0.14 + t * 0.7)],
    );
  }
  points.push([x + width * 0.33, base - height * 0.1]);
  for (let i = tiers; i > 0; i--) {
    const t = i / tiers;
    points.push(
      [x + (width * t) / 2, top + height * (0.1 + t * 0.7)],
      [x + width * t * 0.21, top + height * (0.05 + t * 0.7)],
    );
  }
  context.fillStyle = palette.ink;
  context.fillRect(x - 1.3, base - height * 0.21, 2.6, height * 0.22);
  polygon(context, points, style === 'painted' ? palette.forest : palette.paper);
  context.save();
  path(context, points, true);
  context.clip();
  polygon(
    context,
    [
      [x, top],
      [x + width, base],
      [x, base],
    ],
    style === 'painted' ? '#2e5b4c' : palette.forest,
    style === 'painted' ? 0.8 : 0.34,
  );
  if (style === 'painted') {
    for (let i = 0; i < 11; i++) {
      const y = top + height * (0.2 + random() * 0.65);
      line(
        context,
        [
          [x - width * random() * 0.5, y],
          [x + 1, y - 3],
        ],
        '#b9cb8c',
        2.8,
        0.32,
      );
    }
  } else {
    for (let i = 1; i <= (style === 'engraved' ? 11 : 6); i++) {
      const t = i / (style === 'engraved' ? 12 : 7);
      line(
        context,
        [
          [x, top + height * t],
          [x + width * t * 0.45, top + height * (t + 0.1)],
        ],
        palette.ink,
        style === 'engraved' ? 0.75 : 0.9,
        0.6,
      );
    }
  }
  context.restore();
  path(context, points, true);
  context.strokeStyle = palette.ink;
  context.lineWidth = style === 'engraved' ? 1 : style === 'painted' ? 1.05 : 1.4;
  context.stroke();
  if (style === 'engraved') {
    line(
      context,
      [
        [x, top + 9],
        [x, base],
      ],
      palette.ink,
      0.7,
      0.5,
    );
  }
}
function broadleaf(
  context: CanvasRenderingContext2D,
  brush: Brush,
  x: number,
  base: number,
  height: number,
) {
  const { palette, style, random } = brush;
  const radius = height * 0.32;
  const centerY = base - height * 0.58;
  line(
    context,
    [
      [x, base],
      [x - 1, centerY - 2],
    ],
    palette.ink,
    style === 'painted' ? 3.5 : 2.2,
  );
  line(
    context,
    [
      [x, base - 10],
      [x - 11, centerY + 3],
    ],
    palette.ink,
    1.1,
  );
  line(
    context,
    [
      [x, base - 13],
      [x + 12, centerY + 1],
    ],
    palette.ink,
    1.1,
  );
  const lobes = style === 'engraved' ? 11 : 8;
  const points: Point[] = [];
  for (let i = 0; i < lobes * 2; i++) {
    const angle = (i * Math.PI) / lobes;
    const extent = radius * (i % 2 ? 0.89 : 1.08) * (0.96 + random() * 0.08);
    points.push([x + Math.cos(angle) * extent, centerY + Math.sin(angle) * extent * 0.86]);
  }
  // Rounded scallops make one connected canopy, rather than a stack of circles.
  const canopy = () => {
    context.beginPath();
    context.moveTo((points[0][0] + points.at(-1)![0]) / 2, (points[0][1] + points.at(-1)![1]) / 2);
    for (let i = 0; i < points.length; i++) {
      const next = points[(i + 1) % points.length];
      context.quadraticCurveTo(
        points[i][0],
        points[i][1],
        (points[i][0] + next[0]) / 2,
        (points[i][1] + next[1]) / 2,
      );
    }
    context.closePath();
  };
  canopy();
  context.fillStyle = style === 'painted' ? '#789a61' : palette.paper;
  context.fill();
  context.save();
  context.clip();
  polygon(
    context,
    [
      [x - radius, centerY + radius * 0.28],
      [x + radius, centerY - radius * 0.55],
      [x + radius, centerY + radius],
      [x - radius, centerY + radius],
    ],
    style === 'painted' ? '#416e52' : palette.forest,
    style === 'painted' ? 0.8 : 0.24,
  );
  if (style === 'painted') {
    for (let i = 0; i < 18; i++) {
      context.fillStyle = i % 2 ? '#b3c77c' : '#577e51';
      context.globalAlpha = 0.22;
      context.beginPath();
      context.ellipse(
        x + (random() - 0.5) * radius * 2,
        centerY + (random() - 0.5) * radius * 1.4,
        2 + random() * 5,
        1.5 + random() * 2,
        -0.4,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
    context.globalAlpha = 1;
  } else {
    const count = style === 'engraved' ? 13 : 5;
    for (let i = 0; i < count; i++) {
      const y = centerY - radius * 0.6 + (i * radius * 1.7) / count;
      line(
        context,
        [
          [x + radius * 0.2, y],
          [x + radius, y + radius * 0.38],
        ],
        palette.ink,
        0.75,
        style === 'engraved' ? 0.62 : 0.3,
      );
    }
  }
  context.restore();
  canopy();
  context.strokeStyle = palette.ink;
  context.lineWidth = style === 'engraved' ? 1.15 : 1.5;
  context.stroke();
  if (style !== 'painted') {
    context.beginPath();
    context.arc(x - radius * 0.3, centerY - radius * 0.2, radius * 0.28, 3.1, 5.8);
    context.lineWidth = 0.8;
    context.stroke();
  }
}
function forestGroup(
  context: CanvasRenderingContext2D,
  brush: Brush,
  variant: number,
  broad = false,
) {
  const random = brush.random;
  const arrangement = [
    [73, 170, 80],
    [153, 167, 88],
    [113, 188, 115],
    [51, 213, 82],
    [187, 210, 98],
    [81, 229, 107],
    [144, 231, 121],
  ];
  for (const [x, base, height] of arrangement) {
    const at = x + (random() - 0.5) * (variant === 2 ? 13 : 7);
    const tall = height * (0.9 + random() * 0.15) * (variant === 3 ? 0.83 : 1);
    if (broad) {
      broadleaf(context, brush, at, base, tall);
    } else {
      conifer(context, brush, at, base, tall);
    }
  }
  for (let i = 0; i < 5; i++) {
    const x = 45 + random() * 161;
    line(
      context,
      [
        [x, 231],
        [x + 4, 228],
        [x + 10, 230],
      ],
      brush.palette.ink,
      0.8,
      0.3,
    );
  }
}
function marsh(context: CanvasRenderingContext2D, brush: Brush, variant: number) {
  for (let clump = 0; clump < 5; clump++) {
    const x = 44 + clump * 39 + (brush.random() - 0.5) * 10;
    const base = 207 + (clump % 2) * 16;
    for (let stem = -2; stem <= 2; stem++) {
      const height = 22 + brush.random() * 24 + variant * 6;
      const end: Point = [x + stem * 7, base - height];
      line(
        context,
        [[x, base], [x + stem * 3, base - height * 0.5], end],
        brush.style === 'painted' ? '#496f54' : brush.palette.ink,
        brush.style === 'engraved' ? 0.9 : 1.5,
      );
      if (stem % 2) {
        line(context, [[end[0], end[1] + 6], end], brush.palette.ink, 2.8);
      }
    }
    line(
      context,
      [
        [x - 13, base + 4],
        [x - 3, base + 3],
        [x + 17, base + 5],
      ],
      brush.palette.river,
      1.1,
      0.58,
    );
  }
}

/** Original procedural art: overlapping silhouettes, summit-oriented hatching,
 * and rounded forest clumps. Every tile has a transparent 20px guard band; no
 * rectangular paper background can obscure adjacent water or terrain. */
export function drawFantasySymbolAtlas(context: CanvasRenderingContext2D, style: FantasyMapStyle) {
  context.clearRect(
    0,
    0,
    FANTASY_ATLAS_COLUMNS * FANTASY_ATLAS_TILE_SIZE,
    FANTASY_ATLAS_ROWS * FANTASY_ATLAS_TILE_SIZE,
  );
  for (let tile = 0; tile < FANTASY_ATLAS_COLUMNS * FANTASY_ATLAS_ROWS; tile++) {
    context.save();
    context.translate(
      (tile % FANTASY_ATLAS_COLUMNS) * FANTASY_ATLAS_TILE_SIZE,
      Math.floor(tile / FANTASY_ATLAS_COLUMNS) * FANTASY_ATLAS_TILE_SIZE,
    );
    context.beginPath();
    context.rect(20, 20, 216, 216);
    context.clip();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    const brush = {
      style,
      palette: FANTASY_PALETTES[style],
      random: seeded(982451653 + tile * 7919),
    };
    if (tile < 4) {
      mountainGroup(context, brush, tile);
    } else if (tile < 6) {
      hillGroup(context, brush, tile - 4);
    } else if (tile < 10) {
      forestGroup(context, brush, tile - 6);
    } else if (tile < 14) {
      forestGroup(context, brush, tile - 10, true);
    } else {
      marsh(context, brush, tile - 14);
    }
    context.restore();
  }
}

/** The caller owns this one small atlas and disposes it with the symbol layer.
 * Wide transparent tile padding protects bilinear/mip samples from neighboring ink. */
export function createFantasySymbolAtlas(style: FantasyMapStyle): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = FANTASY_ATLAS_COLUMNS * FANTASY_ATLAS_TILE_SIZE;
  canvas.height = FANTASY_ATLAS_ROWS * FANTASY_ATLAS_TILE_SIZE;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('A 2D canvas is required to draw fantasy map symbols.');
  }
  drawFantasySymbolAtlas(context, style);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = `fantasy-symbols-${style}`;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.flipY = true;
  return texture;
}
