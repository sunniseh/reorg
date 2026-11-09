// Types for palette.mjs, so the TypeScript client (apps/web/src/theme/tokens.ts) can import
// the one palette source. Keep in sync with palette.mjs.
export declare const C: {
  bg: string;
  panel: string;
  ink: string;
  muted: string;
  line: string;
  deskEdge: string;
  accent: string;
  good: string;
  bad: string;
  coin: string;
  skin: string;
  body: readonly string[];
  floor: {
    penthouse: string;
    directors: string;
    managers: string;
    associates: string;
    interns: string;
    lobby: string;
    basement: string;
  };
  sky: string;
  skyline: string;
  shell: string;
  shellEdge: string;
  glass: string;
  street: string;
  ground: string;
};
export declare const SPRITE: Record<string, string> & { hair: readonly string[] };
export declare const TINT_BASE: string;
export declare const TINT_SHADE: string;
