/**
 * Color tokens (design §6), defined once in art/palette.mjs and exported here both as numbers for
 * Pixi and as CSS variables for the DOM HUD. No raw hex values in components (design §15.1).
 */
import { C, SPRITE } from "../../../../art/palette.mjs";

const n = (hex: string): number => parseInt(hex.slice(1), 16);

export const CSS = C;

export const TOKENS = {
  bg: n(C.bg),
  panel: n(C.panel),
  ink: n(C.ink),
  muted: n(C.muted),
  line: n(C.line),
  deskEdge: n(C.deskEdge),
  accent: n(C.accent),
  good: n(C.good),
  bad: n(C.bad),
  coin: n(C.coin),
  sky: n(C.sky),
  skyline: n(C.skyline),
  shell: n(C.shell),
  glass: n(C.glass),
  street: n(C.street),
  ground: n(C.ground),
  concreteShade: n(SPRITE.concreteShade!),
  floor: {
    penthouse: n(C.floor.penthouse),
    directors: n(C.floor.directors),
    managers: n(C.floor.managers),
    associates: n(C.floor.associates),
    interns: n(C.floor.interns),
    lobby: n(C.floor.lobby),
    basement: n(C.floor.basement),
  },
  body: C.body.map(n),
  hair: SPRITE.hair.map(n),
};

/** Writes the tokens as CSS custom properties on :root (the HUD's only color source). */
export function installCssTokens(root: HTMLElement = document.documentElement): void {
  const vars: Record<string, string> = {
    "--bg": C.bg,
    "--panel": C.panel,
    "--ink": C.ink,
    "--muted": C.muted,
    "--line": C.line,
    "--desk-edge": C.deskEdge,
    "--accent": C.accent,
    "--button-text": C.bg,
    "--good": C.good,
    "--bad": C.bad,
    "--coin": C.coin,
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
}
