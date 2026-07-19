// Tomo Together — Neko Atsume-inspired hand-drawn theme.
// Warm tan paw-print world, cream cards, chunky brown-outlined lettering.

export const C = {
  // backgrounds
  tan: '#F2D9A4',
  tanPaw: '#E4C480',
  pink: '#F9D7DE',
  pinkPaw: '#F0BFCA',
  green: '#D8E8B0',
  greenPaw: '#C2D890',

  // surfaces
  cream: '#FBEED2',
  card: '#F6E4BC',
  white: '#FFFFFF',

  // inks
  brown: '#6E5836',
  darkInk: '#4A4031',
  fadedInk: '#A08A5E',

  // accents (pin colors from the Album screen)
  orange: '#E8A33D',
  yellow: '#F0C93F',
  redPin: '#E0475B',
  greenPin: '#7FBF4D',
  bluePin: '#4A90D9',
  purplePin: '#A64CA6',
  pinkPin: '#F286B0',

  // label colors (Catbook style: pastel word + white outline)
  labelPink: '#F286B0',
  labelBlue: '#6FA8DC',
  labelGreen: '#83C167',
  labelOrange: '#E8A33D',
  labelPurple: '#B07CC6',
} as const;

export const F = {
  display: 'SproutPixel',
  displayMed: 'SproutPixel',
  body: 'Delius_400Regular',
} as const;

export const PIN_COLORS = [C.redPin, C.orange, C.yellow, C.greenPin, C.bluePin, C.purplePin];

// Deterministic pseudo-random for stable "hand-drawn" wobble per element.
export function wob(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Crisp pixel-style corners (Sprout Lands UI uses squared chunky panels).
export function doodleCorners(_seed: number, _base = 18) {
  return {
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
    borderBottomRightRadius: 6,
    borderBottomLeftRadius: 6,
  };
}

export function doodleTilt(_seed: number, _maxDeg = 1.6) {
  return { transform: [{ rotate: '0deg' }] };
}
