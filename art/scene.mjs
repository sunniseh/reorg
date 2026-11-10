// A whole building composed from the atlas frames, as SVG: the reference for how
// the client stacks the tiles (apps/web building/, roadmap W-05), and the source
// of art/building.png and the brand images. It follows RIG.building exactly; if a
// placement looks wrong here, fix the rig, not this file.
//
// This is an illustration of one moment, not game logic: the model says what is
// where. The client derives the same picture from chain state (design spec §4-§5).

import { FRAMES, RIG, bake, bakeCharacter } from "./sprites.mjs";
import { gridToSvg } from "./lib.mjs";
import { C, SPRITE } from "./palette.mjs";

const B = RIG.building;
const CH = RIG.character;
const G = B.geometry;
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const TIERS = ["directors", "managers", "associates", "interns"];
const TIER_NAME = { directors: "Directors", managers: "Managers", associates: "Associates", interns: "Interns" };

/** A tile's grid repeated to fill w x h (clipped). */
function repeat(name, w, h) {
  const t = bake(name);
  return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => t[y % t.length][x % t[0].length]));
}

/** Character appearance from a small index (the client uses the wallet hash, W-04). */
export function look(i, style) {
  const styles = RIG.hairStyles;
  return { shirt: C.body[i % 8], hair: SPRITE.hair[(i * 5 + 1) % 6], style: style ?? styles[(i * 3) % styles.length] };
}

/**
 * Renders a building. `m` (all optional except state and tiers):
 *   state: "garage" | "office" | "tower"
 *   tiers: { directors: [desk...], managers: [...], ... } in layout order; a floor
 *     holds rooms[tier].perFloor desks. desk = null (empty) or
 *     { look, pose: "sit"|"type"|"cheer"|"slump"|"away"|"laidoff", paper, dot: "pass"|"miss",
 *       streak, isNew, you, pay }
 *   agents: [{ band: "<tier>:<floor>"|"penthouse"|"lobby"|"street", frame, x, look, mirror, paper }]
 *   boss: { frame, x, mirror, bubble }
 *   cab: { band, doors: 0|1|2, riders: [look] }, coins: [{ band, x, y, frame }]
 *   outbox: { "<tier>:<floor>": n }, alarm: bool, clockHand: 0..7, task: number
 *   bench: [look], visitors: number, crowdSign: bool, doors: 0|1|2
 *   vault: { fill, low, reserve, runway }
 * Returns { svg, w, h, bands } in output pixels (px per sprite pixel, margin in sprite px).
 */
export function buildingSvg(m, { px = 2, margin = 40, sky = true, plaques = true } = {}) {
  const state = m.state;
  const out = [];
  const W = G.width;
  const totalW = W + margin * 2;
  // Bands, top to bottom.
  const bands = [];
  let y = 0;
  const add = (key, h, extra = {}) => {
    bands.push({ key, y, h, ...extra });
    y += h;
  };
  add("roof", G.roof.h);
  add("penthouse", G.penthouse.h + G.floor.slab);
  const floorsOf = {};
  for (const tier of TIERS) {
    const per = B.rooms[tier].perFloor;
    const desks = m.tiers[tier] ?? [];
    const n = Math.max(1, Math.ceil(desks.length / per));
    floorsOf[tier] = n;
    for (let f = 0; f < n; f++) add(`${tier}:${f}`, G.floor.pitch, { tier, floor: f, desks: desks.slice(f * per, (f + 1) * per) });
  }
  add("lobby", G.lobby.h + G.floor.slab);
  add("street", G.street.h);
  add("basement", G.basement.h + G.floor.slab);
  const groundH = 10;
  const totalH = y + groundH;
  const band = (key) => bands.find((b) => b.key === key);

  const X = (sx) => (margin + sx) * px;
  const Y = (sy) => sy * px;
  const put = (grid, sx, sy, opts) => out.push(gridToSvg(grid, X(sx), Y(sy), px, opts));
  const tile = (name, sx, sy, opts) => put(bake(name), sx, sy, opts);
  const rect = (sx, sy, sw, sh, fill, extra = "") =>
    out.push(`<rect x="${X(sx)}" y="${Y(sy)}" width="${sw * px}" height="${sh * px}" fill="${fill}" ${extra}/>`);
  const text = (sx, sy, str, { size = 12, weight = 600, fill = C.ink, anchor = "start" } = {}) =>
    out.push(`<text x="${X(sx)}" y="${Y(sy)}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(str)}</text>`);
  /** A character frame with its bottom at sy (sprite px), left edge at sx. */
  const char = (frame, sx, bottom, lk = look(0), { mirror = false } = {}) => {
    const { grid, top } = bakeCharacter(frame, lk);
    put(grid, sx, bottom - FRAMES[frame].h + top, { mirror });
  };
  const shadow = (sx, bottom, w = CH.w - 2) => rect(sx + (CH.w - w) / 2, bottom - 1, w, 1, C.bg, `opacity="0.45"`);

  // --- Backdrop: sky, skyline at street level, ground below.
  const streetB = band("street");
  if (sky) {
    out.push(`<rect width="${totalW * px}" height="${totalH * px}" fill="${C.sky}"/>`);
    put(repeat("sky.skyline", totalW, 48), -margin, streetB.y - 48);
  }
  rect(-margin, streetB.y + 14, totalW, totalH - streetB.y - 14, C.ground);

  // --- Roof
  const roof = band("roof");
  const parapetY = roof.y + roof.h - 6;
  put(repeat(`shell.${state}.parapet`, W, 6), 0, parapetY);
  const sign = bake(B.states[state].sign);
  put(sign, G.rooms.x + Math.round((G.rooms.w - sign[0].length) / 2), parapetY - sign.length);
  const tank = bake("roof.tank");
  put(tank, B.roof.tank.x, parapetY - tank.length);
  const machine = bake("roof.machine");
  put(machine, B.roof.machine.x, parapetY - machine.length);

  // --- Shared pieces of a floor band
  const walls = (b, interiorH) => {
    put(repeat(`shell.${state}.wall`, 4, interiorH), 0, b.y);
    put(repeat(`shell.${state}.wall`, 4, interiorH), W - 4, b.y);
  };
  const slab = (b, interiorH) => {
    put(repeat("bldg.slab", G.rooms.w + G.bay.w, G.floor.slab), G.rooms.x, b.y + interiorH);
    tile(`shell.${state}.slab`, 0, b.y + interiorH);
    tile(`shell.${state}.slab`, W - 4, b.y + interiorH);
  };
  const coreFloor = (b, { top = false, tube = true, outlet = true } = {}) => {
    tile(top ? "core.stairs.top" : "core.stairs", G.stairs.x, b.y);
    tile(top ? "core.shaft.top" : "core.shaft", G.shaft.x, b.y);
    if (tube) {
      put(repeat("core.tube", 4, b.h), G.tube.x, b.y);
      if (outlet) tile("core.tube.outlet", B.core.outlet.x, b.y + B.core.outlet.y);
    } else tile("core.tube.cap", G.tube.x - 1, b.y + b.h - 3);
    const lit = m.cab && m.cab.band === b.key ? "core.indicator.down" : "core.indicator.off";
    tile(lit, B.core.indicator.x, b.y + B.core.indicator.y);
    tile(m.alarm ? "wall.alarm.on" : "wall.alarm.off", B.floor.alarm.x, b.y + B.floor.alarm.y);
  };
  const labels = [];
  const effects = [];
  const aisle = (key, bottom) =>
    (m.agents ?? [])
      .filter((a) => a.band === key)
      .sort((a, b) => a.x - b.x)
      .forEach((a) => {
        shadow(a.x, bottom);
        char(a.frame, a.x, bottom, a.look, { mirror: a.mirror });
        if (a.paper) {
          const hand = RIG.frames[a.frame]?.hand ?? [5, 13];
          const hx = a.mirror ? a.x + CH.w - 1 - hand[0] - 4 : a.x + hand[0] - 1;
          put(bake("prop.paper"), hx, bottom - FRAMES[a.frame].h + hand[1] - 3);
        }
      });
  const cabAt = (b) => {
    if (!m.cab || m.cab.band !== b.key) return;
    const interiorH = b.h - G.floor.slab;
    const cx = B.core.cab.x, cy = b.y + interiorH - B.core.cab.floorRow;
    tile("core.cab", cx, cy);
    const riders = m.cab.riders ?? [];
    riders.forEach((lk, i) => char("emp.stand.front", cx + 1 + i * 3 - (riders.length - 1), cy + B.core.cab.floorRow, lk));
    tile(`core.cab.door.${m.cab.doors ?? 0}`, cx, cy);
  };

  // --- Penthouse
  const ph = band("penthouse");
  {
    const ih = G.penthouse.h;
    const P = B.penthouse;
    rect(4, ph.y, W - 8, ih, C.floor.penthouse);
    tile(P.window.tile, P.window.x, ph.y + P.window.y);
    tile(P.shelf.tile, P.shelf.x, ph.y + P.shelf.y);
    tile(P.orgchart.tile, P.orgchart.x, ph.y + P.orgchart.y);
    tile("lobby.plant", 344, ph.y + ih - 28);
    coreFloor(ph, { top: true, tube: false });
    tile(P.chair.tile, P.chair.x, ph.y + P.chair.y);
    tile(P.desk.tile, P.desk.x, ph.y + P.desk.y);
    cabAt(ph);
    if (m.boss) {
      const f = m.boss.frame ?? "boss.smug";
      const bh = FRAMES[f].h;
      shadow(m.boss.x + 1, ph.y + ih);
      put(bake(f), m.boss.x, ph.y + ih - bh, { mirror: m.boss.mirror });
      if (m.boss.bubble) labels.push(() => bubble(m.boss.x + 9, ph.y + ih - bh - 2, m.boss.bubble));
    }
    walls(ph, ih);
    slab(ph, ih);
  }

  // --- Tier floors
  for (const tier of TIERS)
    for (let f = 0; f < floorsOf[tier]; f++) {
      const b = band(`${tier}:${f}`);
      const R = B.rooms[tier];
      const ih = G.floor.h;
      rect(4, b.y, W - 8, ih, C.floor[tier]);
      if (tier === "interns") for (let i = 0; i < 4; i++) tile(`wall.poster.${i % 3}`, G.rooms.x + 54 + i * 72, b.y + B.floor.posters.y);
      coreFloor(b);
      // Bay: cooler, printer, outbox, coffee; clock and whiteboard above.
      tile("bay", G.bay.x, b.y);
      tile("wall.clock", B.floor.clock.x, b.y + B.floor.clock.y);
      tile(`wall.clock.hand.${m.clockHand ?? 0}`, B.floor.clock.x, b.y + B.floor.clock.y);
      tile("wall.whiteboard", B.floor.whiteboard.x, b.y + B.floor.whiteboard.y);
      if (m.task != null)
        labels.push(() => text(B.floor.whiteboard.x + 11, b.y + B.floor.whiteboard.y + 8.5, `DAY ${m.task}`, { size: 4.6 * px, weight: 800, fill: C.bg, anchor: "middle" }));
      const sheets = m.outbox?.[b.key];
      if (sheets) tile(`prop.sheets.${Math.min(6, sheets)}`, B.floor.outboxSheets.x, b.y + B.floor.outboxSheets.y);
      // Rooms.
      for (let i = 0; i < R.perFloor; i++) {
        const rx = G.rooms.x + i * R.w;
        const d = b.desks[i] ?? null;
        tile(`room.${tier}.back`, rx, b.y);
        if (!d) {
          tile(`room.${tier}.empty`, rx, b.y);
          continue;
        }
        const seatX = rx + R.seat;
        const deskTop = b.y + G.floor.deskTop;
        const pose = d.pose ?? "sit";
        const seated = !["away", "laidoff"].includes(pose);
        const frame = { sit: "emp.sit.front", type: "emp.type.0", cheer: "emp.cheer.1", slump: "emp.slump.1" }[pose];
        const side = pose === "type" || !seated;
        const exec = R.chair === "exec";
        const ca = RIG.attach[`chair${exec ? "Exec" : ""}${side ? "Side" : "Front"}`];
        if (pose !== "laidoff") tile(`prop.chair.${exec ? "exec." : ""}${side ? "side" : "front"}`, seatX + ca[0], deskTop - CH.sit + ca[1]);
        if (seated) char(frame, seatX, deskTop, d.look);
        tile(`room.${tier}.front`, rx, b.y);
        tile(`prop.${R.screen}.${pose === "type" ? "on" : "off"}`, rx + R.monitor[0], b.y + R.monitor[1]);
        if (d.paper) tile("prop.paper", rx + R.paper[0], b.y + R.paper[1]);
        if (pose === "laidoff") {
          rect(rx, b.y, R.w, ih, C.floor[tier], `opacity="0.6"`);
          tile("prop.box", rx + R.box[0], b.y + R.box[1]);
        }
        if (d.dot) tile(`fx.dot.${d.dot}`, rx + R.dot[0], b.y + R.dot[1]);
        if (d.isNew) labels.push(() => chip(rx + R.chip[0], b.y + R.chip[1], "NEW"));
        else if (d.streak) labels.push(() => text(rx + R.streak[0] + 1, b.y + R.streak[1] + 5, String(d.streak), { size: 4.5 * px, weight: 700, fill: C.muted }));
        if (d.pay) effects.push(() => text(rx + R.dot[0] + 3, b.y + R.dot[1] - 3, `+${d.pay}`, { size: 4.5 * px, weight: 700, fill: C.good, anchor: "middle" }));
        if (d.you)
          labels.push(() => {
            out.push(`<rect x="${X(seatX - 2)}" y="${Y(deskTop - CH.sit - 2)}" width="${(CH.w + 4) * px}" height="${(CH.sit + 3) * px}" fill="none" stroke="${C.accent}" stroke-width="${px}" rx="${px}"/>`);
            chip(rx + R.plate[0] - 6, b.y + R.plate[1] - 3, "You", { fill: C.accent, ink: C.bg });
          });
      }
      if (tier === "directors") tile("room.directors.wall", G.bay.x - 4, b.y);
      cabAt(b);
      aisle(b.key, b.y + ih);
      walls(b, ih);
      tile(`shell.${state}.window`, W - 4, b.y + 12);
      slab(b, ih);
      if (f === 0) {
        const n = (m.tiers[tier] ?? []).filter(Boolean).length;
        labels.push(() => plaque(b.y, TIER_NAME[tier], `${n} ${n === 1 ? "employee" : "employees"}`));
      }
    }

  // --- Lobby
  const lb = band("lobby");
  {
    const ih = G.lobby.h;
    const L = B.lobby;
    rect(4, lb.y, W - 8, ih, C.floor.lobby);
    coreFloor(lb, { outlet: false });
    tile(L.logo.tile, L.logo.x, lb.y + L.logo.y);
    tile(L.hrDoor.tile, L.hrDoor.x, lb.y + L.hrDoor.y);
    tile(L.cafe.tile, L.cafe.x, lb.y + L.cafe.y);
    for (const p of L.plants) tile(p.tile, p.x, lb.y + p.y);
    tile("lobby.table", L.cafe.table.x, lb.y + L.cafe.table.y);
    for (const sx of L.cafe.stools) tile("lobby.stool", sx, lb.y + ih - 8);
    tile(L.reception.tile, L.reception.x, lb.y + L.reception.y);
    cabAt(lb);
    aisle("lobby", lb.y + ih);
    // Street front: glass bays, then the doors in the bay.
    for (let i = 0; i < 4; i++) tile(`shell.${state}.front`, G.rooms.x + i * 72, lb.y);
    tile(`${B.states[state].doors}.${m.doors ?? 0}`, L.doors.x, lb.y);
    if (m.crowdSign) {
      const s = L.crowdSign;
      labels.push(() => {
        rect(s.x, lb.y + s.y, s.w, s.h, C.ink);
        tile("prop.tape", s.x - 2, lb.y + s.y - 1);
        tile("prop.tape", s.x + s.w - 3, lb.y + s.y - 1);
        text(s.x + s.w / 2, lb.y + s.y + 9, "SIMULATED CROWD", { size: 4.4 * px, weight: 700, fill: C.bg, anchor: "middle" });
        text(s.x + s.w / 2, lb.y + s.y + 16.5, "these employees are bots.", { size: 3.6 * px, weight: 500, fill: C.bg, anchor: "middle" });
      });
    }
    walls(lb, ih);
    slab(lb, ih);
    labels.push(() => plaque(lb.y, "Lobby"));
  }

  // --- Street: the sidewalk in front of the lobby; its characters overlap the lobby.
  {
    const S = B.street;
    put(repeat("street.pavement", totalW, G.street.h), -margin, streetB.y);
    const ground = streetB.y + S.standY;
    tile(S.bench.tile, S.bench.x, streetB.y + S.bench.y);
    const sitters = (m.bench ?? []).slice(0, 4);
    sitters.forEach((lk, i) => char(i % 2 ? "emp.bench.1" : "emp.bench.0", S.bench.seats[i], ground, lk));
    if (sitters.length) tile("prop.box.full", S.bench.seats[sitters.length - 1] + CH.w - 1, streetB.y + S.bench.y + 4 - 9);
    tile(S.lamp.tile, S.lamp.x, streetB.y + S.lamp.y);
    for (let i = 0; i < Math.min(5, m.visitors ?? 0); i++) put(bake(i % 2 ? "emp.visitor.1" : "emp.visitor"), S.queue.spots[i], ground - CH.stand);
    if ((m.visitors ?? 0) > 5) labels.push(() => text(S.queue.spots[4] - 3, ground - 13, `+${m.visitors - 5}`, { size: 11, anchor: "end" }));
    aisle("street", ground);
  }

  // --- Basement
  const bs = band("basement");
  {
    const ih = G.basement.h;
    const V = B.basement;
    rect(4, bs.y, W - 8, ih, C.floor.basement);
    rect(0, bs.y, 4, ih + 4, SPRITE.concreteShade);
    rect(W - 4, bs.y, 4, ih + 4, SPRITE.concreteShade);
    put(repeat("core.tube", 4, V.tubeFoot.y + 2), G.tube.x, bs.y);
    tile(V.tubeFoot.tile, V.tubeFoot.x, bs.y + V.tubeFoot.y);
    tile(V.vaultDoor.tile, V.vaultDoor.x, bs.y + V.vaultDoor.y);
    tile(V.boxes.tile, V.boxes.x, bs.y + V.boxes.y);
    tile(V.bar.tile, V.bar.x, bs.y + V.bar.y);
    const v = m.vault ?? { fill: 0.6 };
    rect(V.bar.x + V.bar.fill.x, bs.y + V.bar.y + V.bar.fill.y, Math.round(V.bar.fill.w * Math.min(1, v.fill)), V.bar.fill.h, v.low ? C.bad : C.coin);
    const pile = bake(`vault.pile.${Math.round(Math.min(1, v.fill) * 5)}`);
    put(pile, V.pile.x, bs.y + V.pile.bottom - pile.length);
    rect(V.partition.x, bs.y, 4, ih, SPRITE.concreteShade);
    for (const r of V.racks) tile(r.tile, r.x, bs.y + r.y);
    rect(0, bs.y, W, 3, SPRITE.concreteShade);
    put(repeat("bldg.slab", W, G.floor.slab), 0, bs.y + ih);
    if (plaques) labels.push(() => {
      text(V.bar.x + 48, bs.y + V.bar.y + 6, v.reserve ?? "Reserve", { size: 11 });
      text(V.bar.x + 48, bs.y + V.bar.y + 6 + 13 / px, v.runway ?? "", { size: 10, weight: 400, fill: v.low ? C.bad : C.muted });
      if (v.low) chip(V.bar.x, bs.y + V.bar.y - 7, "LOW", { fill: C.bad, ink: C.bg });
      plaque(bs.y, "Vault");
      text(V.racks[0].x, bs.y + 11, "Servers", { size: 10, weight: 400, fill: C.muted });
    });
  }

  // --- Effects (coins in flight), then labels over everything.
  for (const c of m.coins ?? []) tile(c.frame ?? "prop.coin.0", c.x, band(c.band).y + c.y);
  effects.forEach((f) => f());
  labels.forEach((f) => f());

  function plaque(by, title, sub) {
    if (!plaques) return;
    const x0 = B.floor.plaque.x + 2, y0 = by + 12;
    const w = Math.max(title.length * 7, (sub ?? "").length * 5.6) + 10;
    out.push(`<rect x="${X(x0) - 4}" y="${Y(y0) - 13}" width="${w}" height="${sub ? 31 : 18}" rx="3" fill="${C.bg}" fill-opacity="0.72"/>`);
    out.push(`<text x="${X(x0)}" y="${Y(y0)}" font-family="${FONT}" font-size="12" font-weight="600" fill="${C.ink}">${esc(title)}</text>`);
    if (sub) out.push(`<text x="${X(x0)}" y="${Y(y0) + 13}" font-family="${FONT}" font-size="10" fill="${C.muted}">${esc(sub)}</text>`);
  }
  function chip(sx, sy, str, { fill = C.ink, ink = C.bg } = {}) {
    const w = str.length * 3.3 + 3;
    out.push(`<rect x="${X(sx)}" y="${Y(sy)}" width="${w * px}" height="${6 * px}" rx="${px}" fill="${fill}"/>`);
    text(sx + w / 2, sy + 4.6, str, { size: 4.6 * px, weight: 700, fill: ink, anchor: "middle" });
  }
  function bubble(tipX, tipY, str) {
    const fs = 12;
    const w = (str.length * fs * 0.53 + 18) / px;
    const h = 24 / px;
    const bx = Math.min(W - 8 - w, Math.max(8, tipX - w / 2)), by = tipY - h - 7 / px * 2;
    const tx = Math.max(bx + 6, Math.min(bx + w - 6, tipX));
    out.push(
      `<rect x="${X(bx)}" y="${Y(by)}" width="${w * px}" height="${h * px}" rx="8" fill="${C.panel}" stroke="${C.accent}" stroke-width="1"/>` +
        `<path d="M${X(tx) - 5} ${Y(by + h) - 0.5}L${X(tipX)} ${Y(tipY)}L${X(tx) + 5} ${Y(by + h) - 0.5}Z" fill="${C.panel}"/>` +
        `<path d="M${X(tx) - 5} ${Y(by + h)}L${X(tipX)} ${Y(tipY)}L${X(tx) + 5} ${Y(by + h)}" fill="none" stroke="${C.accent}" stroke-width="1"/>`,
    );
    out.push(`<text x="${X(bx + w / 2)}" y="${Y(by + h / 2) + 4.2}" font-family="${FONT}" font-size="${fs}" font-weight="500" fill="${C.ink}" text-anchor="middle">${esc(str)}</text>`);
  }

  return { svg: out.join(""), w: totalW * px, h: totalH * px, bands: Object.fromEntries(bands.map((b) => [b.key, b.y])) };
}

// ---------------------------------------------------------------------------
// The sample moment for art/building.png and the brand images: payday on a
// Small office, a few minutes after the results. Illustrative, not live state.

export function sampleModel(state = "office") {
  const S = (i, pose = "sit", extra = {}) => ({ look: look(i), pose, ...extra });
  const tiers = {
    directors: [S(3, "cheer", { dot: "pass", streak: 7, pay: "0.90" }), S(6, "sit", { dot: "pass", streak: 3 }), S(12, "away", { dot: "pass" }), S(27, "sit", { dot: "pass" }), null, null],
    managers: [S(1, "cheer", { dot: "pass", pay: "0.45" }), S(9, "slump", { dot: "miss" }), S(5, "sit", { dot: "pass", streak: 3 }), S(14, "away", { dot: "pass" }), S(2, "sit", { isNew: true }), S(28, "sit", { dot: "pass" }), S(29, "cheer", { dot: "pass", pay: "0.45" }), null, null],
    associates: [S(7, "sit", { dot: "pass", you: true, streak: 4 }), S(4, "laidoff"), S(10, "slump", { dot: "miss" }), S(15, "cheer", { dot: "pass", pay: "0.21" }), S(0, "sit", { dot: "pass" }), S(11, "away", { dot: "pass" }), S(13, "sit"), S(30, "sit", { dot: "pass" }), S(31, "slump", { dot: "miss" }), S(32, "sit"), null, null],
    interns: [S(8, "sit", { dot: "pass" }), S(16, "cheer", { dot: "pass", pay: "0.05" }), S(18, "slump", { dot: "miss" }), S(19, "away"), S(20, "sit", { isNew: true }), S(21, "sit", { dot: "pass" }), null, S(22, "sit"), S(23, "away", { dot: "pass" }), S(33, "sit", { dot: "pass" }), S(34, "cheer", { dot: "pass", pay: "0.05" }), S(35, "sit"), S(36, "sit", { dot: "pass" }), null, S(37, "slump", { dot: "miss" }), S(38, "sit"), null, null],
  };
  if (state === "garage") {
    tiers.directors = tiers.directors.slice(0, 1);
    tiers.managers = tiers.managers.slice(0, 2);
    tiers.associates = tiers.associates.slice(0, 3);
    tiers.interns = tiers.interns.slice(0, 3);
  }
  return {
    state,
    tiers,
    agents: [
      { band: "directors:0", frame: "emp.walk.2", x: 250, look: look(12) },
      { band: "managers:0", frame: "emp.chat.0", x: 318, look: look(14) },
      { band: "managers:0", frame: "emp.chat.1", x: 336, look: look(17), mirror: true },
      { band: "associates:0", frame: "emp.drink.1", x: 340, look: look(11) },
      { band: "associates:0", frame: "emp.carry.0", x: 168, look: look(4), mirror: true },
      { band: "interns:0", frame: "emp.climb.2", x: 8, look: look(19) },
      { band: "interns:0", frame: "emp.stand.side", x: 350, look: look(23) },
      { band: "lobby", frame: "emp.walk.0", x: 120, look: look(24), mirror: true },
    ],
    boss: { frame: "boss.walk.0", x: 238, mirror: true, bubble: "Great work, team. Synergy is up." },
    cab: { band: "associates:0", doors: 1, riders: [] },
    coins: [
      { band: "associates:0", x: 64, y: 17, frame: "prop.coin.1" },
      { band: "associates:0", x: 52, y: 22, frame: "prop.coin.0" },
      { band: "interns:0", x: 44, y: 21, frame: "prop.coin.2" },
    ],
    outbox: { "directors:0": 2, "managers:0": 4, "associates:0": 5, "interns:0": 6 },
    clockHand: 0,
    task: 12,
    bench: [look(25), look(26)],
    visitors: 7,
    crowdSign: true,
    vault: { fill: 0.62, reserve: "Reserve: 184.6 NEAR", runway: "Runway: 19 tasks" },
  };
}

// The other half of the day: a task has just opened (spec §14.3, the rush). No
// result dots or pay; everyone who has not submitted types at the desk (§5.7);
// those who submitted have paper on the desk and may walk to the outbox.
export function workingModel(state = "tower") {
  const m = sampleModel(state);
  let k = 0;
  for (const tier of TIERS)
    m.tiers[tier] = m.tiers[tier].map((d) => {
      if (!d) return d;
      if (d.pose === "laidoff") return d;
      const submitted = k++ % 3 === 1;
      return { look: d.look, pose: submitted && k % 2 ? "away" : "type", paper: submitted, isNew: d.isNew, you: d.you, streak: d.streak };
    });
  m.agents = [
    { band: "managers:0", frame: "emp.walk.2", x: 300, look: look(14), paper: true },
    { band: "interns:0", frame: "emp.walk.0", x: 318, look: look(19), paper: true },
    { band: "associates:0", frame: "emp.stand.side", x: 346, look: look(11) },
  ];
  m.coins = [];
  m.cab = null;
  m.alarm = true;
  m.clockHand = 0;
  m.task = 13;
  m.outbox = { "managers:0": 1, "associates:0": 2, "interns:0": 1 };
  m.boss = { frame: "boss.point", x: 200, bubble: "Per my last memo: decode today’s word." };
  return m;
}
