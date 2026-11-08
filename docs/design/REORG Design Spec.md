# REORG: Design Spec

*Company: Reorg Inc. Ticker: $REORG. Hold the token. Get hired. Survive the reorg.*

Version 1.1. This spec describes the visual and interaction design of the REORG tower client (`apps/web`). It began from an HTML design prototype; where the two differ, this spec wins. Rules and data come from `docs/PROTOCOL.md` (normative) and the decisions in `ROADMAP.md` §2. This spec decides only how that state looks and moves, never what it is.

**Scope labels.** Every item that is not part of the base build carries a label:

- **P0**: hackathon build (roadmap P0). Unlabeled items are P0.
- **P1**: ships if the roadmap's 11-12 check is green.
- **Later**: roadmap P2 or after the hackathon.

## 1. Design intent

The app is a game, not a dashboard: a flat, side-on cutaway of an office tower where every holder is a small employee at a desk. Five principles guide every decision:

1. **The picture is the state.** Anything that carries meaning on screen comes from contract views, contract events, or state that `packages/core` derives from them. Idle motion is cosmetic only, and it never contradicts the chain.
2. **Readable in one second.** A newcomer should understand "people work, get paid, get laid off" from the first screen, before reading a word.
3. **Corporate parody, played straight.** The look is flat and tidy like an office poster. The humor lives in the boss's copy, not in noisy visuals.
4. **Scales without changing.** The same tower works for 8 employees and for 2,000. More holders means more floors, never a different design.
5. **Same tower for everyone.** The tower is a pure function of current state. Two clients that read the same chain state draw the same picture, no matter how long either has been open.

## 2. Brand and voice

| Element | Value |
| --- | --- |
| Company name | Reorg Inc. |
| Ticker | $REORG |
| Tagline | Hold the token. Get hired. Survive the reorg. |
| Mark | The word REORG in the heading weight, with the accent color as the only decoration |
| Primary accent | Pale cyan (#6ad4ff), used for the boss, the player's ring, and the main button |

**Boss voice.** A passive-aggressive corporate executive who is relentlessly upbeat about bad news. Sample lines:

- Task open: “Per my last memo: decode today’s word before close of business.”
- Layoff: “We are rebalancing our talent. Thank you for your service.”
- Good day: “Great work, team. Synergy is up.”

Rules for copy: short sentences, buzzwords used on purpose, never cruel toward a real person, and no copy that implies money advice. Copy never tells anyone to buy or sell; it states rules.

## 3. Screens and layout

The main screen has two columns: the tower, drawn in a PixiJS canvas, on the left, and a side panel, built in DOM, on the right. The columns split 1.5 to 1 with a 16 px gap and a maximum width of 1100 px. Below 820 px the panel stacks under the tower.

| Screen | What it contains | Scope |
| --- | --- | --- |
| **Tower (main)** | The full cutaway: penthouse with the boss's speech bubble, tier floors, lobby, and the vault and server room in the basement | P0 |
| **Side panel: company** | Day number (the task id: “day” means task, not calendar date), task status with a countdown, headcount by tier, reserve and runway, and the **Preview growth** toggle (§12.4) | P0 |
| **Side panel: my desk** | The player's account, title, share of supply, streak, misses in a row out of `layoff_after` (or tasks left while laid off), total earned, claimable salary, today's puzzle, and the primary button (§3.1) | P0 |
| **Side panel: feed** | The last 8 items, newest first: contract events and the boss's announcements | P0 |
| **Character card** | Click or tap a character: account, title, share of supply, status, streak, badges, last 7 results, and a SIMULATED tag for crowd accounts. Hover shows a short tooltip with account, title, share, and streak | P0 |
| **Ledger** | Opens from the vault: income by tag (simulated income marked), salaries paid and forfeited, operating costs, runway. Each row links to its transaction on testnet; the local sandbox shows the transaction hash only | P0 |
| **Employee list** | A DOM table of every character in tower order. The keyboard and screen-reader path to every card (§11) | P1 |

**Task status in the company panel.**

| Contract state | Shown |
| --- | --- |
| Open, before `closes_at` | “Open. Closes in 4:12.” |
| Closed (derived) or Finalizing | “Closed. Results pending.” |
| Finalized | “Finalized.” Plus a countdown to the next opening if the boss service reports one |
| No task yet | “No task posted. The boss is in a meeting.” |

### 3.1 The primary button

The side panel has exactly one primary button at a time, or none. It follows the player's situation, checked top to bottom; the first match wins:

| Situation | Primary button | Otherwise the panel says |
| --- | --- | --- |
| Wallet not connected | **Badge in** (wallet connect; in demo mode, the burner demo player) | |
| Task open, no submission yet, laid off | **Reapply** (submits as a reapplication) | “Reapplication work is unpaid. Pass and you are rehired.” |
| Task open, no submission yet, has a tier | **Submit answer** | |
| Claimable salary on any finalized task, and the anti-dump rule holds | **Claim salary** with the amount | |
| Claimable, but the current balance is below `antidump_bps` of the snapshot | none | The claim-blocked copy in §13.2. The client never sends a claim that would forfeit |
| Own answer verifies against the revealed secret, not on the pass list, and the prove window is open (P1) | **Prove my pass** | |
| Anything else | none | Status copy: submitted, visitor, results pending |

The client has no controls for opening or finalizing a task. The boss scheduler runs the day.

## 4. The tower

From top to bottom, each band is one floor type with its own tint. A 2 px ink outline with 6 px corner radius frames the whole tower.

| Band | Contents | Desks per floor |
| --- | --- | --- |
| Penthouse | Boss figure and a speech bubble with the boss's latest message | Not applicable |
| Directors | Private offices | 4 |
| Managers | Glass offices | 6 |
| Associates | Cubicles | 10 |
| Interns | Shared open-plan desks | 16 |
| Lobby | Visitors (outlined figures), the HR door, and the simulated-crowd sign (§12.5) | Not applicable |
| Basement | Treasury vault (reserve, a fill bar, runway) and the server room | Not applicable |

**Floor anatomy.** Each floor is a row with 8 px vertical and 12 px horizontal padding, a 1 px line below, and a fixed-width label on the left (84 px, 12 px type, weight 600) with the headcount as a small muted second line. The label appears only on the first floor of a tier. Desks fill the rest of the row in an equal-width grid with 4 px gaps. Desks are 40 px tall (30 px on phones, §10).

**Floors per tier.** A tier with `n` characters has `max(1, ceil(n / desks per floor))` floors. An empty tier still gets one floor of empty desks, so the org chart is always complete. Desk order comes from `layoutTower()` in `packages/core` (tier, then balance descending, then account id). The renderer never re-sorts.

**Empty desks** are drawn as an outline in the Desk edge color with no fill and no character.

**Changes during a day.** Layout is recomputed from current state, so a floor disappears when its last holder sells out, and desks shift when balances reorder. Characters slide to their new desk in 200 to 300 ms; a removed floor fades out in 150 ms.

**Lobby.** Visitors, meaning holders whose balance gives no tier, stand outside the glass doors as outlined figures that are never filled in: up to 5, then a “+n” label. Laid-off employees walk out through the HR door (§14.3). Accounts in `excluded_accounts` (deployer, contracts, LP, crowd root) are never drawn.

**Vault.** The reserve is shown in NEAR with one decimal place, above a 10 px bar in the coin color. The bar shows `min(1, runway_tasks / 30)`, where 30 is a client display constant, not contract config. Runway is written as plain text in tasks: “Runway: 42 tasks.” If `operating_cost` is 0, the bar is full and the text reads “No operating costs.”

- **Low reserve** means the reserve is below the contract's `reserve_low` threshold (from `get_treasury`). The bar and the vault outline turn to the Bad color with a “LOW” label, steady, with no looping pulse. The `reserve_low` event adds one alarm (§14.3).

**Server room** (P1). A static rack beside the vault. When the boss service reports `STALLED` on `/healthz`, the rack shows a red “STALLED” tag and the feed explains it.

## 5. Characters

Each wallet is one small pixel-art office worker, made of at most three sprites from one atlas so thousands can render cheaply. The sprites, their frames and the rig live in `art/` (`npm run art`; see `art/README.md`). **TODO(art): the current sprites are placeholder art, to be replaced by the final character art with the same frame names, sizes and layers.**

**Anatomy**

- Seated character: 16 by 20 sprite pixels, head in rows 0 to 11, shirt and tie below. The frame ends at the desk top, which sits 25 px below the top of the 40 px desk cell; the chair is drawn behind and the desk front in front.
- Layers: a fixed-color base (skin in the shared skin tone, face, trousers), a grayscale shirt layer tinted with the body color, and a grayscale hair layer tinted with a hair color (P1). All share one anchor, bottom center.
- Body color: one of 8 body tokens (§6). The index is `sha256(utf8(wallet))[0] mod 8`, computed in `packages/core` (roadmap W-04) so every client picks the same color.
- Poses: seated facing out (between tasks), seated in profile typing (task open), walking, walking with a box (layoff), and the lobby visitor outline. Profile frames face right and are mirrored to face left.
- Rendering: textures from one atlas with nearest-neighbor filtering, tinted at runtime. Nothing is redrawn per frame.
- Hair (P1): style `sha256(utf8(wallet))[1] mod 5` (short, long, bun, curly, none) and color `sha256(utf8(wallet))[2] mod 6`. In P0 every character has the short style in the first hair color.

**Status.** Exactly one per character, computed in `packages/core` (PROTOCOL §6.5).

| Status | Visual | Source | Scope |
| --- | --- | --- | --- |
| New hire | Seated at a desk on the tier of the current balance, with a “NEW” chip in the desk's top-left corner | Token holder with a tier and no employee record | P0 |
| Active | Seated at the desk | Employee status `active` | P0 |
| Struggling | As active, plus a sweat drop. In P0 the misses show only in the card, tooltip, and my-desk panel | Employee status `struggling` (`misses_in_row` ≥ 1) | Sweat drop P1 |
| Laid off | Not at the desk. The desk dims to 40% and shows a small box outline in ink | Employee status `laid_off` | P0 |
| Visitor | Outlined figure in the lobby | Balance below the lowest tier threshold | P0 |

Employees sit on the tier of their most recent submission snapshot (`last_tier`), so a tier change shows at the next submission. New hires sit on the tier of their current balance.

**Overlays.** These stack on top of the status.

| Overlay | Visual | Source | Scope |
| --- | --- | --- | --- |
| Working | Body bobs 2 px on a 1.2 s loop | A task is Open and before `closes_at`, and the character is not laid off | P0 |
| Submitted | A small paper sheet on the desk | A submission exists for the open task (`submission_received`, `get_submission`) | P0 |
| Passed | 7 px coin-colored dot with a check mark, in the desk's top-right corner | The character's submission to the last finalized task passed (`list_submissions`). Shown until the next `task_opened` | P0 |
| Missed | Same dot in the Bad color with a cross | Submitted to the last finalized task and did not pass. Wallets that did not submit get no dot; their misses show as struggling or laid off | P0 |
| Streak | Muted number in the top-left corner | `effective_streak` ≥ the first value in `streak_milestones` | P0 |
| Flame aura | One level per milestone reached | Number of `streak_milestones` ≤ `effective_streak` | P1 |
| Payday | Small Good-colored “+amount” rises 14 px and fades over 1.6 s | `payroll_allocated`. The amount is that wallet's pay, from the core pay-math mirror over `list_submissions` or from `get_claimable` | P0 |
| Claimed | A coin pops once at the desk | `salary_paid` | P1 (the feed item is P0) |
| Forfeited | “−amount” in the Bad color, rises and fades like Payday | `salary_forfeited` | P1 (the feed item is P0) |
| You | 2 px accent outline with 1 px offset | Connected wallet | P0 |
| Employee of the Day | Gold ring around the head | Jackpot; no event in v1 | Later |

Simulated crowd accounts carry no mark on the desk. The lobby sign and the card cover them (§12.5).

## 6. Color

REORG ships in dark mode only. There is no light theme and no theme toggle. Colors are tokens defined once in `apps/web/src/theme/tokens.ts` and exported both as CSS variables for the DOM and as numbers for Pixi. The palette is Blueprint: navy paper with a pale cyan accent.

| Token | Value | Use |
| --- | --- | --- |
| Background | #0a1626 | Page |
| Panel | #11233a | Cards and tower body |
| Ink | #e6f1fb | Text, the tower outline, the laid-off box |
| Muted | #8fa6bf | Secondary text |
| Line | #25405d | Dividers on panels only. Never used for an edge that carries meaning |
| Desk edge | #6a8aad | Desk outlines and empty desks |
| Accent | #6ad4ff | Boss, player ring, primary button, signage |
| Button text | #0a1626 | Text on the accent |
| Good | #4cc38a | Payouts and success text |
| Bad | #ff7b7b | Misses, low reserve, and error text |
| Coin | #f2c230 | Passed dot, vault bar |
| Skin | #e9b98f | Character heads |

**Body colors.** Hues avoid the accent, Bad, Coin, and Good, so no character can be mistaken for the player, the boss, or a result.

| Token | body-0 | body-1 | body-2 | body-3 | body-4 | body-5 | body-6 | body-7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Value | #c8d879 | #98d879 | #79d881 | #7990d8 | #8979d8 | #b079d8 | #d879d8 | #d879b0 |

**Floor tints**

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
| Cardboard, cardboard shade | #c49a5a, #8f6a38 | The layoff box; the boss's coffee |
| Plant, plant dark | #6fb07e, #3f7a50 | The desk plant in the layoff box |
| Hair (P1) | #5a3b26, #8a5a32, #d6b16a, #b9c2cc, #2f3a4f, #a8452e | Tint for the hair layer, by wallet hash |

The boss's hair is the Muted token and the boss's blazer is the Accent token.

**Measured contrast** (WCAG 2.x, 2026-11-08). Every text color is at least 4.5:1 on the background, the panel, and every floor tint; the lowest is Muted on Associates at 4.56:1. Button text on the accent is 10.8:1. Desk edge is at least 3.19:1 on every tint, and every body color is at least 3.16:1. Re-measure whenever a token changes.

## 7. Typography

One family only: the system UI stack (`system-ui`, then the platform fonts), in the DOM and in Pixi text alike. No web font is loaded, so the app starts fast and works offline. Desk micro text uses a bitmap font generated at load from the same family.

| Role | Size and weight |
| --- | --- |
| App name | 26 px, bold, tracking -0.02em |
| Card heading | 15 px, bold |
| Body (including the memo text) | 15 px, line height 1.45 |
| Secondary text | 13 px, muted |
| Simulated labels | 13 px, weight 600, ink |
| Floor label | 12 px, weight 600 (10 px on phones) |
| Puzzle cipher (the encoded line only) | 22 px, bold, letter spacing 0.15em |
| Feed items | 13 px |
| Desk micro text (streak, NEW, payout) | 9 px |

Punctuation in all visible text uses typographic apostrophes, quotes, and the ellipsis character (…).

## 8. Components

These are the DOM components. Pixi objects are listed in §15.2.

- **Primary button.** Accent fill, button-text color, 12 by 16 px padding, 6 px radius, weight 600. One per screen at a time.
- **Secondary button.** Transparent with a 1 px line border, 8 by 12 px padding. A selected toggle uses the accent for border and text. Minimum height 44 px on phones.
- **Card.** Panel fill, 1 px line border, 8 px radius, 12 px padding, 12 px gap below.
- **Speech bubble.** Panel fill, 1 px accent border, 8 px radius. Used only by the boss, and drawn in Pixi.
- **Text input.** 150 px wide, line border, uppercase transform, `autocapitalize="characters"`, `autocomplete="off"`, `spellcheck="false"`. Enter submits. The contract normalizes case and maps 0 to O and 1 to I, so the input does not need to.
- **Feed.** An unstyled list with 1 px dividers. It is a polite live region so screen readers announce new items.
- **Focus ring.** A 3 px ink outline with 2 px offset on every interactive DOM element.

## 9. Motion

| Motion | Spec | Scope |
| --- | --- | --- |
| Working bob | `translateY(-2px)`, 1.2 s, ease-in-out, infinite | P0 |
| Payout rise | Fade out while rising 14 px, 1.6 s, once | P0 |
| Alarm light | Penthouse and floor lights pulse three times when a task opens, then stop | P0 |
| Coin pipes | Coins travel from the vault to desks, tier by tier, on payday | P0 |
| Walk-out and walk-in | Layoff and rehire walks between the desk and the HR door | P0 |
| Elevator | A character rides to its new tier floor in about 1.5 s | Later |
| Crane | A crane lowers a new floor into place when a tier fills | Later |
| Lights out | Floors go dark one by one on bankruptcy | Later |

Reduced motion is defined once, in §14.5.

## 10. Responsive behavior

| Width | Change |
| --- | --- |
| Above 820 px | Two columns |
| 820 px and below | Single column with the side panel under the tower |
| 520 px and below | Floor label 56 px wide at 10 px type, desk height 30 px, characters scaled to 70%, floor padding 4 by 8 px. Desks show a coin instead of “+amount”; exact amounts appear only on the player's own desk and in the card |

The canvas fills its column, follows the column's size, and caps the device pixel ratio at 2. The page declares `viewport-fit=cover` and pads the root by the safe-area insets so nothing hides under phone system bars. The tower never scrolls sideways. When the tower is taller than the canvas, dragging or scrolling on the canvas pans the camera vertically; otherwise the page scrolls as normal.

**Touch.** An intern desk on a 360 px phone is about 14 px wide, far below a 44 px target. On phones, the first tap on a floor zooms the camera so its desks are at least 44 px wide; a tap on a character then opens its card.

## 11. Accessibility

- Contrast is measured in §6. Meaning never relies on color alone: pass and miss carry a check mark and a cross, and low reserve carries a “LOW” label.
- The canvas has `role="img"` and an `aria-label` summary, refreshed on each `task_opened` and `task_finalized`. Example: “Reorg Inc. 18 employees. Task 5 is open, 12 submitted.”
- The feed announces items politely. The my-desk panel exposes the player's own state as text.
- Focus rings are always visible on DOM controls, and the puzzle input submits with Enter.
- Characters inside the canvas are not keyboard-reachable. The employee list (P1) is the keyboard and screen-reader path to every card. Until it ships, the my-desk panel and the feed carry the same information. The README lists this as a known gap.
- Nothing flashes more than three times per second.
- Reduced motion: §14.5.

## 12. Tower states from holder count

The tower is not one picture that gets taller. It has five named states, each with its own building, surroundings, and camera, chosen by the current employee count: characters with a tier, excluding visitors and excluded accounts, as computed by `packages/core`. At the default thresholds the company cannot exceed 2,000 employees; the cap follows the lowest tier threshold.

The accent color marks the company signage at every state: a cardboard sign, a painted sign, a rooftop sign, a ticker, and finally a blimp.

### 12.1 What each count drives

- **Employee count** picks the tower state, the building form, and the skyline.
- **Visitor count** (holders below the lowest tier) fills the lobby and the street: up to 5 outlined figures, then a “+n” label.
- **Tier fill** adds floors inside a state, as described in section 4.
- **Reserve level**, not holder count, drives lighting: the vault shows its low state when the reserve is below `reserve_low`, and floors go dark on bankruptcy (Later).

### 12.2 The five states

| State | Employees | Building | Surroundings | Boss and vault | Camera and characters |
| --- | --- | --- | --- | --- | --- |
| Garage startup | 1 to 10 | One-story garage with a roll-up door and a cardboard sign | Empty lot, one tree | Boss at a folding desk in a loft; vault is a cash box | Fixed camera fits the whole building; characters drawn at 140% |
| Small office | 11 to 50 | Low-rise with a painted sign; windows light up as desks fill | Parking lot and a coffee cart | Penthouse office with a window; vault is a wall safe | Fixed camera; characters at 100% |
| Office tower | 51 to 250 | Glass tower with a lit rooftop sign, elevators, and a turnstile lobby | City blocks behind; a day and night cycle begins | Executive penthouse; vault has a round door | Camera jumps to the player's desk on load (§17.3); elevators carry promotions |
| Skyscraper | 251 to 1,000 | Tall tower with an antenna, a helipad, and a ticker sign reading $REORG | Clouds drift past the upper floors | Glass office at the top with a city view; vault is a bank-style walk-in | Zoom levels and a minimap; near floors at 80%, far floors as color strips |
| Megacorp | 1,001 to 2,000 | Twin towers joined by a sky bridge, the second rising as the first fills | Full skyline and a blimp carrying the boss's latest announcement | Boardroom with a long table; vault has double doors | Tower switcher; only near floors in detail, strips elsewhere |

In every state the number of floors comes from tier fill (§4), so even Garage startup has one floor per tier.

**Scope.** P0 draws, for the first three states, the interior floors, lobby, penthouse, and vault, plus the state's sign text and character scale. Building exteriors, surroundings, the per-state vault art, elevators, day and night, and the whole of Skyscraper and Megacorp are Later.

### 12.3 Changing state

- **No hysteresis.** The state is a pure function of the current employee count. Hysteresis would need past counts, which the chain does not store, so a fresh client and a long-running one would disagree. Flicker near a boundary is accepted. If it becomes a problem, drive hysteresis from chain data, such as the `submitted` count of the last finalized task.
- **Seen live.** When a client sees the state change while it is open, it crossfades in 300 ms and the boss says “We have outgrown our space.” on the way up or “We are right-sizing our footprint.” on the way down. The 4 second construction sequence (scaffolding, crane, ribbon cutting) and the “For lease” banners are Later.
- **Fresh load.** A client that loads mid-day draws the current state with no transition.

### 12.4 Growth preview

Live data stays within the first two states (≤ 50 employees, roadmap D18). A **Preview growth** toggle in the company panel switches the client's state source to a seeded simulation with 8, 24, or 60 employees, covering the first three states.

- While the preview is on, a full-width **SIMULATED PREVIEW** banner sits across the top of the canvas, with the same text in the company panel. It cannot be dismissed.
- Simulated and live characters never share a screen. Turning the toggle off returns to live state.

### 12.5 Simulated data labels

The demo's holders and income are bots. The interface says so wherever they appear:

- **Crowd.** While any drawn character is a crowd account, a taped paper sign in the lobby reads “SIMULATED CROWD: these employees are bots.” The company panel shows “Crowd: simulated (N bots).” Their cards and tooltips carry a SIMULATED tag. The client learns which accounts are crowd accounts from deployment config (the crowd root account), never by guessing.
- **Income.** Ledger rows deposited by the income bot are marked “simulated”.
- **History.** In the local demo, the first feed item reads “Records before you arrived were generated by bots on a local chain.”
- Simulated labels use the 13 px label style in ink, never muted, and never hide on phones.

## 13. Rules against generic, AI-looking design

REORG parodies office life, so its look has to come from that world. The product uses AI for the boss's text, but nothing in the interface should look like a generic AI product. A screen passes only if it could not be mistaken for a template.

### 13.1 The rules

1. **Everything comes from the office.** Visuals are built from desks, memos, org charts, HR forms, sticky notes, and fire-exit signs. If an element could sit unchanged in any crypto dashboard, redraw it.
2. **No default AI or crypto look.** Banned: purple-to-blue gradients, glowing orbs, frosted-glass cards, neon on black, sparkle or magic-wand icons, brain or circuit motifs, floating 3D coins, and stock robot faces.
3. **The boss is a character, not an icon.** A flat figure with a tie, a lanyard, and a mug, whose expression changes with the day's results. Never a glowing head or a chat-bot avatar.
4. **Flat and hard-edged.** Solid fills, 1 to 2 px outlines, small radii, at most one subtle shadow level, and no gradients or blur.
5. **All art is made, not generated.** Characters, props, and buildings are vector or pixel art built from code and a hand-drawn kit. No stock photos, no AI-generated images or faces, and no icon pack used without redrawing it in the house style.
6. **Hierarchy through size and weight.** One type family, no decorative display fonts, no giant gradient headline, and no tracked all-caps everywhere. The SIMULATED labels are the one deliberate all-caps exception.
7. **Break the template grid.** The tower dominates the screen and the side panel is plain and utilitarian. No row of three equal cards with icons, no uniform pill buttons, no centered hero.
8. **Copy has a point of view.** Write in the boss's voice or plain office language. In interface copy, the README, and posts, these words are banned: unlock, supercharge, revolutionize, seamless, elevate, leverage, next-generation, and “welcome to the future.” The boss's own lines may use any corporate buzzword, “leverage” and “synergy” included, because the parody is the point. No decorative emoji, and no exclamation marks outside the boss's passive-aggressive cheer.
9. **Errors and empty states are jokes with a job.** They say what happened and what to do, in voice.
10. **Every decoration earns its place.** It either shows state or delivers a joke. If it does neither, remove it.

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

Before any screen ships, ask: (1) With the logo covered, is it still clearly REORG? (2) Could this screen become a template for another app just by swapping the colors? (3) Does every decoration show state or tell a joke? A “no” to the first, a “yes” to the second, or a “no” to the third sends the screen back.

## 14. Animation rules

Animation in REORG is information first and charm second. Every movement must tell the player something happened, where to look, or who the boss is.

### 14.1 Principles

1. **Three jobs only.** *Meaning* (pass, miss, pay, layoff), *orientation* (camera moves, a floor appearing), and *personality* (the boss, idle life). Motion that does none of these is removed.
2. **Events drive animation.** Every meaningful animation is triggered by a contract event or by a change in derived state (layoff, tier change, new hire), never by a timer of its own. Idle motion is the only exception, and it never implies state.
3. **Order and catch-up.** Events play in `seq` order, except the finalize group (§14.3.1). On load the client starts from the latest `seq`: it draws current state and animates only newer events. If more than 20 are queued, for example after a tab was in the background, skip to the final state and show one summary line in the feed.
4. **Small and quick.** The player does the same actions every day, so nothing may make them wait. Every sequence can be skipped with a tap.
5. **Stagger to read.** When many things change at once, start them 150 ms apart in a fixed order (the payroll bucket order: Directors, Managers, Associates, Interns) so the eye can follow.

### 14.2 Timing and easing

| Kind | Duration | Easing |
| --- | --- | --- |
| Micro feedback (press, hover) | 100 to 150 ms | ease-out |
| State change on a character or desk | 200 to 300 ms | ease-out |
| Movement across the tower (elevator, walk) | 800 to 1,500 ms | ease-in-out |
| Entering elements | 200 ms | ease-out |
| Leaving elements | 150 ms | ease-in |
| Loops (idle bob) | 1,200 ms | ease-in-out |
| Ceremony (tower upgrade, Later) | 4,000 ms maximum | scripted |

No linear easing except for rotation. No bounce or elastic overshoot, except a small two-frame squash on the coin pop.

### 14.3 Signature moments

| Moment | Trigger | Length | What happens | Scope |
| --- | --- | --- | --- | --- |
| Task opens | `task_opened` | 1.5 s | Alarm light pulses three times, the boss's bubble types in, characters turn to their monitors | P0 |
| Submission | `submission_received` | 300 ms | The monitor flashes once and a paper sheet lands on the desk | P0 |
| Results | `task_finalized`, with `list_submissions` | 1.5 s at most | Pass and miss dots appear, tier by tier | P0 |
| Streak milestone | `streak_milestone` | 1 s | The streak number pops; the flame grows (P1) | P0 |
| Rehire | `rehired` | 1.5 s | The character walks in from the HR door and sits down | P0 |
| Payday | `payroll_allocated` | 3 s at most | Coins rise from the vault along the pipes to each passing desk, tier by tier, with a small “+amount” at each desk | P0 |
| Layoff | Derived: a status becomes `laid_off` after `task_finalized` | 2.5 s | The boss's bubble announces it, the character packs a box and walks to the HR door, and the desk dims | P0 |
| Promotion | Derived: a `submission_received` tier differs from the previous `last_tier`, or a new hire's tier changes | 300 ms | The character slides to its new floor. The elevator ride (1.5 s) is Later | P0 |
| Low reserve | `reserve_low` | 1.5 s | The vault pulses three times, then holds its steady low state | P0 |
| Tower state change | Employee count crosses a threshold | 300 ms | Crossfade and a boss line (§12.3). The 4 s construction sequence is Later | P0 |
| Employee of the Day | Jackpot; no v1 event | 1 s | Gold ring on the head, one burst of paper confetti. This is the only confetti in the product | Later |
| Bankruptcy | No v1 event | 3 s at most | Floors go dark one by one, 120 ms apart, then the vault empties and the sign flips to Closed | Later |

#### 14.3.1 Finalize choreography

The contract emits `rehired` and `streak_milestone` during each finalize call, and `payroll_allocated` and `task_finalized` only on the last call. The client holds every event of task N until `task_finalized` for N arrives. It then reads the submissions and employee statuses and plays, in order:

1. Results (pass and miss dots).
2. Streak milestones and rehires.
3. Payday.
4. Layoffs, from the status changes.
5. The boss's summary bubble, with the face from §17.1.

The whole sequence takes 8 s at most, and a tap skips to the end. A client that loads while a task is Finalizing shows “Results pending” until `task_finalized` arrives.

### 14.4 Performance budget

- Animate only position, scale, rotation, alpha, and tint. Never rebuild Pixi `Graphics` or `Text` per frame. Characters, desks, and props come from one texture atlas.
- Cache each static floor as a texture and redraw it only when its contents change.
- Draw only floors in view (roadmap W-03).
- At least 50 fps with 150 characters on a laptop (the roadmap W-17 gate). Aim for 60 fps, and check on a mid-range phone.
- Idle animation runs only for characters in view, and for at most 200 at a time. Past that, idle freezes to a still pose.
- Sprite animations use 8 frames or fewer.
- Pause the ticker when the tab is hidden. On return, apply the catch-up rule in §14.1.

### 14.5 Reduced motion and sound

- The client reads `prefers-reduced-motion` at start and follows changes to it.
- When reduced motion is on: no idle bob, no walks, rides, or coin flights, and no typing effect. Movement is replaced with 100 ms fades. The camera jumps instead of panning. A tower state change is a still frame with a caption. State is still carried by dots, rings, numbers, the feed, and the my-desk panel.
- Sound is off by default, never autoplays, and may only accompany a signature moment.

### 14.6 Never

- Parallax scrolling, shaking, or endless glowing pulses.
- Anything that flashes more than three times per second.
- Confetti on ordinary actions.
- A spinner while waiting. Use the boss's bubble instead, for example “Reviewing your submission…”.
- Any animation that hides information the player needs to act.

## 15. Design system components

The design system is a small, strict kit. Every screen is built from these parts, and nothing is styled one-off. Components carry the `Rg` prefix (for example `RgButton`).

### 15.1 Foundations

| Foundation | Rule |
| --- | --- |
| Color | Only the tokens in section 6. No raw hex values inside components |
| Spacing | 4, 8, 12, 16, 24, and 32 px |
| Radius | 4 px for desks and chips, 6 px for buttons, inputs, and the tower outline, 8 px for cards and bubbles |
| Borders | 1 px for dividers and 2 px for the tower outline and emphasis |
| Type | The scale in section 7 |
| Themes | Dark only. There is no light theme or theme toggle |

### 15.2 Component list

| Component | Layer | Variants | States | Rules |
| --- | --- | --- | --- | --- |
| `RgButton` | DOM | Primary, secondary; sizes medium and small | Default, hover, focus, pressed, disabled, loading | One primary per view (§3.1). The loading label is in voice, for example “Filing…”. Disabled is 50% opacity with no pointer cursor |
| `RgInput` | DOM | Text | Default, focus, error, disabled | Error text is in the boss's voice and says what to do |
| `RgCard` | DOM | Default, emphasized (accent border) | Default | Header and body slots. No shadows |
| `RgTaskPanel` | DOM | One per task type | Idle, open, reapply, pending, submitted, rejected, closed, passed, missed, claimable, claim pending, claimed, claim blocked, forfeited, provable (P1) | Puzzle, input, and the primary button in one card. Rejected shows the mapped copy from §13.2 |
| `RgFeed` | DOM | Compact, full | Default, empty | Polite live region. Item types: task, submission, payroll, claim, forfeit, layoff, rehire, promotion, streak, income, system |
| `RgBadge` | DOM and Pixi | Streak, tier, status, new hire, simulated | Default | A 4 px radius chip. Text plus color, never color alone |
| `RgTooltip` | DOM over the canvas | Character, vault | Hidden, shown | Appears on hover. Contents are plain text |
| `RgCharacterCard` | DOM over the canvas | Default | Open, closed | §3. Closes on Escape and on a tap outside |
| `RgToast` | DOM | Boss message | Shown, dismissed | One at a time, 4 seconds, never used for errors that need action |
| `RgDialog` | DOM | Wallet connect (including the demo burner), claim confirmation | Open, closed | Traps focus, closes on Escape, returns focus to the trigger |
| `RgSimBanner` | DOM | Preview banner | Shown | §12.4. Cannot be dismissed |
| `RgEmployeeList` | DOM | Default | Default, empty | P1. Tower order; each row opens the card |
| `RgBossBubble` | Pixi | Message, announcement | Typing, shown | The tail points at the boss. Layoff announcements use the ink border instead of the accent |
| `RgCharacter` | Pixi | Body color from the wallet hash; scale | The statuses and overlays in §5 | Props: wallet hash, status, overlays, scale |
| `RgDesk` | Pixi | Office, glass office, cubicle, shared desk (by tier) | Empty, occupied, laid off | Holds one `RgCharacter`. Empty desks are an outline in Desk edge |
| `RgFloor` | Pixi | One per tier | Default; dark for lease or bankruptcy (Later) | Tier tint, label on the first floor, equal-width desk grid |
| `RgTower` | Pixi | The five states in section 12 | Normal, preview, low reserve; upgrading and bankrupt (Later) | Stacks floors. Draws only visible floors |
| `RgVault` | Pixi | Cash box; per-state art (Later) | Healthy, low; bankrupt (Later) | Shows reserve, a fill bar, and runway as text. Low means below `reserve_low` |
| `RgCrowdSign` | Pixi | Lobby sign | Shown | §12.5. Present whenever a crowd account is drawn |

### 15.3 Component rules

1. **Every component has all of its states drawn** before it is built.
2. **State comes from the model, never from inside.** Components never read the chain or the state source. A parent passes in the model computed by `packages/core` (layout, statuses, pay amounts), so the same components render live data and the growth preview.
3. **Meaning is never color alone.** Pair color with a shape, a label, or a number.
4. **Every interactive DOM control has an accessible name**, a visible focus ring, and a touch target of at least 44 px on phones. Canvas targets reach 44 px through tap-to-zoom (§10).
5. **Variants are added by exception.** A new variant needs a reason that an existing one cannot meet, and it is added here first.
6. **Copy lives with the component.** Default labels and messages follow section 13.

### 15.4 Documentation and checks

- **Unit tests** (P0, roadmap W-16) cover the tower model, the layout, and the wallet-hash body color in `packages/core`.
- **Component gallery** (P1). One page shows every DOM component and every Pixi object in every state at 360, 820, and 1,100 px wide. It doubles as the visual test page.
- **Later:** a lint rule that rejects raw hex values and off-scale spacing, and a snapshot test per component state with a reduced-motion check.
- A component is done only when it passes the three-question test in section 13.3.

## 16. Build notes

- **Client:** Vite, TypeScript, and PixiJS v8 (roadmap W-01). The tower, boss bubble, and lobby sign are drawn in Pixi. The side panel, feed, card, tooltip, dialogs, and the preview banner are DOM.
- The HTML prototype is a reference only and does not ship.
- Characters, the boss and props come from one texture atlas, `art/characters.png` with `art/characters.json` (Pixi spritesheet format, rig in `meta.rig`), generated by `npm run art`. The shirt layer is tinted with the body color from the wallet hash. Placeholder art until the final art lands (§5).
- The renderer reads one state source: live (contract views plus `get_events`) or the seeded growth preview. It holds no game logic; layout, statuses, and pay amounts come from `packages/core`.
- Every color is a token in one file, so theming and rebranding stay a one-file change.
- `npm run demo` runs the client against a local chain with a bot crowd, labeled as in §12.5.

## 17. Design decisions

### Settled

1. **The boss's face reflects the day's pass rate** (P1). The pass rate is `passed / submitted` from the latest `task_finalized`. One sprite with three expressions: smug at 90% or more, a forced smile from 50% to 89%, and twitchy below 50% or when nobody submitted. The cut-offs are client display constants that match the difficulty defaults in product spec §4.4. The code picks the face from the real pass rate, never the LLM. Layoff announcements reuse the twitchy face.
2. **Hair and accessories are purely cosmetic.** They come from the wallet hash and imply nothing about the contract. Badges can appear later as desk items instead, such as a plant for a long streak or a gold hard hat for Employee of the Day. The hackathon build ships the hash-based body color; hair and accessories are P1.
3. **The camera is fixed in the first two states and manual after that.** Garage startup and Small office fit on screen. From Office tower up, which in the hackathon means the growth preview, the camera jumps once to the player's desk on load, and a permanent “Go to my desk” button brings it back. There is no continuous follow. Under reduced motion the jump is instant. On phones, tap-to-zoom applies in every state (§10).
4. **The tower has no memory.** Tower state and floors are pure functions of current state (§4, §12.3).
5. **Pixi for the tower, DOM for everything else** (2026-11-08).

### Palette

**Blueprint is the palette.** Navy paper with a pale cyan accent (#6ad4ff) and dark button text (#0a1626), with the neutrals, body colors, and floor tints in section 6. The accent colors the boss, the player's ring, the primary button, and the signage, always through tokens. Contrast was measured on 2026-11-08 (§6); re-measure when a token changes.
