export type FantasyMapStyle = 'parchment' | 'engraved' | 'painted';

export interface FantasyPalette {
  paper: string;
  ink: string;
  ocean: string;
  shore: string;
  meadow: string;
  forest: string;
  rock: string;
  snow: string;
  mountainShadow: string;
  river: string;
  riverHighlight: string;
}

export const FANTASY_PALETTES: Record<FantasyMapStyle, FantasyPalette> = {
  parchment: {
    paper: '#ecdcb4',
    ink: '#5b432c',
    ocean: '#b9c4bc',
    shore: '#d6d8c2',
    meadow: '#d8d0a5',
    forest: '#a7ad81',
    rock: '#d6c5a1',
    snow: '#f6edcf',
    mountainShadow: '#96815f',
    river: '#526d70',
    riverHighlight: '#7f9792',
  },
  engraved: {
    paper: '#f0eadb',
    ink: '#343b37',
    ocean: '#c5d3d3',
    shore: '#e0e4da',
    meadow: '#e4e4d1',
    forest: '#c0cabb',
    rock: '#dfdbcd',
    snow: '#faf7ec',
    mountainShadow: '#969c91',
    river: '#49676e',
    riverHighlight: '#819697',
  },
  painted: {
    paper: '#dbcb98',
    ink: '#475a42',
    ocean: '#326785',
    shore: '#8db7b3',
    meadow: '#aebc78',
    forest: '#557d58',
    rock: '#a69b81',
    snow: '#f1f1df',
    mountainShadow: '#6d7c75',
    river: '#367c96',
    riverHighlight: '#92c3bf',
  },
};

export function isFantasyMapStyle(style: string): style is FantasyMapStyle {
  return style === 'parchment' || style === 'engraved' || style === 'painted';
}
