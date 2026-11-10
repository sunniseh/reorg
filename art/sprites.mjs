// REORG character and prop sprites, drawn as ASCII pixel maps, plus the rig the
// renderer needs to place them. Building tiles live in building.mjs; both end up
// in the one atlas (build.mjs).
//
// TODO(art): placeholder art. Replace with the final art before launch; keep the
// frame names, layers and RIG below (or change the renderer and Design Spec §5
// together) so new art drops in without code changes. See art/README.md.
//
// One character = up to three stacked sprites from the same atlas, all the same
// size and anchor, so the renderer only sets textures and tints:
//   base   fixed colors (skin, face, trousers, props)
//   shirt  grayscale, tinted with the body token from the wallet hash
//   hair   grayscale, tinted with a hair color from the wallet hash
// See docs/design/REORG Design Spec.md §5.

import { C, SPRITE } from "./palette.mjs";
import { multiply } from "./lib.mjs";
import { layers, stack, paint, pad, shift, outline, blank } from "./pixmap.mjs";
import { TILES, BUILDING } from "./building.mjs";

// ---------------------------------------------------------------------------
// Employee: 12 px wide, 20 tall standing, 15 seated (ROADMAP D23: small enough
// for 6/9/12/18 desks a floor). The head sits in rows 0-8 of every pose (row 0
// is empty); a pose that moves the head says so in RIG.frames[name].headY, and
// the hair sprite moves with it. Faces right in profile; mirror to face left.

const CHAR_W = 12;
const SIT_H = 15;
const STAND_H = 20;

const HEAD_FRONT = [
  "............",
  "...SSSSSS...",
  "..SSSSSSSS..",
  "..SSSSSSSS..",
  ".sSkSSSSkSs.",
  ".sSkSSSSkSs.",
  "..SSSkkSSS..",
  "...sSSSSs...",
  "....ssss....",
];

// Looking down: eyes closed, a small frown (slump, the bench).
const HEAD_DOWN = paint(HEAD_FRONT, [".sSSSSSSSSs.", ".sSkkSSkkSs.", "..SSSSSSSS..", "...sSkkSs..."], 4);

// Eyes shut, mouth open: the yawn of a stretch.
const HEAD_YAWN = paint(HEAD_FRONT, [".sSSSSSSSSs.", ".sSkkSSkkSs.", "..SSSkkSSS..", "...sSkkSs..."], 4);

// Big open smile (cheer).
const HEAD_JOY = paint(HEAD_FRONT, ["..SSkkkkSS..", "...skkkks..."], 6);

const HEAD_SIDE = [
  "............",
  "...SSSSS....",
  "..SSSSSSS...",
  "..SSSSSSSS..",
  "..SSsSSSkS..",
  "..SSsSSSkSS.",
  "..SSSSSSSkS.",
  "...sSSSSSS..",
  "....sssss...",
];
const HEAD_SIDE_TALK = paint(HEAD_SIDE, ["..SSSSSSSSkk"], 6);

// Seated, facing the viewer. Rows 9-14; the desk covers everything below.
const TORSO_SIT_FRONT = [
  "..wWcsscWw..",
  ".wWWWkkWWWw.",
  "wWwWWkkWWwWw",
  "wWwWWkkWWwWw",
  "wWwWWWWWWwWw",
  "SSwWWWWWWwSS",
];

// Seated front with the arms lifted off the sides (cheer, stretch).
const TORSO_SIT_ARMS_UP = [
  "..wWcsscWw..",
  ".wWWWkkWWWw.",
  ".wWWWkkWWWw.",
  ".wWWWkkWWWw.",
  ".wWWWWWWWWw.",
  ".wWWWWWWWWw.",
];

// Seated in profile, typing (two frames).
const TORSO_TYPE = [
  ["...wWWWcc...", "..wWWWWWck..", "..wWwWWWWW..", "..wWwWWWWWSS", "..wWWwwwww..", "..wWWWWWWW.."],
  ["...wWWWcc...", "..wWWWWWck..", "..wWwWWWW.SS", "..wWwWWWWWW.", "..wWWwwwww..", "..wWWWWWWW.."],
];

// Seated in profile, leaning back, hand at the chin: thinking (P1).
const TORSO_THINK = ["..wWWWcc....", ".wWWWWWck...", ".wWWWWWWW...", ".wWWWwwwSS..", ".wWWWWWwW...", ".wWWWWWWW..."];

// Standing in profile: torso rows 9-14 (the last row is the belt).
const TORSO_STAND_SIDE = ["...wWWWcc...", "..wWWWWWck..", "..wWWWWWWW..", "..wWWWWWWW..", "..wWWWWWWW..", "..PPPPPPPP.."];

// The near arm, painted over the torso at row 10 (row 9 when the body bobs up).
const ARM = {
  down: [".....w......", ".....w......", ".....w......", ".....SS....."],
  fwd: [".....w......", "......w.....", ".......w....", "........wSS."],
  back: [".....w......", "....w.......", "..ww........", "SS.........."],
  // Bent, holding a cup at the chest (drink).
  cup: [".....w......", ".....w..cc..", ".....wwwSc..", "............"],
  // Raised to the mouth: starts at row 5, not at the shoulder.
  sip: { row: 5, rows: ["..........cc", ".........Scc", "........w...", ".......w....", "......w.....", ".....w......"] },
  // Talking hand, palm up, two heights (chat).
  talk0: [".....w......", ".....w......", ".....wwwSS..", "........S..."],
  talk1: [".....w......", ".....w...SS.", ".....w..wS..", ".....www...."],
};

// Legs: the near leg is P, the far leg is p (a shade darker), so the stride reads.
// Contact frames are 5 rows (body low); passing frames are 6 rows (body up 1 px).
const LEGS = {
  // Near leg forward, far leg back.
  contactA: ["..ppPPPPP...", "..pp...PP...", ".pp.....PP..", ".pp......PP.", "kk.......kkk"],
  // Near leg back, far leg forward.
  contactB: ["..PPpppppp..", "..PP...pp...", ".PP.....pp..", ".PP......pp.", "kk.......kkk"],
  passA: ["..PPPPPPPP..", "...ppPPPP...", "...ppPPP....", "..ppkPPP....", "..kk.PPP....", ".....kkkkk.."],
  passB: ["..PPPPPPPP..", "...PPpppp...", "...PPppp....", "..PPkppp....", "..kk.ppp....", ".....kkkkk.."],
  stand: ["...ppPPPP...", "...ppPPP....", "...ppPPP....", "...ppPPP....", "...kkkkkkk.."],
  // Climbing: the near knee up onto the next step, or the far one.
  climbA: ["..ppPPPPPP..", "..pp....PP..", ".ppp....kkk.", ".pp.........", "kkk........."],
  climbB: ["..PPpppppp..", "..PP....pp..", ".PPP....kkk.", ".PP.........", "kkk........."],
};

/** A standing profile frame: STAND_H rows, bottom at the feet. `up` lifts the body 1 px. */
function standSide({ arm = "down", legs = "stand", head = HEAD_SIDE, up = false }) {
  const body = stack(head, TORSO_STAND_SIDE);
  const rows = up ? stack(body.slice(1), LEGS[legs]) : stack(body, LEGS[legs]);
  if (rows.length !== STAND_H) throw new Error(`standSide: ${rows.length} rows`);
  const a = ARM[arm];
  return paint(rows, a.rows ?? a, (a.row ?? 10) - (up ? 1 : 0));
}

// Holding the box on the way out: arms forward, a plant in the box.
const CARRY = [".........gG.", "........gGgG", ".......BBBBB", ".......bBBBB", ".....wwSBBBB", ".......BBBBB", ".......bbbbb"];
function carrySide(legs, up) {
  const body = stack(HEAD_SIDE, TORSO_STAND_SIDE);
  const rows = up ? stack(body.slice(1), LEGS[legs]) : stack(body, LEGS[legs]);
  return paint(rows, CARRY, up ? 7 : 8);
}

// Standing, facing the viewer: idle, waiting, riding the elevator; and the
// source of the visitor outline.
const STAND_FRONT_BODY = [
  "..wWcsscWw..",
  ".wWWWkkWWWw.",
  "wWwWWkkWWwWw",
  "wWwWWkkWWwWw",
  "SwwWWWWWWwwS",
  "S.PPPPPPPP.S",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  ".kkkk..kkkk.",
];
const STAND_FRONT = stack(HEAD_FRONT, STAND_FRONT_BODY);
// Weight on one leg, hip out: the visitor's shuffle.
const STAND_FRONT_SHIFT = stack(shift(stack(HEAD_FRONT, STAND_FRONT_BODY.slice(0, 7)), 1, 0), [
  "..PPP..PPP..",
  "..PPP...PPP.",
  "..PPP...PPP.",
  ".kkkk...kkkk",
]);

// Seated on the street bench, legs showing, box beside (laid off).
const BENCH_BODY = [
  "..wWcsscWw..",
  ".wWWWkkWWWw.",
  "wWwWWkkWWwWw",
  "wWwWWWWWWwWw",
  "wSSPPPPPPSSw",
  ".PPPPPPPPPP.",
  ".pPPPPPPPPp.",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  ".kkkk..kkkk.",
];

// ---------------------------------------------------------------------------
// Seated front variants (12 x 15, ending at the desk top).

const SIT_FRONT = stack(HEAD_FRONT, TORSO_SIT_FRONT);

/** Head lowered by dy rows, sunk into the shoulders. */
const headDown = (head, dy) => stack(blank(CHAR_W, dy), head, TORSO_SIT_FRONT.slice(dy));

// Cheer: arms bent up, then straight up (2 frames, 0.6 s, once).
const CHEER = [
  paint(stack(HEAD_JOY, TORSO_SIT_ARMS_UP), ["S..........S", "W..........W", "W..........W", "Ww........wW", "Ww........wW", ".w........w."], 5),
  paint(stack(HEAD_JOY, TORSO_SIT_ARMS_UP), ["S..........S", ...Array(8).fill("W..........W"), "Ww........wW", ".w........w."], 0),
];

// Stretch (P1): arms out, then up, eyes shut.
const STRETCH = [
  paint(stack(HEAD_YAWN, TORSO_SIT_ARMS_UP), ["S..........S", "W..........W", ".W........W.", "..w......w.."], 6),
  paint(stack(HEAD_YAWN, TORSO_SIT_ARMS_UP), [".SS......SS.", ".Ww......wW.", ".Ww......wW."], 0),
];

// Sitting down: one squashed frame, head down 1 px, shoulders out (§14.1).
const SIT_LAND = stack(blank(CHAR_W, 1), HEAD_FRONT, [".wWWcsscWWw.", "wWWWWkkWWWWw", "wWwWWkkWWwWw", "wWwWWWWWWwWw", "SSwWWWWWWwSS"]);

// ---------------------------------------------------------------------------
// Hair. Same 12 px grid as the heads; `y` is the row offset from the head
// origin (negative = above the frame top). "none" draws nothing.

const HAIR = {
  short: {
    front: { y: 0, rows: ["...HHHHHH...", "..HHHHHHHH..", ".HHHhHHHHHH.", ".HH......HH."] },
    side: { y: 0, rows: ["...HHHHH....", "..HHHHHHH...", ".HHHHHHHHh..", ".HHHH.......", ".HHH........", "..hH........"] },
  },
  long: {
    front: {
      y: 0,
      rows: ["...HHHHHH...", "..HHHHHHHH..", ".HHHhHHhHHH.", ".HH......HH.", ".HH......HH.", ".HH......HH.", ".hH......Hh.", ".hh......hh.", ".hh......hh."],
    },
    side: { y: 0, rows: ["...HHHHH....", "..HHHHHHH...", ".HHHHHHHHh..", ".HHHHH......", ".HHHH.......", ".HHHH.......", ".HHHh.......", ".hHh........", ".hh........."] },
  },
  bun: {
    front: { y: -2, rows: ["....HHHH....", "....HhhH....", "...HHHHHH...", "..HHHHHHHH..", ".HHHHHHHHHH.", ".HH......HH."] },
    side: { y: -2, rows: [".HH.........", "HhhH........", ".HHHHHH.....", "..HHHHHHH...", ".HHHHHHHHh..", ".HHH........", ".HH........."] },
  },
  curly: {
    front: { y: -1, rows: ["..H.HH.HH.H.", ".HhHHhHHhHH.", "HHHHHHHHHHHH", "HhHHHHHHHHhH", "HHH......HHH", ".hH......Hh.", "..h......h.."] },
    side: { y: -1, rows: ["...H.HH.H...", "..HhHHhHH...", ".HHHHHHHHH..", "HHhHHHHHHHH.", "HHHHHhHHHh..", "HhHHH.......", "HHHH........", ".hH........."] },
  },
};


export const HAIR_STYLES = ["short", "long", "bun", "curly", "none"];

// ---------------------------------------------------------------------------
// The boss: 18 px wide, accent blazer, silver hair, lanyard, mug.
// Three faces (spec §17.1): smug >= 90% pass rate, forced smile 50-89%, twitchy below.
// He keeps the original 16 px head and legs, so he stands a head taller than the
// 12 px staff (and the brand icon, drawn from him, does not change).
const BIG_HEAD_FRONT = [
  "................",
  "....SSSSSSSS....",
  "...SSSSSSSSSS...",
  "...SSSSSSSSSS...",
  "...SSSSSSSSSS...",
  "..sSSkSSSSkSSs..",
  "..sSSkSSSSkSSs..",
  "...SSSSSSSSSS...",
  "...SSSSkkSSSS...",
  "....sSSSSSSs....",
  ".....ssssss.....",
  "......ssss......",
];

const BIG_HEAD_SIDE = [
  "................",
  "....SSSSSSS.....",
  "...SSSSSSSSS....",
  "...SSSSSSSSSS...",
  "...SSSSSSSSSS...",
  "...SSSsSSSkSS...",
  "...SSSsSSSkSSS..",
  "...SSSSSSSSSSS..",
  "...SSSSSSSSkS...",
  "....sSSSSSSS....",
  ".....sssssss....",
  "......sss.......",
];

const BIG_LEGS = {
  // Near leg forward, far leg back.
  contactA: [
    "...pppPPPPPP....",
    "..ppp...PPP.....",
    "..pp.....PPP....",
    ".ppp......PPP...",
    ".pp........PP...",
    "kk.........kkkk.",
  ],
  // Near leg back, far leg forward.
  contactB: [
    "...PPPppppppp...",
    "..PPP...ppp.....",
    "..PP.....ppp....",
    ".PPP......ppp...",
    ".PP........pp...",
    "kk.........kkkk.",
  ],
  passA: [
    "...PPPPPPPPP....",
    "....ppPPPPP.....",
    "....ppPPPP......",
    "....ppPPPP......",
    "...ppkPPPP......",
    "...kk.PPPP......",
    "......kkkkkk....",
  ],
  passB: [
    "...PPPPPPPPP....",
    "....PPppppp.....",
    "....PPpppp......",
    "....PPpppp......",
    "...PPkpppp......",
    "...kk.pppp......",
    "......kkkkkk....",
  ],
  stand: [
    "....ppPPPPP.....",
    "....ppPPPP......",
    "....ppPPPP......",
    "....ppPPPP......",
    "....ppPPPP......",
    "....kkkkkkkk....",
  ],
};

const mirror18 = (halves) => halves.map((h) => h + [...h].reverse().join(""));

const BOSS_BODY = stack(
  pad(BIG_HEAD_FRONT, 1, 1),
  mirror18([
    "....AAAcs",
    "...AAAAck",
    "..AAAAack",
    ".AAAAAack",
    ".AAAAAAck",
    ".AaAAAAck",
    ".AaAAAAAk",
    ".AaAAAAAA",
    ".SaAAAAAA",
    "..PPPPPPP",
    "..PPPPPPP",
    "...PPPP..",
    "...PPPP..",
    "...PPPP..",
    "...PPPP..",
    "..kkkkk..",
  ]),
);

const BOSS_HAIR = [
  "....mmmmmmmmmm....",
  "...mmmmmmmmmmmm...",
  "...mmmlmmmmmmmm...",
  "...mmmlmmmmmmmm...",
  "...m..........m...",
];

// Lanyard and badge on the left, mug held in the right hand. Starts at row 13.
const BOSS_PROPS = [
  ".......c..........",
  "......c...........",
  "......c...........",
  ".....ccc.....bbb..",
  ".....ckc.....cccm.",
  ".....ccc....Scccm.",
  ".............ccc..",
  "................A.",
];

// Face overlays start at row 4 (brows), eyes on rows 5-6, mouth on rows 8-9.
const FACES = {
  smug: [
    "..................",
    "......S....k......",
    ".....kk....S......",
    "............k.....",
    ".........kkk......",
    "..................",
  ],
  smile: [
    "......k......k....",
    "......k....k......",
    "......k....k......",
    "..................",
    ".......kcccck.....",
    "........kkkk......",
  ],
  twitchy: [
    "...........kk.....",
    ".....kk....S......",
    ".....kk....k......",
    "...............c..",
    ".......kkkkk...c..",
    ".......k...k......",
  ],
};

function bossFace(face) {
  const clearFace = [
    "..................",
    "......S....S......",
    "......S....S......",
    "..................",
    "........SS........",
    "..................",
  ];
  let rows = paint(BOSS_BODY, clearFace, 4);
  rows = paint(rows, FACES[face], 4);
  rows = paint(rows, BOSS_HAIR, 0);
  rows = paint(rows, BOSS_PROPS, 13);
  return rows;
}

// The boss in profile (18 x 28): walking the penthouse with the mug, pointing,
// sipping. The silver hair is part of the base layer, as on the front frames.
const BOSS_HAIR_SIDE = [
  ".....mmmmmmm......",
  "....mmmmmmmmm.....",
  "...mmmmmmmmmmm....",
  "...mmmlmmmmmmm....",
  "...mmmmmm.........",
  "...mmmm...........",
  "....mm............",
];
const BOSS_HEAD_SIDE = paint(paint(pad(BIG_HEAD_SIDE, 1, 1), BOSS_HAIR_SIDE, 0), ["...........kk....."], 4);
const BOSS_TORSO_SIDE = [
  ".....AAAAAcc......",
  "....AAAAAAAck.....",
  "....AAAAAAAAk.....",
  "....AaAAAAAAAk....",
  "....AaAAAAAAA.....",
  "....AaAAAAAAA.....",
  "....AaAAAAAAA.....",
  "....AaAAAAAAA.....",
  "....AAAAAAAAA.....",
  "....PPPPPPPPP.....",
];
const BOSS_ARM = {
  // Mug carried at the chest.
  mug: ["......a...........", "......a...........", "......a....bbb....", "......a....cccm...", "......aaaaScccm...", "...........ccc...."],
  // Arm straight out, index finger: "You."
  point: ["......a...........", ".......aaaaaaaaSS.", "...............S..", "..................", "..................", ".................."],
  // Mug at the mouth.
  sip: { row: 7, rows: ["............bbb...", "...........Scccm..", "..........a.ccc...", ".........a........", "........a.........", ".......a..........", "......a..........."] },
};
const pad18 = (rows) => pad(rows, 1, 1);
function bossSide(arm, legs, up = false) {
  // 12 head + 10 torso + 6 legs = 28; passing legs are 7 rows with the body 1 px up.
  const body = stack(BOSS_HEAD_SIDE, BOSS_TORSO_SIDE);
  const rows = up ? stack(body.slice(1), pad18(BIG_LEGS[legs])) : stack(body, pad18(BIG_LEGS[legs]));
  if (rows.length !== 28) throw new Error(`bossSide: ${rows.length} rows`);
  const a = BOSS_ARM[arm];
  return paint(rows, a.rows ?? a, (a.row ?? 13) - (up ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Props and effects

const CHAIR_FRONT = ["..llllllllll..", ...Array(6).fill(".llllllllllll.")];

const CHAIR_SIDE = [".ll..", ...Array(5).fill("lll.."), "lllll"];

// Executive chair: taller, leather (Directors and the boss).
const CHAIR_EXEC_FRONT = [
  "...eeeeeeee...",
  "..eeeeeeeeee..",
  ".eeeeeeeeeeee.",
  ".eebeeeeeebee.",
  ".eeeeeeeeeeee.",
  ".eebeeeeeebee.",
  ".eeeeeeeeeeee.",
  ".eeeeeeeeeeee.",
  ".eeeeeeeeeeee.",
];
const CHAIR_EXEC_SIDE = ["ee...", ...Array(7).fill("eee.."), "eeeee"];

// Monitor in profile: the screen faces left, toward the seated character.
const monitor = (q) => ["QZZ..", "QQZZ.", "QQTZ.", "QQTZ.", "QQZZ.", "..TZ.", ".TTTZ"].map((r) => r.replaceAll("Q", q));

// Interns get laptops: lid open toward the seated character.
const laptop = (q) => ["...TT", "..QT.", "..QT.", ".QT..", "tttT."].map((r) => r.replaceAll("Q", q));

// Submitted: a sheet with a muted RECEIVED stamp. 5 x 6.
const PAPER = ["ccccc", "clllc", "ccccc", "cmmmc", "cmcmc", "cmmmc"];
const SWEAT = [".c.", "ccc", "ccc", ".c."];
// The laid-off desk: the box outline (spec §5.3).
const BOX = ["cccccccc", "c.c..c.c", "cccccccc", "c......c", "c......c", "cccccccc"];
// The packed box with the desk plant, set beside a character on the bench.
const BOX_FULL = [
  "...gG.....",
  "..gGgG....",
  ".gGgGg....",
  "BBBBBBBBBB",
  "bBBBbbBBBb",
  "BBBBBBBBBB",
  "BBBBBBBBBB",
  "BBBBBBBBBB",
  "bbbbbbbbbb",
];
// Desk plant: Directors keep one; a promotion carries it to the new desk.
const PLANT = ["..gG..", ".gGgG.", "gGgGgG", ".GgGg.", "..G...", ".BBBB.", ".BBBB.", ".bbbb."];
const COIN = [
  [".YYYY.", "YYyyYY", "YyYYyY", "YyYYyY", "YYyyYY", ".YYYY."],
  ["..YY..", ".YyYY.", ".YyYY.", ".YyYY.", ".YyYY.", "..YY.."],
  ["..Yy..", "..Yy..", "..Yy..", "..Yy..", "..Yy..", "..Yy.."],
  ["..YY..", ".YYyY.", ".YYyY.", ".YYyY.", ".YYyY.", "..YY.."],
];
// Coin landing on a desk: the squash frame (§14.2, the one allowed bounce).
const COIN_SQUASH = ["........", ".YYYYYY.", "YYyyyyYY", ".YYYYYY."];

// Result dots at the desk's top-right (§5.4): check on coin, cross on bad.
const DOT_PASS = ["..YYY..", ".YYYYY.", "YYYYYkY", "YkYYkYY", "YYkkYYY", ".YYYYY.", "..YYY.."];
const DOT_MISS = ["..EEE..", ".EEEEE.", "EEkEkEE", "EEEkEEE", "EEkEkEE", ".EEEEE.", "..EEE.."];

// Flame aura (P1): one size per streak milestone reached, 2 flicker frames each.
const FLAME = [
  [
    ["..Y...", ".YYy..", ".YyY..", "YyEYY.", ".YEY..", "......"],
    ["...Y..", "..yYY.", ".YyY..", ".YYEYy", "..YEY.", "......"],
  ],
  [
    ["...Y....", "..YY..Y.", ".YyYY.YY", ".YYEyYy.", "YyEEEYY.", ".YYEEY..", "..YYY..."],
    ["....Y...", ".Y..YY..", "YY.YYyY.", ".yYyEYY.", ".YYEEEyY", "..YEEYY.", "...YYY.."],
  ],
  [
    ["....Y.....", "..Y.YY..Y.", ".YY.YyY.YY", ".YyYYEYYy.", "YYEEyEEYY.", ".YEEEEEEY.", "..YEEEEY..", "...YYYY..."],
    [".....Y....", ".Y..YY.Y..", "YY.YyY.YY.", ".yYYEYYyY.", ".YYEEyEEYY", ".YEEEEEEY.", "..YEEEEY..", "...YYYY..."],
  ],
];

// ---------------------------------------------------------------------------
// Frames

const RAW = {
  // Seated, front
  "emp.sit.front": SIT_FRONT,
  "emp.sit.land": SIT_LAND,
  "emp.cheer.0": CHEER[0],
  "emp.cheer.1": CHEER[1],
  "emp.slump.0": headDown(HEAD_DOWN, 1),
  "emp.slump.1": headDown(HEAD_DOWN, 2),
  "emp.stretch.0": STRETCH[0],
  "emp.stretch.1": STRETCH[1],
  // Seated, profile
  "emp.type.0": stack(HEAD_SIDE, TORSO_TYPE[0]),
  "emp.type.1": stack(HEAD_SIDE, TORSO_TYPE[1]),
  "emp.sit.side": stack(shift(HEAD_SIDE, -1, 0), TORSO_THINK),
  // Standing, front
  "emp.stand.front": STAND_FRONT,
  "emp.bench.0": stack(HEAD_DOWN, BENCH_BODY),
  "emp.bench.1": stack(HEAD_FRONT, BENCH_BODY),
  // Standing and moving, profile
  "emp.stand.side": standSide({}),
  "emp.walk.0": standSide({ arm: "back", legs: "contactA" }),
  "emp.walk.1": standSide({ arm: "down", legs: "passA", up: true }),
  "emp.walk.2": standSide({ arm: "fwd", legs: "contactB" }),
  "emp.walk.3": standSide({ arm: "down", legs: "passB", up: true }),
  "emp.carry.0": carrySide("contactA", false),
  "emp.carry.1": carrySide("passA", true),
  "emp.carry.2": carrySide("contactB", false),
  "emp.carry.3": carrySide("passB", true),
  "emp.climb.0": standSide({ arm: "back", legs: "climbA" }),
  "emp.climb.1": standSide({ arm: "down", legs: "passA", up: true }),
  "emp.climb.2": standSide({ arm: "fwd", legs: "climbB" }),
  "emp.climb.3": standSide({ arm: "down", legs: "passB", up: true }),
  "emp.drink.0": standSide({ arm: "cup" }),
  "emp.drink.1": standSide({ arm: "sip" }),
  "emp.chat.0": standSide({ arm: "talk0", head: HEAD_SIDE_TALK }),
  "emp.chat.1": standSide({ arm: "talk1" }),
  // Visitors: outlines only, never filled (§4.5)
  "emp.visitor": outline(STAND_FRONT, "D"),
  "emp.visitor.1": outline(STAND_FRONT_SHIFT, "D"),
  // The boss
  "boss.smug": bossFace("smug"),
  "boss.smile": bossFace("smile"),
  "boss.twitchy": bossFace("twitchy"),
  "boss.stand.side": bossSide("mug", "stand"),
  "boss.walk.0": bossSide("mug", "contactA"),
  "boss.walk.1": bossSide("mug", "passA", true),
  "boss.walk.2": bossSide("mug", "contactB"),
  "boss.walk.3": bossSide("mug", "passB", true),
  "boss.point": bossSide("point", "stand"),
  "boss.sip": bossSide("sip", "stand"),
  // Props
  "prop.chair.front": CHAIR_FRONT,
  "prop.chair.side": CHAIR_SIDE,
  "prop.chair.exec.front": CHAIR_EXEC_FRONT,
  "prop.chair.exec.side": CHAIR_EXEC_SIDE,
  "prop.monitor.off": monitor("k"),
  "prop.monitor.on": monitor("V"),
  "prop.monitor.flash": monitor("c"),
  "prop.laptop.off": laptop("k"),
  "prop.laptop.on": laptop("V"),
  "prop.laptop.flash": laptop("c"),
  "prop.paper": PAPER,
  "prop.box": BOX,
  "prop.box.full": BOX_FULL,
  "prop.plant": PLANT,
  "prop.coin.land": COIN_SQUASH,
  ...Object.fromEntries(COIN.map((f, i) => [`prop.coin.${i}`, f])),
  "fx.sweat": SWEAT,
  "fx.dot.pass": DOT_PASS,
  "fx.dot.miss": DOT_MISS,
  ...Object.fromEntries(FLAME.flatMap((lv, i) => lv.map((f, j) => [`fx.flame.${i + 1}.${j}`, f]))),
  ...Object.fromEntries(
    Object.entries(HAIR).flatMap(([style, views]) =>
      Object.entries(views).map(([view, h]) => [`hair.${style}.${view}`, h.rows]),
    ),
  ),
  // Building tiles (A-01)
  ...TILES,
};

/** name -> { w, h, layers: { base?, shirt?, hair? } } */
export const FRAMES = Object.fromEntries(Object.entries(RAW).map(([k, rows]) => [k, layers(k, rows)]));

// ---------------------------------------------------------------------------
// Rig: everything the renderer needs besides the textures.

// Per character frame: which hair view to use and how far the head moved.
const FRONT = { view: "front", headY: 0 };
const SIDE = { view: "side", headY: 0 };
const frameInfo = {
  "emp.sit.front": FRONT,
  "emp.sit.land": { view: "front", headY: 1 },
  "emp.cheer.0": FRONT,
  "emp.cheer.1": FRONT,
  "emp.slump.0": { view: "front", headY: 1 },
  "emp.slump.1": { view: "front", headY: 2 },
  "emp.stretch.0": FRONT,
  "emp.stretch.1": FRONT,
  "emp.type.0": SIDE,
  "emp.type.1": SIDE,
  "emp.sit.side": { view: "side", headY: 0, headX: -1 },
  "emp.stand.front": FRONT,
  "emp.bench.0": FRONT,
  "emp.bench.1": FRONT,
  "emp.stand.side": SIDE,
  "emp.drink.0": SIDE,
  "emp.drink.1": SIDE,
  "emp.chat.0": SIDE,
  "emp.chat.1": SIDE,
};
for (const a of ["walk", "carry", "climb"])
  for (let i = 0; i < 4; i++) frameInfo[`emp.${a}.${i}`] = { view: "side", headY: i % 2 ? -1 : 0 };

// Hand attach points for carried paper (§5.2 "Carry paper"), from the frame's
// top-left. Walking swings the hand; the sheet swings with it.
const hand = {
  "emp.stand.side": [5, 13],
  "emp.walk.0": [0, 13],
  "emp.walk.1": [5, 12],
  "emp.walk.2": [10, 13],
  "emp.walk.3": [5, 12],
  "emp.climb.0": [0, 13],
  "emp.climb.1": [5, 12],
  "emp.climb.2": [10, 13],
  "emp.climb.3": [5, 12],
};

export const RIG = {
  units: "Sprite pixels. Anchor every character frame at its bottom center.",
  // Employee frame size: seated frames end at the desk top, standing ones at the feet.
  character: { w: CHAR_W, sit: SIT_H, stand: STAND_H },
  tint: {
    shirt: "body token: sha256(utf8(wallet))[0] mod 8 (spec §5.1)",
    hair: "hair color: sha256(utf8(wallet))[2] mod 6; style: sha256(utf8(wallet))[1] mod 5 in hairStyles order ('none' draws no hair)",
  },
  hairStyles: HAIR_STYLES,
  poses: {
    "emp.sit.front": { view: "front", use: "Seated at the desk, between tasks; new hire" },
    "emp.sit.land": { view: "front", use: "One frame on sitting down (the squash, §14.1), then emp.sit.front" },
    "emp.type": { view: "side", use: "Working: turned to the monitor while a task is open" },
    "emp.cheer": { view: "front", use: "Seated, passed at results or paid on payday; 0.6 s, once" },
    "emp.slump": { view: "front", use: "Seated, missed at results; 0.6 s, once, then hold frame 1 for 1 s" },
    "emp.sit.side": { view: "side", use: "P1 idle at the desk: leaning back, thinking" },
    "emp.stretch": { view: "front", use: "P1 idle at the desk" },
    "emp.stand.front": { view: "front", use: "Standing still facing out: waiting, riding the elevator" },
    "emp.stand.side": { view: "side", use: "Standing in profile: at the printer, the window, waiting for the elevator" },
    "emp.walk": { view: "side", use: "Walking (24 px/s, 8 fps); running is emp.run, the same frames at 48 px/s, 16 fps" },
    "emp.carry": { view: "side", use: "Layoff walk-out with the box and the desk plant" },
    "emp.climb": { view: "side", use: "Climbing a flight of stairs (1.6 s per floor); mirror on the flights that rise to the left" },
    "emp.drink": { view: "side", use: "At the water cooler or the coffee machine" },
    "emp.chat": { view: "side", use: "Water-cooler chat; partners face each other (one mirrored)" },
    "emp.bench": { view: "front", use: "Laid off: on the street bench with prop.box.full beside; frame 0 head down, frame 1 looking up" },
    "emp.visitor": { view: "front", use: "Visitor in the sidewalk queue; outline only, never filled (animation emp.visitor.shuffle)" },
    "boss.smug|smile|twitchy": { view: "front", use: "Penthouse, standing; face from the latest pass rate (§17.1)" },
    "boss.walk": { view: "side", use: "Pacing the penthouse, coming down for a layoff; carries the mug" },
    "boss.point": { view: "side", use: "Pointing at the employee being laid off" },
    "boss.sip": { view: "side", use: "Penthouse idle: a sip from the mug" },
  },
  // Per character frame: hair view, head offset (rows; headX in columns), hand point.
  frames: Object.fromEntries(
    Object.entries(frameInfo).map(([k, v]) => [k, { ...v, ...(hand[k] ? { hand: hand[k] } : {}) }]),
  ),
  hair: Object.fromEntries(
    Object.entries(HAIR).map(([style, v]) => [style, { front: { y: v.front.y }, side: { y: v.side.y } }]),
  ),
  attach: {
    // Offsets from the character frame's top-left, in sprite pixels.
    sweat: { "emp.sit.front": [10, 1], "emp.type": [1, 2] },
    flame: "centered on the character, the flame's bottom on the character's row 9 (shoulders), drawn behind the character",
    chairFront: [-1, 8],
    chairSide: [0, 8],
    chairExecFront: [-1, 6],
    chairExecSide: [0, 6],
    bench: "emp.bench frames stand on the ground line like standing frames; prop.box.full sits on the bench seat beside them",
  },
  desk: "Seated frames end at the desk top. Draw the room back, the chair, the character, then room.<tier>.front.",
  animations: {
    "emp.type": { frames: ["emp.type.0", "emp.type.1"], fps: 4 },
    "emp.walk": { frames: ["emp.walk.0", "emp.walk.1", "emp.walk.2", "emp.walk.3"], fps: 8 },
    "emp.run": { frames: ["emp.walk.0", "emp.walk.1", "emp.walk.2", "emp.walk.3"], fps: 16 },
    "emp.carry": { frames: ["emp.carry.0", "emp.carry.1", "emp.carry.2", "emp.carry.3"], fps: 8 },
    "emp.climb": { frames: ["emp.climb.0", "emp.climb.1", "emp.climb.2", "emp.climb.3"], fps: 8 },
    "emp.cheer": { frames: ["emp.cheer.0", "emp.cheer.1"], fps: 3.33, loop: false },
    "emp.slump": { frames: ["emp.slump.0", "emp.slump.1"], fps: 3.33, loop: false },
    "emp.drink": { frames: ["emp.drink.0", "emp.drink.1", "emp.drink.1", "emp.drink.0"], fps: 1 },
    "emp.chat": { frames: ["emp.chat.0", "emp.chat.1"], fps: 2 },
    "emp.stretch": { frames: ["emp.stretch.0", "emp.stretch.1"], fps: 2, loop: false },
    "emp.bench": { frames: ["emp.bench.0", "emp.bench.0", "emp.bench.0", "emp.bench.1"], fps: 0.5 },
    "emp.visitor.shuffle": { frames: ["emp.visitor", "emp.visitor.1"], fps: 1 },
    "boss.walk": { frames: ["boss.walk.0", "boss.walk.1", "boss.walk.2", "boss.walk.3"], fps: 6 },
    "prop.coin": { frames: ["prop.coin.0", "prop.coin.1", "prop.coin.2", "prop.coin.3"], fps: 12 },
    ...Object.fromEntries([1, 2, 3].map((i) => [`fx.flame.${i}`, { frames: [`fx.flame.${i}.0`, `fx.flame.${i}.1`], fps: 4 }])),
    ...BUILDING.animations,
  },
  building: BUILDING.rig,
};

// ---------------------------------------------------------------------------
// Baking (for previews and brand art; the game uses the atlas)

/**
 * Flattens a frame's layers into one grid of hex colors with the given tints.
 * Draw order: base, shirt, hair.
 */
export function bake(name, { shirt = C.body[3], hair = SPRITE.hair[0] } = {}) {
  const f = FRAMES[name];
  if (!f) throw new Error(`no frame "${name}"`);
  const grid = Array.from({ length: f.h }, () => Array(f.w).fill(null));
  for (const [layer, tint] of [["base", null], ["shirt", shirt], ["hair", hair]]) {
    const g = f.layers[layer];
    if (!g) continue;
    g.forEach((row, y) =>
      row.forEach((col, x) => {
        if (col) grid[y][x] = tint ? multiply(col, tint) : col;
      }),
    );
  }
  return grid;
}

/**
 * Bakes a character frame with hair on top, using the frame's rig (hair view
 * and head offset). Returns { grid, top } where top <= 0 is the number of rows
 * added above the frame for hair that sticks out.
 */
export function bakeCharacter(name, { shirt, hair = SPRITE.hair[0], style = "short" } = {}) {
  const grid = bake(name, { shirt });
  const info = RIG.frames[name];
  if (!info || style === "none") return { grid, top: 0 };
  const h = HAIR[style][info.view];
  const hairGrid = bake(`hair.${style}.${info.view}`, { hair });
  const y0 = h.y + info.headY;
  const x0 = info.headX ?? 0;
  const top = Math.min(0, y0);
  const out = [...Array.from({ length: -top }, () => Array(grid[0].length).fill(null)), ...grid.map((r) => [...r])];
  hairGrid.forEach((row, y) =>
    row.forEach((col, x) => {
      if (col && x + x0 >= 0 && x + x0 < out[0].length) out[y + y0 - top][x + x0] = col;
    }),
  );
  return { grid: out, top };
}
