import { MAX_PHOTO_BYTES } from "@kitty/core";
import { preparePhoto } from "../src/lib/photo";

const resizes: { width?: number; height?: number }[] = [];
const saves: { compress?: number; format?: string }[] = [];
let sizes: number[] = [];

jest.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg" },
  ImageManipulator: {
    manipulate: () => {
      const ctx = {
        resize: (size: { width?: number; height?: number }) => (resizes.push(size), ctx),
        renderAsync: async () => ({
          saveAsync: async (o: { compress?: number; format?: string }) => (saves.push(o), { uri: `file:///out-${saves.length}.jpg`, width: 1, height: 1 }),
        }),
      };
      return ctx;
    },
  },
}));

beforeEach(() => {
  resizes.length = 0;
  saves.length = 0;
  globalThis.fetch = jest.fn(async () => ({ blob: async () => new Blob([new Uint8Array(sizes.shift() ?? 1000)], { type: "image/jpeg" }) })) as never;
});

test("preparePhoto always yields image/jpeg under MAX_PHOTO_BYTES", async () => {
  sizes = [3_000_000];
  const photo = await preparePhoto({ uri: "file:///in.heic", width: 4032, height: 3024 });
  expect(photo.type).toBe("image/jpeg");
  expect(photo.size).toBe(3_000_000);
  expect(photo.size).toBeLessThanOrEqual(MAX_PHOTO_BYTES);
  expect(saves[0]).toEqual({ compress: 0.8, format: "jpeg" });
});

test("the longest side is scaled to 2000 px, whichever way round the photo is", async () => {
  await preparePhoto({ uri: "file:///landscape.jpg", width: 4000, height: 3000 });
  await preparePhoto({ uri: "file:///portrait.jpg", width: 3000, height: 4000 });
  expect(resizes).toEqual([{ width: 2000 }, { height: 2000 }]);
});

test("a small photo is re-encoded but not enlarged", async () => {
  await preparePhoto({ uri: "file:///small.png", width: 800, height: 600 });
  expect(resizes).toEqual([]);
  expect(saves).toHaveLength(1);
});

test("a photo still too big after the first pass is squeezed harder", async () => {
  sizes = [MAX_PHOTO_BYTES + 1, 2_000_000];
  const photo = await preparePhoto({ uri: "file:///huge.jpg", width: 9000, height: 6000 });
  expect(saves).toEqual([{ compress: 0.8, format: "jpeg" }, { compress: 0.5, format: "jpeg" }]);
  expect(resizes).toEqual([{ width: 2000 }, { width: 1400 }]);
  expect(photo.size).toBe(2_000_000);
});
