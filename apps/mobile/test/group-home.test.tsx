import type { PlainDraft } from "@kitty/core";
import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import GroupLayout from "../src/app/(app)/groups/[id]/_layout";
import Activity from "../src/app/(app)/groups/[id]/activity";
import Overview from "../src/app/(app)/groups/[id]/index";
import type { AiClient } from "../src/ai";
import { fakeLedger, json } from "./support/fake-ledger";
import { G, groupRoutes, ME, SAM } from "./support/group";
import { renderApp } from "./support/render-app";
import { noDrafts } from "./support/no-drafts";

const expense = (id: string, description: string) => ({
  id,
  description,
  category: "food",
  currency: "ZAR",
  amountMinor: 10000,
  occurredOn: "2026-11-20",
  payers: [{ memberId: SAM, amountMinor: 10000 }],
  split: { method: "equal", participants: [] },
  shares: [{ memberId: ME, amountMinor: 5000 }, { memberId: SAM, amountMinor: 5000 }],
  version: 1,
  createdBy: SAM,
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-20T10:00:00Z",
});

const overviewRoutes = (pages: Record<string, unknown>) =>
  groupRoutes({
    [`GET /groups/${G}/balances`]: () =>
      json(200, { currencies: [{ currency: "ZAR", members: [{ memberId: ME, netMinor: -5000 }, { memberId: SAM, netMinor: 5000 }], transfers: [{ fromMemberId: ME, toMemberId: SAM, amountMinor: 5000 }] }] }),
    [`GET /groups/${G}/table-sessions`]: () => json(200, []),
    [`GET /groups/${G}/recurring`]: () => json(200, []),
    [`GET /groups/${G}/expenses`]: (req) => json(200, pages[new URL(req.url).searchParams.get("cursor") ?? ""]),
  });

const routes = { "(app)/groups/[id]/_layout": GroupLayout, "(app)/groups/[id]/index": Overview, "(app)/groups/[id]/activity": Activity };

test("balances show who owes whom with formatMoney", async () => {
  const { client } = fakeLedger(overviewRoutes({ "": { items: [], nextCursor: null } }));
  await renderApp(routes, client, `/groups/${G}`);
  expect(await screen.findByText("You")).toBeTruthy();
  expect(screen.getByText(/^owes R\s50,00$/)).toBeTruthy();
  expect(screen.getByText("Sam")).toBeTruthy();
  expect(screen.getByText(/^gets back R\s50,00$/)).toBeTruthy();
  expect(screen.getByText("See the simplest way to settle up")).toBeTruthy();
});

test("expenses list loads the next page at the end", async () => {
  const { client, calls } = fakeLedger(
    overviewRoutes({ "": { items: [expense("e1", "Groceries")], nextCursor: "c2" }, c2: { items: [expense("e2", "Petrol")], nextCursor: null } }),
  );
  await renderApp(routes, client, `/groups/${G}`);
  expect(await screen.findByText("Groceries")).toBeTruthy();
  expect(screen.getByText(/^your share R\s50,00$/)).toBeTruthy();
  await fireEvent.press(screen.getByText("Older expenses"));
  expect(await screen.findByText("Petrol")).toBeTruthy();
  expect(screen.getByText("Groceries")).toBeTruthy(); // appended, not replaced
  expect(screen.queryByText("Older expenses")).toBeNull();
  expect(calls.filter((c) => c.path.endsWith("/expenses")).map((c) => c.search)).toEqual(["?limit=30", "?cursor=c2&limit=30"]);
});

test("saving a payment from the card reloads the balances", async () => {
  const payment: PlainDraft = {
    intent: "payment",
    groupId: G,
    issues: [],
    members: [
      { id: ME, displayName: "Zee" },
      { id: SAM, displayName: "Sam" },
    ],
    groups: [{ id: G, name: "Flat 4B" }],
    parsed: { kind: "payment", counterpart: "Sam", direction: "i_paid" },
    payment: {
      fromMemberId: ME,
      toMemberId: SAM,
      currency: "ZAR",
      amountMinor: 5000,
      statedAmountMinor: null,
      openItems: [{ expenseId: "e1", description: "Groceries", date: "2026-11-20", openMinor: 5000 }],
      covers: [{ expenseId: "e1", amountMinor: 5000 }],
    },
  };
  const ai: AiClient = { ...noDrafts, parse: async () => ({ draft: payment }), resolve: async () => ({ draft: payment }), ask: async () => ({ error: "unexpected" }) };
  const { client, calls } = fakeLedger({
    ...overviewRoutes({ "": { items: [], nextCursor: null } }),
    [`POST /groups/${G}/settlements`]: () => json(201, {}),
  });
  await renderApp(routes, client, `/groups/${G}`, ai);
  expect(await screen.findByText("You")).toBeTruthy();

  await fireEvent.changeText(screen.getByLabelText("Add an expense or a reminder in a sentence"), "paid Sam for the groceries");
  await fireEvent.press(screen.getByText("Go"));
  await fireEvent.press(await screen.findByText("Save"));

  expect(await screen.findByText("Payment recorded.")).toBeTruthy();
  await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.path === `/groups/${G}/balances`)).toHaveLength(2));
});

test("a 404 group shows We couldn't find that.", async () => {
  const { client } = fakeLedger({ "GET /me": () => json(200, { id: "user-me", displayName: "Zee", email: null }) });
  await renderApp(routes, client, `/groups/${G}`);
  expect(await screen.findByText("We couldn't find that.")).toBeTruthy();
});

test("a malformed group id shows not found without asking the ledger", async () => {
  const { client, calls } = fakeLedger({});
  await renderApp(routes, client, "/groups/not-a-uuid");
  expect(await screen.findByText("We couldn't find that.")).toBeTruthy();
  expect(calls).toHaveLength(0);
});

test("activity lists entries newest first as returned", async () => {
  const { client } = fakeLedger(
    groupRoutes({
      [`GET /groups/${G}/activity`]: () =>
        json(200, [
          { id: "a2", at: "2026-11-21T09:00:00Z", actorDisplayName: "Sam", entityType: "expense", entityId: "e1", action: "updated", before: null, after: { description: "Petrol", amountMinor: 60000, currency: "ZAR" } },
          { id: "a1", at: "2026-11-20T09:00:00Z", actorDisplayName: "Zee", entityType: "member", entityId: SAM, action: "added", before: null, after: { displayName: "Sam" } },
        ]),
    }),
  );
  await renderApp(routes, client, `/groups/${G}/activity`);
  const lines = await screen.findAllByTestId("activity-line");
  expect(lines.map((l) => l.props.children)).toEqual([expect.stringMatching(/^Sam updated expense "Petrol" \(R\s600,00\)$/), "Zee added Sam"]);
});

test("an edited expense shows its new details after a reload", async () => {
  const pages: Record<string, unknown> = { "": { items: [expense("e1", "Groceries")], nextCursor: null } };
  const { client } = fakeLedger(overviewRoutes(pages));
  await renderApp(routes, client, `/groups/${G}`);
  expect(await screen.findByText("Groceries")).toBeTruthy();
  pages[""] = { items: [{ ...expense("e1", "Groceries and wine"), version: 2 }], nextCursor: null };
  await act(async () => screen.getByTestId("screen").props.refreshControl.props.onRefresh()); // pull to refresh
  expect(await screen.findByText("Groceries and wine")).toBeTruthy();
});

test("group home shows the converted total card and hides it when null", async () => {
  const mixed = {
    currencies: [
      { currency: "EUR", members: [{ memberId: ME, netMinor: -2000 }, { memberId: SAM, netMinor: 2000 }], transfers: [{ fromMemberId: ME, toMemberId: SAM, amountMinor: 2000 }] },
      { currency: "ZAR", members: [{ memberId: ME, netMinor: -5000 }, { memberId: SAM, netMinor: 5000 }], transfers: [{ fromMemberId: ME, toMemberId: SAM, amountMinor: 5000 }] },
    ],
    converted: { currency: "ZAR", members: [{ memberId: ME, netMinor: -43397 }, { memberId: SAM, netMinor: 43397 }], transfers: [], excludedCount: 1 },
  };
  const { client } = fakeLedger(
    groupRoutes({
      [`GET /groups/${G}/balances`]: () => json(200, mixed),
      [`GET /groups/${G}/table-sessions`]: () => json(200, []),
      [`GET /groups/${G}/recurring`]: () => json(200, []),
      [`GET /groups/${G}/expenses`]: () => json(200, { items: [], nextCursor: null }),
    }),
  );
  await renderApp(routes, client, `/groups/${G}`);

  expect(await screen.findByText("About ZAR in total")).toBeTruthy();
  expect(screen.getByText(/^owes about R\s433,97$/)).toBeTruthy();
  expect(screen.getByText(/1 older expense has no rate yet\.$/)).toBeTruthy();
});

test("a foreign expense lists both amounts", async () => {
  const foreign = { ...expense("e1", "Gelato"), currency: "EUR", amountMinor: 4000, convertedAmountMinor: 76795 };
  const { client } = fakeLedger(overviewRoutes({ "": { items: [foreign], nextCursor: null } }));
  await renderApp(routes, client, `/groups/${G}`);

  expect(await screen.findByText("Gelato")).toBeTruthy();
  expect(screen.queryByText("About ZAR in total")).toBeNull(); // no converted total in this response
  expect(screen.getByText(/€\s?40,00 · R\s767,95/)).toBeTruthy();
});
