import { MAX_PHOTO_BYTES, type PhotoInput } from "@kitty/core";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

type Picked = { uri: string; width: number; height: number };

/** First pass: plenty for OCR, a few hundred KB on mobile data. The second only for photos still over the limit. */
const PASSES = [
  { longest: 2000, compress: 0.8 },
  { longest: 1400, compress: 0.5 },
] as const;

/**
 * Turns a picked photo into what the ledger accepts: always JPEG (HEIC and PNG are re-encoded), longest side at most
 * 2000 px, under the 10 MB limit. Never enlarges a small photo.
 */
export async function preparePhoto(picked: Picked): Promise<PhotoInput> {
  let last: Blob | null = null;
  for (const pass of PASSES) {
    const ctx = ImageManipulator.manipulate(picked.uri);
    if (Math.max(picked.width, picked.height) > pass.longest) ctx.resize(picked.width >= picked.height ? { width: pass.longest } : { height: pass.longest });
    const image = await ctx.renderAsync();
    const saved = await image.saveAsync({ compress: pass.compress, format: SaveFormat.JPEG });
    last = await (await fetch(saved.uri)).blob();
    if (last.size <= MAX_PHOTO_BYTES) break;
  }
  return { type: "image/jpeg", size: last!.size, body: last! };
}
