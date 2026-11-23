import type { GroupDto } from "@kitty/api-client";
import { json, type Handler } from "./fake-ledger";

/** A two-person group (Zee is the signed-in user) and the routes every group screen loads. */
export const G = "11111111-1111-4111-8111-111111111111";
export const ME = "22222222-2222-4222-8222-222222222222";
export const SAM = "33333333-3333-4333-8333-333333333333";

export const group: GroupDto = {
  id: G,
  name: "Flat 4B",
  baseCurrency: "ZAR",
  members: [
    { id: ME, displayName: "Zee", userId: "user-me", isPlaceholder: false, paymentDetails: null },
    { id: SAM, displayName: "Sam", userId: "user-sam", isPlaceholder: false, paymentDetails: "FNB 123" },
  ],
};

export const groupRoutes = (extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  [`GET /groups/${G}`]: () => json(200, group),
  "GET /me": () => json(200, { id: "user-me", displayName: "Zee", email: null }),
  ...extra,
});
