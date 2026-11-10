/**
 * The backdrop and what stands beside the building (roadmap W-15, design §4.1 layer 0, §9, §12.2):
 * the sky and the skyline, day and night, the per-state surroundings (an empty lot and a tree, a
 * parking lot and a coffee cart, city blocks, drifting clouds, the Megacorp blimp carrying the
 * boss's latest line, and the annex towers where the folded floors work: the twin from Megacorp
 * on, a row of them on a Campus, a skyline for a Conglomerate). Nothing here carries chain state
 * beyond the building state and the folded-floor count; there are no people in it.
 *
 * Everything is a function of the model and the wall clock (UTC for day and night), so every
 * client draws the same surroundings. Under reduced motion the clouds and the blimp hold still.
 */
import type { BuildingState } from "@reorg/core";
import { Container, Sprite, Text, Texture, TilingSprite } from "pixi.js";
import { TOKENS } from "../theme/tokens";
import type { Atlas } from "./atlas";
import { ANNEX_W, annexesOf, annexX, mixColor, nightness, skylineSpan } from "./derive";
import { G, RIG, type BandStack, type BuildingStateKey } from "./geometry";

const S = RIG.building.surroundings;
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
/** How far the sky, the skyline and the ground reach past the building on each side (sprite px; the overview zoom shows them). */
export const SIDE = 3200;
/** Below this zoom the annex signs stop shrinking with the world, so the overview can read them. */
const SIGN_ZOOM = 1;

/** An annex sign's scale at zoom `z`: screen size when zoomed out, never wider than its tower's slot. */
function signScale(sign: Container, z: number): number {
  const natural = sign.width / Math.abs(sign.scale.x || 1);
  const slot = ANNEX_W + S.twin.gap - 6;
  return Math.max(1, Math.min(SIGN_ZOOM / z, slot / Math.max(1, natural)));
}
/** Clouds wrap over this span (sprite px from the building's left edge). */
const CLOUD_FROM = -700;
const CLOUD_SPAN = G.width + 1400;
const CLOUDS = [
  { tile: 0, y: 16, off: 0 },
  { tile: 1, y: 44, off: 520 },
  { tile: 0, y: 70, off: 1010 },
  { tile: 1, y: 96, off: 1460 },
];

export class RgSurroundings extends Container {
  private readonly sky: Sprite;
  private readonly lit: Container[] = [];
  private readonly clouds: Sprite[] = [];
  private blimp: Container | null = null;
  private blimpText: Text | null = null;
  private blimpLine = "";
  private readonly annexes: Container;
  private annexLit: TilingSprite[] = [];
  private annexKey = "";
  private signs: Container[] = [];
  private zoom = 1;
  private night = -1;
  private readonly streetY: number;
  private readonly mainFloors: number;

  constructor(
    private readonly atlas: Atlas,
    stack: BandStack,
    shell: BuildingStateKey,
    private readonly state: BuildingState,
  ) {
    super();
    this.eventMode = "none";
    const street = stack.byKey.get("street")!;
    this.streetY = street.y;
    this.mainFloors = stack.bands.filter((b) => b.kind === "floor" || b.kind === "fold" || b.kind === "penthouse" || b.kind === "lobby").length;
    const set = RIG.building.states[shell].surroundings;

    this.sky = new Sprite(Texture.WHITE);
    this.sky.position.set(-SIDE, -2000);
    this.sky.setSize(G.width + SIDE * 2, street.y + 2000);
    this.addChild(this.sky);
    // The far skyline, then the nearer blocks from the Office tower up; each has a lit copy for night.
    this.band("sky.skyline", "sky.skyline.lit", 48);
    if (S.blocks.sets.includes(set)) this.band(S.blocks.tile, S.blocks.lit, 96);
    if (S.clouds.sets.includes(set)) {
      for (const c of CLOUDS) {
        const s = new Sprite(atlas.tex(S.clouds.tiles[c.tile]!));
        s.y = c.y;
        this.clouds.push(s);
        this.addChild(s);
      }
    }
    this.annexes = new Container();
    this.addChild(this.annexes);
    for (const p of S.props[set] ?? []) {
      const tex = atlas.tex(p.tile);
      const y = street.y - tex.frame.height;
      if (p.w) {
        const t = new TilingSprite({ texture: tex, width: p.w, height: tex.frame.height });
        t.position.set(p.x, y);
        this.addChild(t);
      } else {
        const s = new Sprite(tex);
        s.position.set(p.x, y);
        this.addChild(s);
      }
    }
    if (S.blimp.sets.includes(set)) this.makeBlimp();
    const ground = new Sprite(Texture.WHITE);
    ground.tint = TOKENS.ground;
    ground.position.set(-SIDE, street.y + 14);
    ground.setSize(G.width + SIDE * 2, stack.height - street.y - 14 + 600);
    this.addChild(ground);
  }

  /** A horizontal band of a tile standing on the street line, with its lit copy over it. */
  private band(tile: string, lit: string, h: number): void {
    for (const [name, isLit] of [
      [tile, false],
      [lit, true],
    ] as const) {
      const t = new TilingSprite({ texture: this.atlas.tex(name), width: G.width + SIDE * 2, height: h });
      t.position.set(-SIDE, this.streetY - h);
      this.addChild(t);
      if (isLit) this.lit.push(t);
    }
  }

  private makeBlimp(): void {
    const c = new Container();
    c.addChild(new Sprite(this.atlas.tex(S.blimp.tile)));
    const t = new Text({
      text: "",
      style: { fontFamily: FONT, fontSize: 4.4, fontWeight: "700", fill: TOKENS.ink, wordWrap: true, wordWrapWidth: S.blimp.panel.w - 4, lineHeight: 5 },
      resolution: 10,
    });
    t.position.set(S.blimp.panel.x + 2, S.blimp.panel.y + 1);
    c.addChild(t);
    this.blimp = c;
    this.blimpText = t;
    this.addChild(c);
  }

  /** The boss's latest line on the blimp's panel, cut to what fits. */
  private setBlimpLine(line: string): void {
    const t = this.blimpText;
    if (!t || line === this.blimpLine) return;
    this.blimpLine = line;
    let words = line.split(/\s+/);
    t.text = line;
    while (t.height > S.blimp.panel.h && words.length > 1) {
      words = words.slice(0, -1);
      t.text = `${words.join(" ").replace(/[,.;:]$/, "")}…`;
    }
  }

  /** World x range of the headquarters and its annexes for `folded` floors (the overview camera frames it). */
  span(folded: number): [number, number] {
    return skylineSpan(annexesOf(this.state, folded, this.mainFloors).length);
  }

  /** Keeps the annex signs legible when the camera zooms out to the skyline. */
  setZoom(z: number): void {
    if (z === this.zoom) return;
    this.zoom = z;
    for (const s of this.signs) s.scale.set(signScale(s, z));
  }

  /** The annex towers, as tall as their folded floors say (design §12.2). */
  private buildAnnexes(folded: number): void {
    const list = annexesOf(this.state, folded, this.mainFloors);
    const key = list.map((a) => `${a.name}${a.floors}`).join(",");
    if (key === this.annexKey) return;
    this.annexKey = key;
    this.annexes.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.annexLit = [];
    this.signs = [];
    const pitch = G.floor.pitch;
    const w = ANNEX_W;
    // Far towers first, so the twin stands in front.
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i]!;
      const x = annexX(i);
      const h = a.drawn * pitch;
      const top = this.streetY - h;
      const c = new Container();
      const facade = new TilingSprite({ texture: this.atlas.tex(S.twin.facade), width: w, height: h });
      facade.position.set(x, top);
      const lit = new TilingSprite({ texture: this.atlas.tex(S.twin.lit), width: w, height: h });
      lit.position.set(x, top);
      lit.alpha = Math.max(0, this.night);
      this.annexLit.push(lit);
      const parapet = new TilingSprite({ texture: this.atlas.tex(S.twin.parapet), width: w, height: 8 });
      parapet.position.set(x, top - 8);
      c.addChild(facade, lit, parapet);
      if (i === 0 && a.drawn >= 4) {
        // The sky bridge, two floors below the twin's top, back to the headquarters' right wall.
        const bridge = new TilingSprite({ texture: this.atlas.tex(S.twin.bridge), width: S.twin.gap, height: 14 });
        bridge.position.set(G.width, top + 2 * pitch + 18);
        c.addChild(bridge);
      }
      // The name and the folded floors it holds, over the entrance (the blimp flies past the tops).
      const label = new Text({
        text: a.floors > 0 ? `ANNEX ${a.name} · ${a.floors.toLocaleString("en-US")} ${a.floors === 1 ? "FLOOR" : "FLOORS"}` : `ANNEX ${a.name} · OPENING SOON`,
        style: { fontFamily: FONT, fontSize: 6, fontWeight: "800", fill: TOKENS.ink, letterSpacing: 0.5 },
        resolution: 8,
      });
      label.anchor.set(0.5, 1);
      const plate = new Sprite(Texture.WHITE);
      plate.tint = TOKENS.bg;
      plate.alpha = 0.8;
      plate.setSize(Math.ceil(label.width) + 8, 10);
      plate.position.set(-Math.round(plate.width / 2), -10);
      label.position.set(0, -1);
      label.style.fill = TOKENS.ink;
      // The sign grows from its foot over the entrance, so zooming out keeps it readable.
      const sign = new Container();
      sign.position.set(Math.round(x + w / 2), this.streetY - 6);
      sign.addChild(plate, label);
      sign.scale.set(signScale(sign, this.zoom));
      this.signs.push(sign);
      c.addChild(sign);
      this.annexes.addChild(c);
    }
  }

  tick(now: number, opts: { reduced: boolean; bossLine: string; folded: number }): void {
    // Day and night move slowly: the tints change only when the light moves by a visible step.
    const night = Math.round(nightness(now) * 32) / 32;
    if (night !== this.night) {
      this.night = night;
      this.sky.tint = mixColor(TOKENS.skyDay, TOKENS.sky, night);
      for (const l of this.lit) l.alpha = night;
      for (const l of this.annexLit) l.alpha = night;
    }
    this.buildAnnexes(opts.folded);
    const t = opts.reduced ? 0 : now;
    for (const [i, s] of this.clouds.entries()) {
      const c = CLOUDS[i]!;
      const d = ((((t / 1000) * S.clouds.speed + c.off) % CLOUD_SPAN) + CLOUD_SPAN) % CLOUD_SPAN;
      s.x = Math.round(CLOUD_FROM + d);
    }
    if (this.blimp) {
      this.setBlimpLine(opts.bossLine);
      // Right of the building near the top: the open sky a laptop shows beside the dock.
      this.blimp.position.set(Math.round(G.width + 60 + 36 * Math.sin(t / 18_000)), Math.round(18 + 3 * Math.sin(t / 7_000)));
    }
  }
}
