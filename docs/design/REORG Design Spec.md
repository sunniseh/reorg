# REORG: Design Spec

*Company: Reorg Inc. Ticker: $REORG. Hold the token. Get hired. Survive the reorg.*

Version 2.0 (2026-11-09). This spec describes the visual and interaction design of the REORG client (`apps/web`): a living office building drawn in PixiJS, with a DOM heads-up display (HUD) over it. Rules and data come from `docs/PROTOCOL.md` (normative) and the decisions in `ROADMAP.md` §2. This spec decides only how that state looks and moves, never what it is.

**What changed from v1.1.** v1.1 drew the company as rows of desks, with characters that never left their chairs. v2.0 makes it a building you look into: a side-on cutaway with a shell, rooms, stairs, an elevator, a lobby, a street and a basement, where every holder is a character who works, walks, takes coffee, rides the elevator and gets walked out. The desk still carries every piece of chain state; the character is free to move (§1, §5.5). The tower is a full-width stage with a HUD instead of a two-column page (§3). Desks per floor are 4/6/8/12 so every floor has the same width (§4).

**Scope labels.** Every item that is not part of the base build carries a label:

- **P0**: hackathon build (roadmap P0). Unlabeled items are P0.
- **P1**: ships if the roadmap's 11-12 check is green.
- **Later**: roadmap P2 or after the hackathon.

## 1. Design intent

The app is a game, not a dashboard: a side-on cutaway of an office building where every holder is a small employee with a desk, a floor and a routine. Seven principles guide every decision:

1. **The picture is the state.** Anything that carries meaning on screen comes from contract views, contract events, or state that `packages/core` derives from them.
2. **The desk is the state; the character is the life.** Every chain-derived mark (submitted paper, pass or miss dot, streak, new-hire chip, laid-off box) sits on the desk, so it stays readable wherever the character is. The character walks, works and idles around it.
3. **Movement only implies true things.** What a character is allowed to do depends on its state (§5.7). While a task is open, an employee who has not submitted stays at the desk working, so anyone away from their desk has already submitted. Idle behavior never suggests a pass, a miss, a payment or a layoff that did not happen.
4. **Readable in one second.** A newcomer should understand "people work, get paid, get laid off" from the first screen, before reading a word.
5. **Corporate parody, played straight.** The look is flat and tidy like an office poster. The humor lives in the boss's copy and the characters' routines, not in noisy visuals.
6. **Scales without changing.** The same building works for 8 employees and for 2,000. More holders means more floors, never a different design.
7. **Same building for everyone.** The building, its floors and every character's position are a pure function of chain state and the wall clock (§5.6). Two clients that read the same chain state at the same moment draw the same picture, no matter how long either has been open.

## 2. Brand and voice

| Element | Value |
| --- | --- |
| Company name | Reorg Inc. |
| Ticker | $REORG |
| Tagline | Hold the token. Get hired. Survive the reorg. |
| Mark | The word REORG in the heading weight, with the accent color as the only decoration |
| Primary accent | Pale cyan (#6ad4ff), used for the boss, the player's ring, the main button, and the company signage |

**Boss voice.** A passive-aggressive corporate executive who is relentlessly upbeat about bad news. Sample lines:

- Task open: “Per my last memo: decode today’s word before close of business.”
- Layoff: “We are rebalancing our talent. Thank you for your service.”
- Good day: “Great work, team. Synergy is up.”

Rules for copy: short sentences, buzzwords used on purpose, never cruel toward a real person, and no copy that implies money advice. Copy never tells anyone to buy or sell; it states rules.

## 3. Screens and layout

The main screen is one full-width **stage**: the building, drawn in a PixiJS canvas that fills the viewport. The interface sits on top of it as a DOM **HUD** with three parts: a top bar, the my-desk dock, and the feed ticker. The HUD never covers the player's own desk when the camera centers on it (§10).

| Part | What it contains | Scope |
| --- | --- | --- |
| **Stage** | The building (§4): rooftop sign, penthouse with the boss and the speech bubble, tier floors, the vertical core (stairs and elevator), lobby, street, basement with the vault and server room | P0 |
| **Top bar** (48 px) | The REORG mark; day number (the task id: “day” means task, not calendar date); task status with a countdown; reserve and runway (with the LOW state); headcount; the crowd label (§12.5); the **Preview growth** toggle (§12.4); a **Go to my desk** button once a wallet is badged in | P0 |
| **Company popover** | Opens from the headcount in the top bar: headcount by tier, laid off, visitors, reserve, runway, crowd label | P0 |
| **My-desk dock** | Bottom right, 360 px wide. The player's account, title, share of supply, streak, misses in a row out of `layoff_after` (or tasks left while laid off), total earned, claimable salary, today's puzzle, and the primary button (§3.1). Collapses to a pill that shows the status line and the primary button | P0 |
| **Feed ticker** | Bottom left. Shows the newest item; expands to the last 8, newest first: contract events and the boss's announcements | P0 |
| **Character card** | Click or tap a character, or its desk: account, title, share of supply, status, streak, badges, last 7 results, and a SIMULATED tag for crowd accounts. It is anchored next to the character and follows it while the camera pans. Hover shows a short tooltip with account, title, share, and streak | P0 |
| **Ledger** | Opens from the vault: income by tag (simulated income marked), salaries paid and forfeited, operating costs, runway. Each row links to its transaction on testnet; the local sandbox shows the transaction hash only | P0 |
| **Employee list** | A DOM table of every character in building order. The keyboard and screen-reader path to every card (§11) | P1 |

**Task status in the top bar.**

| Contract state | Shown |
| --- | --- |
| Open, before `closes_at` | “Open. Closes in 4:12.” |
| Closed (derived) or Finalizing | “Closed. Results pending.” |
| Finalized | “Finalized.” Plus a countdown to the next opening if the boss service reports one |
| No task yet | “No task posted. The boss is in a meeting.” |

### 3.1 The primary button

The my-desk dock has exactly one primary button at a time, or none. It follows the player's situation, checked top to bottom; the first match wins:

| Situation | Primary button | Otherwise the dock says |
| --- | --- | --- |
| Wallet not connected | **Badge in** (wallet connect; in demo mode, the burner demo player) | |
| Task open, no submission yet, laid off | **Reapply** (submits as a reapplication) | “Reapplication work is unpaid. Pass and you are rehired.” |
| Task open, no submission yet, has a tier | **Submit answer** | |
| Claimable salary on any finalized task, and the anti-dump rule holds | **Claim salary** with the amount | |
| Claimable, but the current balance is below `antidump_bps` of the snapshot | none | The claim-blocked copy in §13.2. The client never sends a claim that would forfeit |
| Own answer verifies against the revealed secret, not on the pass list, and the prove window is open (P1) | **Prove my pass** | |
| Anything else | none | Status copy: submitted, visitor, results pending |

The client has no controls for opening or finalizing a task. The boss scheduler runs the day.

## 4. The building

A side-on cutaway: the front wall is removed, so every room is visible. All sizes in this section are in **sprite pixels** (the atlas unit); the camera draws them at a whole-number zoom (§10).

### 4.1 Layers

Back to front. Each floor's static layers (1, 2, 3 and 5) are cached as one texture and redrawn only when the floor's contents change (§14.4).

| Z | Layer | Contents |
| --- | --- | --- |
| 0 | Backdrop | Flat sky and skyline bands in the Sky token. No gradients, no parallax |
| 1 | Shell | Outer walls, floor slabs, roof, rooftop sign, foundation in the ground, the street and sidewalk |
| 2 | Back wall | Room walls in the tier tint, windows, posters, the floor's clock (shows the task countdown), the whiteboard (shows the task number) |
| 3 | Furniture, back | Chairs, desk backs, filing cabinets, water cooler, printer, outbox, coffee machine, the elevator shaft and stairs |
| 4 | Seated characters | Characters in their chairs, behind the desk fronts |
| 5 | Furniture, front | Desk fronts, cubicle partitions, glass office walls, the reception counter |
| 6 | Aisle characters | Characters walking or standing in the aisle, in front of the furniture. Sorted by x within a floor |
| 7 | Effects | Coins, paper, speech bubbles, result dots, “+amount” |
| 8 | In-canvas labels | Floor plaques, the player's ring, the NEW chip, streak numbers |

### 4.2 Geometry

Every floor has the same width, like a real building:

| Part | Width |
| --- | --- |
| Outer wall | 4 on each side |
| Vertical core (left): stairwell 24, elevator shaft 20 | 44 |
| Rooms | 288 |
| Amenity bay (right): water cooler, printer and outbox, coffee machine, window | 40 |
| **Total** | **380** |

A floor is 48 tall inside (ceiling to floor) plus a 4 px slab. Standing characters are 26 tall, so a floor leaves room above their heads for the back wall's windows and posters.

### 4.3 Floors and rooms

From top to bottom:

| Band | Contents | Rooms per floor |
| --- | --- | --- |
| Roof | The company sign (§12), a water tank | Not applicable |
| Penthouse (64 tall) | The boss's office: big desk, window, mug. The boss lives here (§5.8) and speaks in a bubble | Not applicable |
| Directors | Private offices with walls and a door, a plant | 4 rooms, 72 wide |
| Managers | Glass offices with a whiteboard | 6 rooms, 48 wide |
| Associates | Cubicles with low partitions | 8 rooms, 36 wide |
| Interns | One long shared desk, split into seats | 12 seats, 24 wide |
| Lobby | Reception counter, the HR door, the café corner, the foot of the stairs and the elevator, glass front doors | Not applicable |
| Street | Sidewalk in front of the lobby: the visitors' queue at the glass doors, the **bench** where laid-off employees sit, a street lamp, the crowd sign (§12.5) | Not applicable |
| Basement | Treasury vault (reserve, a fill bar, runway), the server room, the foot of the **pneumatic tube** that runs up the core to every floor | Not applicable |

**Floor plaque.** Each floor carries a plaque on the core wall beside the elevator door: the tier name (12 px, weight 600) and its headcount as a small muted second line. It appears on the first floor of each tier.

**Floors per tier.** A tier with `n` characters has `max(1, ceil(n / rooms per floor))` floors. An empty tier still gets one floor of empty rooms, so the org chart is always complete. Room order comes from `layoutTower()` in `packages/core` (tier, then balance descending, then account id), filling each floor left to right. The renderer never re-sorts.

**Empty rooms** show the furniture outline in the Desk edge color, with no chair, no monitor and no character.

**Changes during a day.** Layout is recomputed from current state, so a floor disappears when its last holder sells out and rooms shift when balances reorder. Rooms and furniture never animate. Characters walk to their new desk (same floor) or take the elevator (another floor, §14.3). A removed floor fades out in 150 ms; the floors above it settle down in 300 ms.

### 4.4 Vertical core

- **Stairs.** One staircase per floor inside the stairwell: two flights with a landing, rising right then left. Characters climb them visibly on idle trips between floors (§5.6).
- **Elevator.** One shaft with one cab, doors in 3 frames (closed, half, open), and a floor indicator above each door. The elevator is used only by scripted moments (layoff, rehire, promotion, the boss coming down, new hire arrival). Rides queue: one ride at a time, up to 3 riders per ride.
- **Pneumatic tube.** Runs from the vault up the core with one outlet per floor, in the last 4 px of the stairwell beside the shaft. Payday coins travel through it (§14.3).

### 4.5 Lobby and street

- **Visitors**, meaning holders whose balance gives no tier, queue on the sidewalk outside the glass doors as outlined figures that are never filled in: up to 5, then a “+n” label. They shuffle in place.
- **The bench.** Laid-off employees sit on the bench with their box: up to 4 seats, then a “+n” sign. Their desks upstairs stay dimmed with the box outline (§5.3).
- **Where the street is.** The sidewalk is drawn as a band below the lobby, in front of it: the lobby has a glass street front with the front doors in the bay, and street characters stand on the sidewalk, overlapping the bottom of the street front, so the lobby reads as raised a few steps. Walking out means leaving through the doors and stepping down onto the sidewalk, toward the viewer. Geometry: `RIG.building.street` (`art/building.mjs`).
- Accounts in `excluded_accounts` (deployer, contracts, LP, crowd root) are never drawn.
- **There are no extra people.** Every character on screen is a wallet, except the boss. No receptionist, no passers-by.

### 4.6 Vault and server room

**Vault.** The reserve is shown in NEAR with one decimal place, above a 10 px bar in the coin color, beside a round vault door and a coin pile whose height follows the bar. The bar shows `min(1, runway_tasks / 30)`, where 30 is a client display constant, not contract config. Runway is written as plain text in tasks: “Runway: 42 tasks.” If `operating_cost` is 0, the bar is full and the text reads “No operating costs.”

- **Low reserve** means the reserve is below the contract's `reserve_low` threshold (from `get_treasury`). The bar and the vault outline turn to the Bad color with a “LOW” label, steady, with no looping pulse. The `reserve_low` event adds one alarm (§14.3).

**Server room.** A rack beside the vault with steady status lights (static, no blinking). P1: when the boss service reports `STALLED` on `/healthz`, the rack shows a red “STALLED” tag and the feed explains it.

## 5. Characters and their life

Each wallet is one small pixel-art office worker, made of at most three sprites from one atlas so thousands can render cheaply. The sprites, their frames and the rig live in `art/` (`npm run art`; see `art/README.md`). **TODO(art): the current sprites are placeholder art, to be replaced by the final character art with the same frame names, sizes and layers.**

### 5.1 Anatomy

- Standing character: 16 by 26. Seated character: 16 by 20, ending at the desk top; the chair is drawn behind and the desk front in front. Heads sit in rows 0 to 11 of every pose, so hair lines up without offsets.
- Layers: a fixed-color base (skin in the shared skin tone, face, trousers), a grayscale shirt layer tinted with the body color, and a grayscale hair layer tinted with a hair color. All share one anchor, bottom center.
- Body color: one of 8 body tokens (§6). The index is `sha256(utf8(wallet))[0] mod 8`, computed in `packages/core` (roadmap W-04) so every client picks the same color.
- Hair: style `sha256(utf8(wallet))[1] mod 5` (short, long, bun, curly, none) and color `sha256(utf8(wallet))[2] mod 6`. P0, because a building full of identical heads cannot be told apart at a glance.
- Profile frames face right and are mirrored to face left.
- Rendering: textures from one atlas with nearest-neighbor filtering, tinted at runtime. Nothing is redrawn per frame.

### 5.2 Animation set

Every animation has 8 frames or fewer (§14.4).

| Animation | Frames | Use | Scope |
| --- | --- | --- | --- |
| `emp.sit.front` | 1 | Seated, facing out | Exists |
| `emp.type` | 2 | Seated in profile, typing | Exists |
| `emp.walk` | 4 | Walking; running is the same frames at double rate and speed | Exists |
| `emp.carry` | 2 | Walking with the layoff box and desk plant | Exists |
| `emp.visitor` | 1 | Lobby visitor outline | Exists |
| `emp.stand.front`, `emp.stand.side` | 1 each | Standing, waiting, riding the elevator | Exists |
| `emp.cheer` | 2 | Seated, arms up: passed at finalize, payday | Exists |
| `emp.slump` | 2 | Seated, head down: missed at finalize | Exists |
| `emp.drink` | 2 | Standing in profile with a cup: cooler and coffee | Exists |
| `emp.chat` | 2 | Standing in profile, talking hand | Exists |
| `emp.climb` | 4 | Climbing stairs (walk with a raised knee) | Exists |
| Carry paper | (walk + `prop.paper` at the hand attach point) | Taking a submission to the outbox | Exists (hand points in `RIG.frames`) |
| `emp.sit.side` | 1 | Seated in profile, leaning back: thinking | P1 (frame exists) |
| `emp.stretch` | 2 | Seated, stretching | P1 (frames exist) |
| `boss.smile`, `boss.smug`, `boss.twitchy` | 1 each | Boss standing, face from the pass rate (§17.1) | Exists |
| `boss.walk` | 4 | Boss walking: penthouse pacing, coming down for layoffs | Exists |
| `boss.point` | 1 | Boss pointing at the employee being laid off | Exists |
| `emp.bench` | 2 | Laid off, seated on the street bench, the box beside | Exists |
| `emp.sit.land`, `boss.sip`, `boss.stand.side` | 1 each | The sit-down squash (§14.1); the boss's sip and standing profile in the penthouse | Exists |

The props and building tiles the life system needs (roadmap A-01) are listed in `art/README.md`, with their geometry in `RIG.building`; `art/building.png` shows them composed. They include the elevator doors and cab, stairs, outbox, printer, water cooler, coffee machine, bench, street lamp, tube outlet, per-tier furniture, and the shell and window tiles for each building state (§12).

### 5.3 Status

Exactly one per character, computed in `packages/core` (PROTOCOL §6.5). Status decides the character's **home** (where it rests) and what it may do (§5.7).

| Status | Home | Desk shows | Source |
| --- | --- | --- | --- |
| New hire | Desk on the tier of the current balance | “NEW” chip | Token holder with a tier and no employee record |
| Active | Desk | | Employee status `active` |
| Struggling | Desk. P1: a sweat drop on the character | | Employee status `struggling` (`misses_in_row` ≥ 1). In P0 the misses show in the card, tooltip, and dock |
| Laid off | A seat on the street bench, with the box | Dimmed to 40%, with a box outline in ink | Employee status `laid_off` |
| Visitor | A spot in the sidewalk queue | No desk | Balance below the lowest tier threshold |

Employees sit on the tier of their most recent submission snapshot (`last_tier`), so a tier change shows at the next submission. New hires sit on the tier of their current balance.

### 5.4 Overlays

These stack on top of the status. Desk overlays stay put while the character moves.

| Overlay | Where | Visual | Source | Scope |
| --- | --- | --- | --- | --- |
| Working | Character | Seated in profile, typing (`emp.type`), monitor on | A task is Open and before `closes_at`, and the character is not laid off | P0 |
| Submitted | Desk | A stamped paper sheet on the desk. The floor's outbox shows a stack with one sheet per submission from that floor | A submission exists for the open task (`submission_received`, `get_submission`) | P0 |
| Passed | Desk | 7 px coin-colored dot with a check mark at the desk's top-right | The character's submission to the last finalized task passed (`list_submissions`). Shown until the next `task_opened` | P0 |
| Missed | Desk | Same dot in the Bad color with a cross | Submitted to the last finalized task and did not pass. Wallets that did not submit get no dot | P0 |
| Streak | Desk | Muted number at the desk's top-left | `effective_streak` ≥ the first value in `streak_milestones` | P0 |
| Flame aura | Character | One level per milestone reached | Number of `streak_milestones` ≤ `effective_streak` | P1 |
| Payday | Desk | A coin pops from the tube outlet onto the desk, then a small Good-colored “+amount” rises 14 px and fades over 1.6 s | `payroll_allocated`. The amount is that wallet's pay, from the core pay-math mirror over `list_submissions` or from `get_claimable` | P0 |
| Claimed | Desk | A coin pops once | `salary_paid` | P1 (the feed item is P0) |
| Forfeited | Desk | “−amount” in the Bad color, rises and fades like Payday | `salary_forfeited` | P1 (the feed item is P0) |
| You | Character and desk | 2 px accent outline around the character (it follows the character), and an accent nameplate on the desk | Connected wallet | P0 |
| Employee of the Day | Character | Gold ring around the head | Jackpot; no event in v1 | Later |

Simulated crowd accounts carry no mark in the building. The crowd sign, the top bar and the card cover them (§12.5).

### 5.5 The life system

Every drawn character is an **agent**: a set of sprites plus a controller that walks it between points in the building. Three sources can tell an agent what to do, in priority order:

1. **Script.** A signature moment from the event director (§14.3): the rush, the submit walk, cheer and slump, a layoff, a rehire, a promotion, a new hire's arrival. Scripts are sequences of commands: walk to, run to, climb, ride, sit, stand, play an animation, face a direction, emote.
2. **Required behavior.** What the state demands right now (§5.7), such as staying at the desk while a task is open and nothing is submitted.
3. **Idle schedule.** The cosmetic routine (§5.6).

When a script ends, the agent walks home and rejoins its schedule at the next slot boundary.

**Navigation.** Each floor (including the penthouse, lobby, street and basement) is one horizontal aisle with named points: each seat, the cooler, the printer and outbox, the coffee machine, the window, the stair landing, the elevator door, and in the lobby and street the reception, café, HR door, front door, bench seats and queue spots. The stairs link each floor to the next; the elevator links all of them. A path is: walk the aisle to the stairs or elevator, change floors, walk the aisle to the target. Navigation is a small pure module, tested without Pixi.

**Speeds** (sprite px): walk 24 per second, run 48 per second, stairs 1.6 s per floor, elevator 0.8 s per floor plus 0.4 s for the doors at each end.

### 5.6 The idle schedule

Wall-clock time is split into **20-second slots**. For each agent and slot, a hash of `(wallet, task_id, slot index)` picks one activity from the set its state allows (§5.7), with weights, and a duration. Every slot starts and ends at the agent's home, and each activity fits in its slot (walk out, act, walk back), so an agent's position at any moment is a closed-form function of time.

- No history is needed: a client that loads mid-day, or a character that scrolls into view, computes its position directly.
- Two clients at the same moment show the same activity in the same place (principle 7). They can differ by their clock skew, at most a second or two. The client corrects its clock from the boss service's `/healthz` time or the latest block timestamp.
- **Water-cooler chats.** For each floor and slot, the agents that drew “chat” are paired by the order of their slot hashes. Each pair meets at the floor's cooler, so both partners compute the same meeting. An odd one out drinks alone.
- Trips to another floor (the lobby café, a colleague two floors up) go by the stairs and reach at most 2 floors away, so they fit in a slot.
- About half the slots are “stay”: the agent stays home and plays a home animation (typing, the P1 sit-side lean or stretch, the bench, the queue shuffle).

The slot length and weights are client display constants, not contract config.

### 5.7 What each state allows

| State | Allowed idle activities |
| --- | --- |
| No task open (finalized, or none yet) | Stay, cooler, coffee, window, printer, chat, a stairs trip |
| Task open, not submitted | Desk only: typing, plus thinking and stretching (P1). Never leaves the desk |
| Task open, submitted | After the submit walk (§14.3): anything in the first row |
| Closed or Finalizing (results pending) | Desk only. Everyone is seated when results arrive |
| Laid off | The bench only. P1: stands and paces beside it |
| Visitor | The queue only |
| Boss | Penthouse only: paces, looks out the window, sips from the mug. Leaves only by script |

### 5.8 The boss

The boss is the one character who is not a wallet. It lives in the penthouse, and its speech bubble follows it. Its face comes from the latest pass rate (§17.1). For a layoff it rides the elevator down, points at the employee, and rides back up (§14.3).

## 6. Color

REORG ships in dark mode only. There is no light theme and no theme toggle. Colors are tokens defined once in `apps/web/src/theme/tokens.ts` and exported both as CSS variables for the DOM and as numbers for Pixi. The palette is Blueprint: navy paper with a pale cyan accent.

| Token | Value | Use |
| --- | --- | --- |
| Background | #0a1626 | Page and HUD backdrop |
| Panel | #11233a | Cards, HUD surfaces, desk fills |
| Ink | #e6f1fb | Text, the laid-off box |
| Muted | #8fa6bf | Secondary text |
| Line | #25405d | Dividers on panels only. Never used for an edge that carries meaning |
| Desk edge | #6a8aad | Desk and furniture outlines, empty rooms |
| Accent | #6ad4ff | Boss, player ring, primary button, signage |
| Button text | #0a1626 | Text on the accent |
| Good | #4cc38a | Payouts and success text |
| Bad | #ff7b7b | Misses, low reserve, and error text |
| Coin | #f2c230 | Passed dot, vault bar, coins |
| Skin | #e9b98f | Character heads |

**Building tokens** (new in v2.0; tune in the art pass, then measure contrast for any text placed on them).

| Token | Value | Use |
| --- | --- | --- |
| Sky | #0a1626 | Backdrop (the Background value) |
| Skyline | #10203a | Flat skyline bands behind the building |
| Shell | #1f3a5a | Outer walls, slabs, roof |
| Shell edge | #6a8aad | Outline of the building (the Desk edge value) |
| Glass | #2b5876 | Windows, glass office walls, lobby doors |
| Street | #132339 | Sidewalk and street |
| Ground | #0d1c30 | Earth around the basement (the Basement value) |

**Body colors.** Hues avoid the accent, Bad, Coin, and Good, so no character can be mistaken for the player, the boss, or a result.

| Token | body-0 | body-1 | body-2 | body-3 | body-4 | body-5 | body-6 | body-7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Value | #c8d879 | #98d879 | #79d881 | #7990d8 | #8979d8 | #b079d8 | #d879d8 | #d879b0 |

**Room tints** (the back wall of each band)

| Band | Color |
| --- | --- |
| Penthouse | #123a55 |
| Directors | #1a2c4f |
| Managers | #153250 |
| Associates | #14403f |
| Interns | #3b3820 |
| Lobby | #15263c |
| Basement | #0d1c30 |

The tints separate tiers at a glance without text, running cool at the top and warm at the bottom.

**Sprite colors.** The pixel art uses the tokens above plus a few shades that appear only inside sprites, never in the interface. They are defined in `art/palette.mjs`.

| Token | Value | Use |
| --- | --- | --- |
| Skin shade | #c98f66 | Ears, jaw, neck |
| Accent shade | #3c9cc8 | Shading on the boss's blazer |
| Coin shade | #b88a10 | Coin rim |
| Trousers | #2c4462 | Legs |
| Cardboard, cardboard shade | #c49a5a, #8f6a38 | The layoff box; the boss's coffee; the garage sign |
| Plant, plant dark | #6fb07e, #3f7a50 | Desk plants |
| Hair | #5a3b26, #8a5a32, #d6b16a, #b9c2cc, #2f3a4f, #a8452e | Tint for the hair layer, by wallet hash |

The boss's hair is the Muted token and the boss's blazer is the Accent token.

**Measured contrast** (WCAG 2.x, 2026-11-08). Every text color is at least 4.5:1 on the background, the panel, and every room tint; the lowest is Muted on Associates at 4.56:1. Button text on the accent is 10.8:1. Desk edge is at least 3.19:1 on every tint, and every body color is at least 3.16:1. Re-measure whenever a token changes, and measure the building tokens before any text sits on them.

## 7. Typography

One family only: the system UI stack (`system-ui`, then the platform fonts), in the DOM and in Pixi text alike. No web font is loaded, so the app starts fast and works offline. In-canvas micro text uses a bitmap font generated at load from the same family.

| Role | Size and weight |
| --- | --- |
| App name | 26 px, bold, tracking -0.02em (20 px in the top bar) |
| Card heading | 15 px, bold |
| Body (including the memo text) | 15 px, line height 1.45 |
| Secondary text | 13 px, muted |
| Simulated labels | 13 px, weight 600, ink |
| Floor plaque | 12 px, weight 600 (10 px on phones) |
| Puzzle cipher (the encoded line only) | 22 px, bold, letter spacing 0.15em |
| Feed items | 13 px |
| In-canvas micro text (streak, NEW, payout) | 9 px |

Canvas text is drawn at screen size, not scaled with the camera zoom, so it stays sharp. Punctuation in all visible text uses typographic apostrophes, quotes, and the ellipsis character (…).

## 8. Components

These are the DOM components. Pixi objects are listed in §15.2.

- **Primary button.** Accent fill, button-text color, 12 by 16 px padding, 6 px radius, weight 600. One per screen at a time.
- **Secondary button.** Transparent with a 1 px line border, 8 by 12 px padding. A selected toggle uses the accent for border and text. Minimum height 44 px on phones.
- **Card.** Panel fill, 1 px line border, 8 px radius, 12 px padding, 12 px gap below.
- **HUD surface.** A card that floats over the stage: Panel fill, 1 px line border, 8 px radius, and the one allowed shadow level (0 2px 0 Background). It never blurs what is behind it.
- **Speech bubble.** Panel fill, 1 px accent border, 8 px radius. Used only by the boss, and drawn in Pixi.
- **Text input.** 150 px wide, line border, uppercase transform, `autocapitalize="characters"`, `autocomplete="off"`, `spellcheck="false"`. Enter submits. The contract normalizes case and maps 0 to O and 1 to I, so the input does not need to.
- **Feed.** An unstyled list with 1 px dividers. It is a polite live region so screen readers announce new items.
- **Focus ring.** A 3 px ink outline with 2 px offset on every interactive DOM element.

## 9. Motion

| Motion | Spec | Scope |
| --- | --- | --- |
| Walk, run, climb | §5.5 speeds; walk 8 fps, run 16 fps | P0 |
| Elevator | Doors 0.4 s, 0.8 s per floor, floor indicator updates | P0 |
| Typing | 4 fps while working | P0 |
| Payout rise | Fade out while rising 14 px, 1.6 s, once | P0 |
| Alarm light | Penthouse and floor lights pulse three times when a task opens, then stop | P0 |
| Coin tube | Coins rise through the tube and pop out at each floor's outlet, tier by tier, on payday | P0 |
| Cheer and slump | 2 frames, 0.6 s, once, at results | P0 |
| Crane | A crane lowers a new floor into place when a tier fills | Later |
| Lights out | Floors go dark one by one on bankruptcy | Later |
| Day and night | Sky and windows follow the clock | Later |

Reduced motion is defined once, in §14.5.

## 10. Responsive behavior and camera

**Zoom.** The camera draws sprite pixels at a whole-number zoom: the largest zoom at which the building's 380 px width fits the stage, at least 2× on a laptop. When even 1× does not fit (phones), the camera fits the width with linear filtering. The building never scrolls sideways at the default zoom.

**Panning.** When the building is taller than the stage, dragging or scrolling on the stage pans vertically; otherwise the page does not scroll. Pinch or Ctrl+scroll zooms (P1). On load the camera shows the whole building if it fits, otherwise the player's desk if badged in, otherwise the top floors. **Go to my desk** jumps the camera to the player's character (it pans in 300 ms; under reduced motion it jumps). There is no continuous follow; a **Follow me** toggle is P1.

| Width | Change |
| --- | --- |
| Above 820 px | Top bar in one row; dock bottom right; feed ticker bottom left |
| 820 px and below | Top bar shows day, countdown and reserve; the rest moves to the company popover. The dock becomes a bottom sheet; collapsed, it shows the status line and the primary button |
| 520 px and below | Floor plaques at 10 px; feed ticker collapses to an icon button with the newest item's count. Desks show a coin instead of “+amount”; exact amounts appear only on the player's own desk, the dock and the card |

The canvas fills the stage, follows its size, and caps the device pixel ratio at 2. The page declares `viewport-fit=cover` and pads the HUD by the safe-area insets so nothing hides under phone system bars. The camera keeps the player's desk clear of the dock and the top bar when it centers on it.

**Touch.** On phones the first tap on a floor zooms the camera so its rooms are at least 44 px wide; a tap on a character or desk then opens its card.

## 11. Accessibility

- Contrast is measured in §6. Meaning never relies on color alone: pass and miss carry a check mark and a cross, and low reserve carries a “LOW” label.
- The canvas has `role="img"` and an `aria-label` summary, refreshed on each `task_opened` and `task_finalized`. Example: “Reorg Inc. 18 employees. Task 5 is open, 12 submitted.”
- The feed announces items politely. The dock exposes the player's own state as text.
- Focus rings are always visible on DOM controls, and the puzzle input submits with Enter.
- Characters inside the canvas are not keyboard-reachable. The employee list (P1) is the keyboard and screen-reader path to every card. Until it ships, the dock and the feed carry the same information. The README lists this as a known gap.
- Nothing flashes more than three times per second.
- Reduced motion: §14.5.

## 12. Building states from holder count

The building has five named states, each with its own shell, surroundings, and camera, chosen by the current employee count: characters with a tier, excluding visitors and excluded accounts, as computed by `packages/core`. At the default thresholds the company cannot exceed 2,000 employees; the cap follows the lowest tier threshold.

The accent color marks the company signage at every state: a cardboard sign, a painted sign, a rooftop sign, a ticker, and finally a blimp.

### 12.1 What each count drives

- **Employee count** picks the building state: the shell, the sign, and the surroundings.
- **Visitor count** (holders below the lowest tier) fills the queue on the sidewalk: up to 5 outlined figures, then a “+n” label.
- **Tier fill** adds floors inside a state, as described in §4.
- **Reserve level**, not holder count, drives lighting: the vault shows its low state when the reserve is below `reserve_low`, and floors go dark on bankruptcy (Later).

### 12.2 The five states

| State | Employees | Shell and sign (P0) | Surroundings | Vault |
| --- | --- | --- | --- | --- |
| Garage startup | 1 to 10 | Brick shell, a roll-up door instead of glass lobby doors, a cardboard sign | Later: an empty lot and one tree | Cash box (Later) |
| Small office | 11 to 50 | Concrete shell with painted window frames, a painted sign | Later: a parking lot and a coffee cart | Wall safe (Later) |
| Office tower | 51 to 250 | Glass curtain-wall shell, a lit rooftop sign | Later: city blocks behind | Round door (P0 default) |
| Skyscraper | 251 to 1,000 | Tall tower with an antenna, a helipad, and a ticker sign reading $REORG | Clouds drift past the upper floors | Bank-style walk-in |
| Megacorp | 1,001 to 2,000 | Twin towers joined by a sky bridge, the second rising as the first fills | Full skyline and a blimp carrying the boss's latest announcement | Double doors |

In every state the number of floors comes from tier fill (§4), so even Garage startup has one floor per tier. The interior (rooms, core, lobby, street, basement) is the same in every state.

**Scope.** P0 draws the full interior in every state, plus the shell tiles and sign of the first three states. Per-state surroundings, per-state vault art, Skyscraper and Megacorp are Later.

### 12.3 Changing state

- **No hysteresis.** The state is a pure function of the current employee count. Hysteresis would need past counts, which the chain does not store, so a fresh client and a long-running one would disagree. Flicker near a boundary is accepted. If it becomes a problem, drive hysteresis from chain data, such as the `submitted` count of the last finalized task.
- **Seen live.** When a client sees the state change while it is open, the shell and sign crossfade in 300 ms and the boss says “We have outgrown our space.” on the way up or “We are right-sizing our footprint.” on the way down. The 4 second construction sequence (scaffolding, crane, ribbon cutting) and the “For lease” banners are Later.
- **Fresh load.** A client that loads mid-day draws the current state with no transition.

### 12.4 Growth preview

Live data stays within the first two states (≤ 50 employees, roadmap D18). A **Preview growth** toggle in the top bar switches the client's state source to a seeded simulation with 8, 24, or 60 employees, covering the first three states. The simulation runs the same life system and plays the same signature moments on a timer, so the preview looks like a working company.

- While the preview is on, a full-width **SIMULATED PREVIEW** banner sits across the top of the stage, with the same text in the top bar. It cannot be dismissed.
- Simulated and live characters never share a screen. Turning the toggle off returns to live state.

### 12.5 Simulated data labels

The demo's holders and income are bots. The interface says so wherever they appear:

- **Crowd.** While any drawn character is a crowd account, a taped paper sign on the lobby's glass reads “SIMULATED CROWD: these employees are bots.” The top bar and the company popover show “Crowd: simulated (N bots).” Their cards and tooltips carry a SIMULATED tag. The client learns which accounts are crowd accounts from deployment config (the crowd root account), never by guessing.
- **Income.** Ledger rows deposited by the income bot are marked “simulated”.
- **History.** In the local demo, the first feed item reads “Records before you arrived were generated by bots on a local chain.”
- Simulated labels use the 13 px label style in ink, never muted, and never hide on phones.

## 13. Rules against generic, AI-looking design

REORG parodies office life, so its look has to come from that world. The product uses AI for the boss's text, but nothing in the interface should look like a generic AI product. A screen passes only if it could not be mistaken for a template.

### 13.1 The rules

1. **Everything comes from the office.** Visuals are built from desks, memos, org charts, HR forms, sticky notes, water coolers, and fire-exit signs. If an element could sit unchanged in any crypto dashboard, redraw it.
2. **No default AI or crypto look.** Banned: purple-to-blue gradients, glowing orbs, frosted-glass cards, neon on black, sparkle or magic-wand icons, brain or circuit motifs, floating 3D coins, and stock robot faces.
3. **The boss is a character, not an icon.** A flat figure with a tie, a lanyard, and a mug, whose expression changes with the day's results and who walks the building. Never a glowing head or a chat-bot avatar.
4. **Flat and hard-edged.** Solid fills, 1 to 2 px outlines, small radii, at most one subtle shadow level, and no gradients or blur.
5. **All art is made, not generated.** Characters, props, and the building are pixel art built from code and a hand-drawn kit. No stock photos, no AI-generated images or faces, and no icon pack used without redrawing it in the house style.
6. **Hierarchy through size and weight.** One type family, no decorative display fonts, no giant gradient headline, and no tracked all-caps everywhere. The SIMULATED labels are the one deliberate all-caps exception.
7. **The building is the screen.** The stage dominates and the HUD is plain and utilitarian. No row of three equal cards with icons, no uniform pill buttons, no centered hero.
8. **Copy has a point of view.** Write in the boss's voice or plain office language. In interface copy, the README, and posts, these words are banned: unlock, supercharge, revolutionize, seamless, elevate, leverage, next-generation, and “welcome to the future.” The boss's own lines may use any corporate buzzword, “leverage” and “synergy” included, because the parody is the point. No decorative emoji, and no exclamation marks outside the boss's passive-aggressive cheer.
9. **Errors and empty states are jokes with a job.** They say what happened and what to do, in voice.
10. **Every decoration earns its place.** It either shows state, delivers a joke, or gives a character somewhere to go. If it does none of these, remove it.

### 13.2 Copy in voice

| Situation | Generic | REORG |
| --- | --- | --- |
| Network error | Oops! Something went wrong. | The request has been escalated to HR. Try again in a minute. |
| Empty feed | No activity yet. | Nothing to report. Per my last memo, that is not a good sign. |
| Wallet not connected | Connect your wallet to continue. | Please badge in so we can find your desk. |
| Balance below the minimum | Insufficient balance. | You hold too little to be on payroll. Visitors may wait in the lobby. |
| Task closed | This task has ended. | Today’s window has closed. Submissions are now a matter for tomorrow. |
| Laid off | You have been removed. | Your position has been rebalanced. Pass today’s task to reapply. Reapplication work is unpaid. |
| Reapplication filed | Submitted. | Your application is on file. Pass and you are rehired. |
| Rehired | Welcome back. | Welcome back. We never doubted you, officially. |
| Submitted | Submission received. | Filed. Results at close of business. |
| Claim blocked by the anti-dump rule | Insufficient balance to claim. | Claims need at least {amount} $REORG in this account ({antidump}% of what you held at submission). This salary waits; it does not expire. |
| Salary forfeited | Claim failed. | Your salary went back to the reserve: your balance was below {antidump}% of your snapshot. |
| Loading | Loading... | Filing paperwork… |

**Submission and claim rejections.** The contract returns a reason string; the client maps it to copy and shows the raw reason in a muted details line. An unknown reason uses the network-error copy.

| Contract reason | REORG |
| --- | --- |
| `tokens received after the task opened (anti-recycling)` | Paperwork for recent transfers takes one task. Your desk is ready at the next one. |
| `balance below the minimum tier (visitor)` | You hold too little to be on payroll. Visitors may wait in the lobby. |
| `already submitted for this task` | We already have your answer on file. One per employee. |
| `submission window is closed`, `task is not open` | Today’s window has closed. Submissions are now a matter for tomorrow. |
| `account is excluded` | This account belongs to the company and cannot be on payroll. |
| `storage float is low: the operator must top up the contract` | The office is out of filing cabinets. Facilities has been notified. Try again later. |
| `balance read failed`, `transfer failed` | HR could not reach your records. Nothing changed. Try again in a minute. |
| `already claimed, pending or forfeited` | Payroll already processed this one. |

### 13.3 The three-question test

Before any screen ships, ask: (1) With the logo covered, is it still clearly REORG? (2) Could this screen become a template for another app just by swapping the colors? (3) Does every decoration show state, tell a joke, or give a character somewhere to go? A “no” to the first, a “yes” to the second, or a “no” to the third sends the screen back.

## 14. Animation rules

Animation in REORG is information first and charm second. Every movement must tell the player something happened, where to look, or who these people are.

### 14.1 Principles

1. **Three jobs only.** *Meaning* (pass, miss, pay, layoff), *orientation* (camera moves, a floor appearing), and *life* (the boss, the idle schedule). Motion that does none of these is removed.
2. **Events drive meaning.** Every meaningful animation is triggered by a contract event or by a change in derived state (layoff, tier change, new hire), never by a timer of its own. The idle schedule is the only timer, and it follows §5.7 so it never implies state.
3. **Order and catch-up.** Events play in `seq` order, except the finalize group (§14.3.1). On load the client starts from the latest `seq`: it draws current state (characters at the positions the schedule gives) and animates only newer events. If more than 20 are queued, for example after a tab was in the background, skip to the final state and show one summary line in the feed.
4. **Small and quick.** The player does the same actions every day, so nothing may make them wait. Walks never block the HUD, and every sequence can be skipped with a tap: characters jump to where the sequence leaves them.
5. **Stagger to read.** When many things change at once, start them 150 ms apart in a fixed order (the payroll bucket order: Directors, Managers, Associates, Interns) so the eye can follow.
6. **Anticipation and follow-through.** A character rises before it walks, settles when it sits (a one-frame squash), and turns its head before it turns its body. This is where the game feel comes from, not from screen effects.

### 14.2 Timing and easing

| Kind | Duration | Easing |
| --- | --- | --- |
| Micro feedback (press, hover) | 100 to 150 ms | ease-out |
| State change on a desk | 200 to 300 ms | ease-out |
| Walk, run, climb | From the §5.5 speeds | Constant speed, 100 ms ease at start and stop |
| Elevator cab | 0.8 s per floor | ease-in-out |
| Camera pan | 300 ms | ease-in-out |
| Entering elements | 200 ms | ease-out |
| Leaving elements | 150 ms | ease-in |
| Ceremony (building upgrade, Later) | 4,000 ms maximum | scripted |

No bounce or elastic overshoot, except a small two-frame squash on the coin pop and on sitting down.

### 14.3 Signature moments

| Moment | Trigger | Length | What happens | Scope |
| --- | --- | --- | --- | --- |
| Task opens | `task_opened` | ≤ 3 s | The alarm light pulses three times and the boss's bubble types in. **The rush:** everyone away from their desk runs home (fast enough to arrive within 3 s), sits, and starts typing | P0 |
| Submission | `submission_received` | ≤ 6 s | The monitor flashes once and the stamped paper lands on the desk. The character stands, carries a sheet to the floor's outbox (its stack grows), and is then free to roam (§5.7) | P0 |
| Results | `task_finalized`, with `list_submissions` | 1.5 s at most | Pass and miss dots appear, tier by tier. Passers cheer, missers slump | P0 |
| Streak milestone | `streak_milestone` | 1 s | The streak number pops; the flame grows (P1) | P0 |
| Rehire | `rehired` | Non-blocking | The character stands up from the bench, walks in through the front door, rides the elevator, walks to the desk and sits; the desk brightens as it sits | P0 |
| Payday | `payroll_allocated` | 3 s at most | Coins rise through the tube from the vault, tier by tier, pop out at each floor's outlet, and land on each passing desk with a small “+amount”. The character cheers if seated | P0 |
| Layoff | Derived: a status becomes `laid_off` after `task_finalized` | Non-blocking | The boss rides down and points; coworkers on that floor turn to look; the character packs the box, walks to the elevator, rides down, crosses the lobby, goes out the front door and sits on the bench; the desk dims | P0 (the boss's ride is the first thing cut, roadmap §11) |
| Promotion | Derived: a `submission_received` tier differs from the previous `last_tier`, or a new hire's tier changes | Non-blocking | The character picks up its plant, rides the elevator to the new floor and sits at its new desk | P0 |
| New hire | Derived: a holder with a tier appears that was not drawn before (not on load) | Non-blocking | The character walks in from the street, takes the elevator, and sits at the desk with the NEW chip | P0 |
| Layout shift | Rooms reorder on the same floor | Non-blocking | Characters walk to their new desks | P0 |
| Low reserve | `reserve_low` | 1.5 s | The vault pulses three times, then holds its steady low state | P0 |
| Building state change | Employee count crosses a threshold | 300 ms | Crossfade and a boss line (§12.3). The 4 s construction sequence is Later | P0 |
| Employee of the Day | Jackpot; no v1 event | 1 s | Gold ring on the head, one burst of paper confetti. This is the only confetti in the product | Later |
| Bankruptcy | No v1 event | 3 s at most | Floors go dark one by one, 120 ms apart, then the vault empties and the sign flips to Closed | Later |

“Non-blocking” means the walk plays alongside whatever comes next and does not delay it. The card, the dock and the feed show the new state as soon as the event arrives.

#### 14.3.1 Finalize choreography

The contract emits `rehired` and `streak_milestone` during each finalize call, and `payroll_allocated` and `task_finalized` only on the last call. The client holds every event of task N until `task_finalized` for N arrives. Everyone is already seated, because results-pending allows only the desk (§5.7). The client then reads the submissions and employee statuses and plays, in order:

1. Results (pass and miss dots, cheer and slump).
2. Streak milestones; rehires start walking in.
3. Payday.
4. Layoffs start, from the status changes.
5. The boss's summary bubble, with the face from §17.1.

Steps 1 to 5 take 8 s at most; the rehire and layoff walks may continue afterward. A tap skips to the end. A client that loads while a task is Finalizing shows “Results pending” until `task_finalized` arrives.

### 14.4 Performance budget

- Animate only position, scale, rotation, alpha, tint and texture frame. Never rebuild Pixi `Graphics` or `Text` per frame. Characters, furniture and building tiles come from one texture atlas.
- Cache each floor's static layers (§4.1) as a texture and redraw it only when its contents change.
- Draw only floors in view (roadmap W-03). Agents outside the view are not updated; because the idle schedule is closed-form, an agent that scrolls into view computes its position directly.
- At least 50 fps with 150 characters walking and working on a laptop (the roadmap W-17 gate). Aim for 60 fps, and check on a mid-range phone.
- At most 200 animated agents at a time. Past that, the agents farthest from the camera center freeze in their home pose.
- Sprite animations use 8 frames or fewer.
- Pause the ticker when the tab is hidden. On return, apply the catch-up rule in §14.1.

### 14.5 Reduced motion and sound

- The client reads `prefers-reduced-motion` at start and follows changes to it.
- When reduced motion is on: no idle trips (everyone stays home and holds a still pose), no walks, rides, or coin flights, and no typing effect. Scripted moves become 100 ms fades from the old place to the new one. The camera jumps instead of panning. A building state change is a still frame with a caption. State is still carried by dots, rings, numbers, the feed, and the dock.
- Sound is off by default, never autoplays, and may only accompany a signature moment.

### 14.6 Never

- Parallax scrolling, screen shake, or endless glowing pulses.
- Anything that flashes more than three times per second.
- Confetti on ordinary actions.
- A spinner while waiting. Use the boss's bubble instead, for example “Reviewing your submission…”.
- Any animation that hides information the player needs to act.
- Extra people: every character except the boss is a wallet (§4.5).
- Idle behavior that suggests state that is not true (§5.7).

## 15. Design system components

The design system is a small, strict kit. Every screen is built from these parts, and nothing is styled one-off. Components carry the `Rg` prefix (for example `RgButton`).

### 15.1 Foundations

| Foundation | Rule |
| --- | --- |
| Color | Only the tokens in §6. No raw hex values inside components |
| Spacing | 4, 8, 12, 16, 24, and 32 px |
| Radius | 4 px for chips, 6 px for buttons and inputs, 8 px for cards, HUD surfaces and bubbles |
| Borders | 1 px for dividers and 2 px for emphasis |
| Type | The scale in §7 |
| Themes | Dark only. There is no light theme or theme toggle |

### 15.2 Component list

| Component | Layer | Variants | States | Rules |
| --- | --- | --- | --- | --- |
| `RgButton` | DOM | Primary, secondary; sizes medium and small | Default, hover, focus, pressed, disabled, loading | One primary per view (§3.1). The loading label is in voice, for example “Filing…”. Disabled is 50% opacity with no pointer cursor |
| `RgInput` | DOM | Text | Default, focus, error, disabled | Error text is in the boss's voice and says what to do |
| `RgCard` | DOM | Default, emphasized (accent border) | Default | Header and body slots |
| `RgTopBar` | DOM | Wide, compact (≤ 820 px) | Default, preview | §3. Holds the company popover trigger and Go to my desk |
| `RgDeskDock` | DOM | Dock, bottom sheet (≤ 820 px) | Expanded, collapsed | Holds `RgTaskPanel`. Collapsed shows the status line and the primary button |
| `RgTaskPanel` | DOM | One per task type | Idle, open, reapply, pending, submitted, rejected, closed, passed, missed, claimable, claim pending, claimed, claim blocked, forfeited, provable (P1) | Puzzle, input, and the primary button in one card. Rejected shows the mapped copy from §13.2 |
| `RgFeed` | DOM | Ticker, expanded | Default, empty | Polite live region. Item types: task, submission, payroll, claim, forfeit, layoff, rehire, promotion, new hire, streak, income, system |
| `RgBadge` | DOM and Pixi | Streak, tier, status, new hire, simulated | Default | A 4 px radius chip. Text plus color, never color alone |
| `RgTooltip` | DOM over the canvas | Character, vault | Hidden, shown | Appears on hover. Contents are plain text |
| `RgCharacterCard` | DOM over the canvas | Default | Open, closed | §3. Follows its character. Closes on Escape and on a tap outside |
| `RgToast` | DOM | Boss message | Shown, dismissed | One at a time, 4 seconds, never used for errors that need action |
| `RgDialog` | DOM | Wallet connect (including the demo burner), claim confirmation, ledger | Open, closed | Traps focus, closes on Escape, returns focus to the trigger |
| `RgSimBanner` | DOM | Preview banner | Shown | §12.4. Cannot be dismissed |
| `RgEmployeeList` | DOM | Default | Default, empty | P1. Building order; each row opens the card |
| `RgBuilding` | Pixi | The five states in §12 | Normal, preview, low reserve; upgrading and bankrupt (Later) | Shell, roof sign, street, and the stack of floors. Draws only visible floors |
| `RgFloor` | Pixi | One per tier, plus penthouse, lobby and basement | Default; dark for lease or bankruptcy (Later) | Back wall in the room tint, plaque on the first floor of a tier, rooms, amenity bay, its slice of the core. Static layers cached |
| `RgRoom` | Pixi | Private office, glass office, cubicle, shared seat | Empty, occupied, laid off | Holds one desk. Carries the desk overlays (§5.4). Empty rooms are outlines in Desk edge |
| `RgCore` | Pixi | Stairwell, elevator, tube | Elevator idle, moving, doors opening, doors closing | One cab; rides queue (§4.4) |
| `RgAgent` | Pixi | Employee (body color, hair), visitor outline | The animations in §5.2; the statuses and overlays in §5 | Props: wallet hash, status, overlays. Driven by the life controller (§5.5); never decides anything itself |
| `RgBoss` | Pixi | Smug, smile, twitchy | Idle, walking, riding, pointing | §5.8 |
| `RgBossBubble` | Pixi | Message, announcement | Typing, shown | The tail points at the boss. Layoff announcements use the ink border instead of the accent |
| `RgVault` | Pixi | Round door; per-state art (Later) | Healthy, low; bankrupt (Later) | Shows reserve, a fill bar, the coin pile, and runway as text. Low means below `reserve_low` |
| `RgStreet` | Pixi | Default | Default | Visitors' queue, the bench, the street lamp, the crowd sign (`RgCrowdSign`, shown whenever a crowd account is drawn, §12.5) |

### 15.3 Component rules

1. **Every component has all of its states drawn** before it is built.
2. **State comes from the model, never from inside.** Components never read the chain or the state source. A parent passes in the model computed by `packages/core` (layout, statuses, pay amounts), so the same components render live data and the growth preview.
3. **Meaning is never color alone.** Pair color with a shape, a label, or a number.
4. **Every interactive DOM control has an accessible name**, a visible focus ring, and a touch target of at least 44 px on phones. Canvas targets reach 44 px through tap-to-zoom (§10).
5. **Variants are added by exception.** A new variant needs a reason that an existing one cannot meet, and it is added here first.
6. **Copy lives with the component.** Default labels and messages follow §13.

### 15.4 Documentation and checks

- **Unit tests** (P0, roadmap W-16) cover the tower model, the layout, and the wallet-hash appearance in `packages/core`, and navigation and the idle schedule in `apps/web` (same inputs give the same positions; no forbidden activity in any state of §5.7; every activity fits its slot).
- **Component gallery** (P1). One page shows every DOM component and every Pixi object in every state at 360, 820, and 1,100 px wide. It doubles as the visual test page.
- **Later:** a lint rule that rejects raw hex values and off-scale spacing, and a snapshot test per component state with a reduced-motion check.
- A component is done only when it passes the three-question test in §13.3.

## 16. Build notes

- **Client:** Vite, TypeScript, and PixiJS v8 (roadmap W-01). The building, agents, boss bubble and crowd sign are drawn in Pixi. The top bar, dock, feed, card, tooltip, dialogs, and the preview banner are DOM.
- **Modules in `apps/web/src`:**
  - `building/`: `RgBuilding`, floors, rooms, core and street; static layers cached per floor.
  - `nav/`: aisles, points of interest, stairs and elevator links, pathing. Pure TypeScript, no Pixi.
  - `life/`: the idle schedule (§5.6) and the allowed-activity table (§5.7). Pure TypeScript, no Pixi.
  - `agents/`: the agent controller and its sprites; executes scripts and schedule activities.
  - `director/`: turns the event queue into scripts and the finalize choreography (§14.3).
  - `hud/`: the DOM components.
- Characters, the boss, props and building tiles come from one texture atlas, `art/characters.png` with `art/characters.json` (Pixi spritesheet format, rig in `meta.rig`), generated by `npm run art`. The shirt and hair layers are tinted from the wallet hash. Placeholder art until the final art lands (§5).
- The renderer reads one state source: live (contract views plus `get_events`) or the seeded growth preview. It holds no game logic; layout, statuses, and pay amounts come from `packages/core`. The life system decides only where characters stand, never what is true.
- Every color is a token in one file, so theming and rebranding stay a one-file change.
- `npm run demo` runs the client against a local chain with a bot crowd, labeled as in §12.5.

## 17. Design decisions

### Settled

1. **The boss's face reflects the day's pass rate.** The pass rate is `passed / submitted` from the latest `task_finalized`. One sprite with three expressions: smug at 90% or more, a forced smile from 50% to 89%, and twitchy below 50% or when nobody submitted. The cut-offs are client display constants that match the difficulty defaults in product spec §4.4. The code picks the face from the real pass rate, never the LLM. Layoff announcements reuse the twitchy face.
2. **Appearance is purely cosmetic.** Body color and hair come from the wallet hash and imply nothing about the contract. Badges can appear later as desk items instead, such as a plant for a long streak or a gold hard hat for Employee of the Day.
3. **The camera fits the building's width and pans vertically** (§10). On load it shows the whole building if it fits, else the player's desk, else the top floors. Go to my desk is always available once badged in. There is no continuous follow in P0. Under reduced motion every camera move is a jump. On phones, tap-to-zoom applies (§10).
4. **The building has no memory.** Building state and floors are pure functions of current state (§4, §12.3).
5. **Pixi for the building, DOM for everything else** (2026-11-08).
6. **A living building, not a desk grid** (2026-11-09). Characters walk, work and idle inside a layered cutaway; the desk carries the state (§1, §5.5). Desks per floor are 4/6/8/12 so every floor has the same width. The stage is full width with a HUD. P0.
7. **Idle behavior is deterministic** (2026-11-09). It is a closed-form function of wallet, task id and wall-clock slot, so every client shows the same building and needs no simulation history (§5.6).
8. **No extra people** (2026-11-09). Every character except the boss is a wallet, so every figure on screen means something.

### Palette

**Blueprint is the palette.** Navy paper with a pale cyan accent (#6ad4ff) and dark button text (#0a1626), with the neutrals, body colors, room tints and building tokens in §6. The accent colors the boss, the player's ring, the primary button, and the signage, always through tokens. Contrast was measured on 2026-11-08 (§6); re-measure when a token changes.
