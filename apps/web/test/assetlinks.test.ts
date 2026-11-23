import { afterEach, expect, test, vi } from "vitest";
import { GET } from "@/app/.well-known/assetlinks.json/route";

afterEach(() => vi.unstubAllEnvs());

test("404 without ANDROID_CERT_SHA256", async () => {
  vi.stubEnv("ANDROID_CERT_SHA256", "");
  expect((await GET()).status).toBe(404);
});

test("returns the statement for za.kitty.app with the fingerprint", async () => {
  const fingerprint = "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5";
  vi.stubEnv("ANDROID_CERT_SHA256", fingerprint);
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: "za.kitty.app", sha256_cert_fingerprints: [fingerprint] },
    },
  ]);
});

test("a malformed fingerprint is not published", async () => {
  vi.stubEnv("ANDROID_CERT_SHA256", "not-a-fingerprint");
  expect((await GET()).status).toBe(404);
});
