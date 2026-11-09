/**
 * Building geometry (design §4.2–§4.3; art/README.md): the rig from the atlas and the vertical
 * stack of bands computed from a `TowerLayout`. Pure (no Pixi), so it is unit-tested.
 * Units are sprite pixels: x from the building's left edge, y down from the roof's top.
 */
import type { TierIndex, TowerLayout } from "@reorg/core";
import atlas from "../../../../art/characters.json";

export type XY = [number, number];

export interface RoomAnchor {
  w: number;
  perFloor: number;
  desk: { x: number; w: number };
  seat: number;
  chair: "exec" | "standard";
  screen: "monitor" | "laptop";
  monitor: XY;
  paper: XY;
  dot: XY;
  streak: XY;
  chip: XY;
  plate: XY;
  box: XY;
}

export interface FrameRig {
  view: "front" | "side";
  headY: number;
  headX?: number;
  hand?: XY;
}

export interface Rig {
  frames: Record<string, FrameRig>;
  hair: Record<string, { front: { y: number }; side: { y: number } }>;
  attach: { chairFront: XY; chairSide: XY; chairExecFront: XY; chairExecSide: XY };
  animations: Record<string, { frames: string[]; fps: number; loop?: boolean }>;
  building: {
    geometry: {
      width: number;
      wall: number;
      stairs: { x: number; w: number };
      tube: { x: number; w: number };
      shaft: { x: number; w: number };
      rooms: { x: number; w: number };
      bay: { x: number; w: number };
      floor: { h: number; slab: number; pitch: number; deskTop: number };
      penthouse: { h: number };
      lobby: { h: number };
      street: { h: number; standY: number };
      basement: { h: number };
      roof: { h: number };
    };
    states: Record<"garage" | "office" | "tower", { sign: string; doors: string }>;
    core: {
      landing: XY | { x: number; y: number };
      outlet: { x: number; y: number; mouth: XY };
      cab: { x: number; floorRow: number };
      indicator: { x: number; y: number };
    };
    floor: {
      alarm: { x: number; y: number };
      clock: { x: number; y: number };
      whiteboard: { x: number; y: number };
      bay: { points: { cooler: number; printer: number; outbox: number; coffee: number; window: number } };
      outboxSheets: { x: number; y: number };
      plaque: { x: number; y: number };
      posters: { y: number };
    };
    rooms: Record<"directors" | "managers" | "associates" | "interns", RoomAnchor>;
    penthouse: {
      window: { tile: string; x: number; y: number };
      shelf: { tile: string; x: number; y: number };
      orgchart: { tile: string; x: number; y: number };
      desk: { tile: string; x: number; y: number };
      chair: { tile: string; x: number; y: number };
      boss: { home: number; paceFrom: number; paceTo: number; window: number };
    };
    lobby: {
      logo: { tile: string; x: number; y: number };
      reception: { tile: string; x: number; y: number };
      cafe: { tile: string; x: number; y: number; stools: number[]; table: { x: number; y: number } };
      hrDoor: { tile: string; x: number; y: number };
      plants: { tile: string; x: number; y: number }[];
      doors: { x: number; y: number; point: number };
      points: Record<"stairs" | "elevator" | "cafe" | "hr" | "reception" | "door", number>;
      crowdSign: { x: number; y: number; w: number; h: number };
    };
    street: {
      standY: number;
      bench: { tile: string; x: number; y: number; seats: number[] };
      lamp: { tile: string; x: number; y: number };
      queue: { spots: number[] };
    };
    basement: {
      tubeFoot: { tile: string; x: number; y: number };
      vaultDoor: { tile: string; x: number; y: number };
      boxes: { tile: string; x: number; y: number };
      bar: { tile: string; x: number; y: number; fill: { x: number; y: number; w: number; h: number } };
      pile: { x: number; bottom: number };
      partition: { x: number };
      racks: { tile: string; x: number; y: number }[];
    };
    roof: { tank: { tile: string; x: number }; machine: { tile: string; x: number } };
  };
}

export const RIG = (atlas as unknown as { meta: { rig: Rig } }).meta.rig;
export const G = RIG.building.geometry;
export const TIER_KEYS = ["directors", "managers", "associates", "interns"] as const;
export const roomOf = (tier: TierIndex): RoomAnchor => RIG.building.rooms[TIER_KEYS[tier]];

/** Ground below the basement slab, drawn as earth. */
export const GROUND_H = 10;

export type BandKind = "roof" | "penthouse" | "floor" | "lobby" | "street" | "basement";

export interface Band {
  key: string;
  kind: BandKind;
  /** Top, in sprite px from the roof's top. */
  y: number;
  /** Height including the slab below it. */
  h: number;
  /** Interior height (ceiling to the floor line). */
  interior: number;
  /** For tier floors: index into `layout.floors`. */
  floor?: number;
  tier?: TierIndex;
}

export interface BandStack {
  bands: Band[];
  /** Total height including the ground. */
  height: number;
  byKey: Map<string, Band>;
}

/** The bands top to bottom (design §4.3): roof, penthouse, tier floors, lobby, street, basement. */
export function bandsOf(layout: Pick<TowerLayout, "floors">): BandStack {
  const bands: Band[] = [];
  let y = 0;
  const add = (b: Omit<Band, "y">) => {
    bands.push({ ...b, y });
    y += b.h;
  };
  add({ key: "roof", kind: "roof", h: G.roof.h, interior: G.roof.h });
  add({ key: "penthouse", kind: "penthouse", h: G.penthouse.h + G.floor.slab, interior: G.penthouse.h });
  layout.floors.forEach((f, i) => add({ key: f.key, kind: "floor", h: G.floor.pitch, interior: G.floor.h, floor: i, tier: f.tier }));
  add({ key: "lobby", kind: "lobby", h: G.lobby.h + G.floor.slab, interior: G.lobby.h });
  add({ key: "street", kind: "street", h: G.street.h, interior: G.street.h });
  add({ key: "basement", kind: "basement", h: G.basement.h + G.floor.slab, interior: G.basement.h });
  return { bands, height: y + GROUND_H, byKey: new Map(bands.map((b) => [b.key, b])) };
}

/** Where a seated character sits: frame left edge and bottom (the desk top), in building px. */
export function seatOf(band: Band, room: number): { x: number; bottom: number; roomX: number } {
  const R = roomOf(band.tier!);
  const roomX = G.rooms.x + room * R.w;
  return { x: roomX + R.seat, bottom: band.y + G.floor.deskTop, roomX };
}

/** Bands that intersect the world-space range [y0, y1] (viewport culling, roadmap W-03). */
export function visibleBands(stack: BandStack, y0: number, y1: number): Band[] {
  return stack.bands.filter((b) => b.y + b.h > y0 && b.y < y1);
}
