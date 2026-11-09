# REORG brand kit

*Reorg Inc. Ticker: $REORG. Hold the token. Get hired. Survive the reorg.*

![REORG lockup](logo/reorg-lockup.svg)

> **TODO(art): placeholder brand.** The wordmark, icon and social images are stand-ins drawn from code. Replace them with the final brand art before launch, and before any public post or token deploy that bakes the icon into on-chain metadata (the token `icon` is set at init). The characters come from [`art/`](../art/README.md), which is placeholder art too.

This folder has the logo, icon, token icon and social images. All of them come from `build.mjs`, which draws them from code in the Blueprint palette, using the sprites and the building composition in `art/` (`art/scene.mjs`). Change the script, not the outputs, and run `npm run brand` again; it needs Chrome to write the PNGs (set `CHROME=/path/to/chrome` if it is not installed in the usual place). Colors, type, voice and the rules against generic design are in [`docs/design/REORG Design Spec.md`](../docs/design/REORG%20Design%20Spec.md) §2, §6, §7 and §13. That spec wins where this page disagrees with it.

## The mark

**Wordmark.** REORG in heavy geometric capitals drawn as paths, so it needs no font. The O has been reorganized: it is the only letter in the accent color and sits one floor lower than the others. The accent is the only decoration (spec §2).

- Use it on navy (`#0a1626`) or the panel color (`#11233a`). The letters are light, so on white or photos use `reorg-lockup.svg`, which has its own navy plate.
- Keep the O dropped and in the accent. Don't straighten it, recolor it, or add a second accent.
- Leave clear space of at least the O's width on every side. The smallest size is 18 px cap height (about 90 px wide).
- No gradients, glows, outlines, shadows, or tilt (spec §13.1).

**Icon.** The boss, smug, from the chest up, on navy: silver hair, the accent blazer, a lanyard and a coffee mug. It is the `boss.smug` sprite from `art/sprites.mjs`, drawn in sprite pixels (a 24-unit viewBox), so it stays crisp at every size. The face sits inside the inscribed circle, so wallets that crop token icons to a circle keep it.

## Files

| File | Use |
| --- | --- |
| `logo/reorg-wordmark.svg` | Wordmark on transparent, for dark backgrounds |
| `logo/reorg-lockup.svg`, `.png` | Wordmark and tagline on a navy plate. The README header; works on GitHub light and dark |
| `icon/reorg-icon.svg`, `reorg-icon-512.png` | App icon with rounded corners |
| `icon/favicon-32.png`, `apple-touch-icon-180.png` | Web client favicon and home-screen icon |
| `icon/reorg-icon-square.svg` | Full-bleed square, for places that apply their own mask |
| `icon/token-icon.svg`, `token-icon.datauri.txt` | NEP-141 `icon` metadata: a 64 px square SVG, about 2.2 KB as a data URI (one path per color). Pass the contents of the `.txt` as `metadata.icon` when initializing the token |
| `social/og-card.png` | 1200 × 630 link preview (`og:image`, `twitter:image`) |
| `social/x-avatar-400.png`, `x-banner.png` | Profile picture and 1500 × 500 header |

The social images show the game's building (`art/scene.mjs`, the payday sample moment, including its SIMULATED CROWD sign), not live state: the whole building on the OG card, the four tier floors on the X banner. Text on the social images is set in the system UI font and baked into the PNGs; the SVG versions depend on the viewer's fonts, so share the PNGs.

## Palette (from spec §6)

| Role | Token | Hex |
| --- | --- | --- |
| Background | Background | `#0a1626` |
| Surface | Panel | `#11233a` |
| Text and the wordmark | Ink | `#e6f1fb` |
| Secondary text | Muted | `#8fa6bf` |
| The O, the boss, the player, signage | Accent | `#6ad4ff` |
| Text on the accent | Button text | `#0a1626` |
| Money | Coin | `#f2c230` |

Body colors and floor tints are in spec §6. Never put the accent on a light background: its contrast there is too low.

## Voice

Write in the boss's voice: a passive-aggressive executive who is upbeat about bad news. Use short sentences and put buzzwords in on purpose. Never be cruel to a real person, and never give money advice. Copy states rules; it never tells anyone to buy or sell. The banned words and the copy table are in spec §13.
