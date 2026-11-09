/**
 * Character appearance from the wallet (roadmap W-04, design spec §5.1). Purely cosmetic: it
 * implies nothing about the contract, and every client derives the same look from the same id.
 *
 *   h = sha256(utf8(wallet))
 *   body color  = h[0] mod 8   (index into the body tokens, design §6)
 *   hair style  = h[1] mod 5   (HAIR_STYLES order; "none" draws no hair)
 *   hair color  = h[2] mod 6   (index into the sprite hair colors, art/palette.mjs)
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import type { WalletId } from "./abi";

export const BODY_COLOR_COUNT = 8;
export const HAIR_STYLES = ["short", "long", "bun", "curly", "none"] as const;
export type HairStyle = (typeof HAIR_STYLES)[number];
export const HAIR_COLOR_COUNT = 6;

export interface Appearance {
  /** 0..7, body token index. */
  body: number;
  hairStyle: HairStyle;
  /** 0..5, hair color index. */
  hairColor: number;
}

export function appearanceOf(wallet: WalletId): Appearance {
  const h = sha256(utf8ToBytes(wallet));
  return {
    body: h[0]! % BODY_COLOR_COUNT,
    hairStyle: HAIR_STYLES[h[1]! % HAIR_STYLES.length]!,
    hairColor: h[2]! % HAIR_COLOR_COUNT,
  };
}
