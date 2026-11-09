/**
 * The texture atlas (art/characters.png + .json, built by `npm run art`). Every character, prop
 * and building tile comes from this one sheet (design §14.4). Nearest-neighbor filtering: the art
 * is pixel art drawn at whole-number zoom (design §10).
 */
import { Assets, Spritesheet, Texture, TextureSource, type SpritesheetData } from "pixi.js";
import atlasJson from "../../../../art/characters.json";
import atlasPng from "../../../../art/characters.png";

export class Atlas {
  private constructor(private readonly sheet: Spritesheet) {}

  static async load(): Promise<Atlas> {
    TextureSource.defaultOptions.scaleMode = "nearest";
    const texture = await Assets.load<Texture>(atlasPng);
    texture.source.scaleMode = "nearest";
    const sheet = new Spritesheet(texture, atlasJson as unknown as SpritesheetData);
    await sheet.parse();
    return new Atlas(sheet);
  }

  has(name: string): boolean {
    return name in this.sheet.textures;
  }

  /** A frame's texture. Unknown names fail loudly in development (the build validates the rig). */
  tex(name: string): Texture {
    const t = this.sheet.textures[name];
    if (!t) {
      if (import.meta.env.DEV) console.warn(`atlas: no frame "${name}"`);
      return Texture.EMPTY;
    }
    return t;
  }
}
