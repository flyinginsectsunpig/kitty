import type { TableSession } from "@kitty/core";
import { G, ME, SAM } from "./group";

export const S = "66666666-6666-4666-8666-666666666666";
export const I1 = "77777777-7777-4777-8777-777777777771";
export const I2 = "77777777-7777-4777-8777-777777777772";
export const base = `/groups/${G}/table-sessions/${S}`;

/** A bill at version `version` hosted by Sam (Sam pays); Zee is the viewer. */
export function bill(version: number, over: Partial<TableSession> = {}): TableSession {
  return {
    id: S,
    title: "Friday dinner",
    currency: "ZAR",
    status: "open",
    version,
    payerMemberId: SAM,
    payerDisplayName: "Sam",
    expenseId: null,
    viewer: { kind: "member", id: ME },
    items: [
      { id: I1, description: "Burger", quantity: 1, lineTotalMinor: 9000, claimants: [] },
      { id: I2, description: "Chips", quantity: 2, lineTotalMinor: 6000, claimants: [] },
    ],
    charges: [],
    guests: [],
    preview: [],
    scan: null,
    ...over,
  };
}
