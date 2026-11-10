// REORG colors. UI tokens are the Blueprint palette from
// docs/design/REORG Design Spec.md §6; sprite colors are the extra shades the
// pixel art needs (spec §6, "Sprite colors"). When apps/web/src/theme/tokens.ts
// exists, it should import this file (or replace it) so there is one source.

export const C = {
  bg: "#0a1626",
  panel: "#11233a",
  ink: "#e6f1fb",
  muted: "#8fa6bf",
  line: "#25405d",
  deskEdge: "#6a8aad",
  accent: "#6ad4ff",
  good: "#4cc38a",
  bad: "#ff7b7b",
  coin: "#f2c230",
  skin: "#e9b98f",
  body: ["#c8d879", "#98d879", "#79d881", "#7990d8", "#8979d8", "#b079d8", "#d879d8", "#d879b0"],
  floor: {
    penthouse: "#123a55",
    directors: "#1a2c4f",
    managers: "#153250",
    associates: "#14403f",
    interns: "#3b3820",
    lobby: "#15263c",
    basement: "#0d1c30",
  },
  // Building tokens (spec §6, new in v2.0).
  sky: "#0a1626",
  skyline: "#10203a",
  shell: "#1f3a5a",
  shellEdge: "#6a8aad",
  glass: "#2b5876",
  street: "#132339",
  ground: "#0d1c30",
  // Day and night (W-15, Later): the sky by day; at night it is the Sky value above.
  skyDay: "#1b3d63",
};

// Sprite-only colors: shades of tokens and the few props that need their own hue.
// They never appear in the interface (spec §6, "Sprite colors").
export const SPRITE = {
  skinShade: "#c98f66",
  accentShade: "#3c9cc8",
  coinShade: "#b88a10",
  trousers: "#2c4462",
  trousersShade: "#1f3149",
  cardboard: "#c49a5a",
  cardboardShade: "#8f6a38",
  plant: "#6fb07e",
  plantDark: "#3f7a50",
  // Hair: tinted onto the grayscale hair layer; index from the wallet hash.
  hair: ["#5a3b26", "#8a5a32", "#d6b16a", "#b9c2cc", "#2f3a4f", "#a8452e"],
  // Building shades (A-01).
  shellShade: "#172f4b",
  shellLight: "#2c4e74",
  glassLight: "#4f88ab",
  pavement: "#1c3150",
  pavementLine: "#0f1d31",
  brick: "#7a4436",
  brickLight: "#93573f",
  mortar: "#4a2a24",
  concrete: "#5a6e86",
  concreteShade: "#42546b",
  wood: "#9a6a3c",
  woodShade: "#6e4826",
  woodLight: "#b88552",
  steel: "#a3b6ca",
  steelShade: "#5d728a",
  steelDark: "#2b3f57",
  shaft: "#06101d",
  water: "#a9c7dc",
  coffee: "#4a2f1d",
  fabric: "#36577a",
  fabricShade: "#294463",
  lamp: "#f3e3b0",
  alarmOff: "#5e2a36",
  led: "#3f8f6a",
  screen: "#9fd3c4",
};

// Tint layers are drawn in grayscale; the renderer multiplies them by a color.
export const TINT_BASE = "#ffffff";
export const TINT_SHADE = "#b0b0b0";
