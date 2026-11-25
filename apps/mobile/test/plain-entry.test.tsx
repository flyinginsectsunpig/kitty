import type { PlainDraft } from "@kitty/core";
import { fireEvent, screen, waitFor } from "expo-router/testing-library";
import { Text } from "react-native";
import GroupLayout from "../src/app/(app)/groups/[id]/_layout";
import NewExpense from "../src/app/(app)/groups/[id]/expenses/new";
import GroupsIndex from "../src/app/(app)/groups/index";
import type { AiClient } from "../src/ai";
import { fakeLedger, json } from "./support/fake-ledger";
import { G, groupRoutes, ME, SAM } from "./support/group";
import { renderApp } from "./support/render-app";

const routes = {
  "(app)/groups/index": GroupsIndex,
  "(app)/groups/[id]/_layout": GroupLayout,
  "(app)/groups/[id]/index": () => <Text>Group home</Text>,
  "(app)/groups/[id]/expenses/new": NewExpense,
};

const groupsList = { "GET /groups": () => json(200, [{ id: G, name: "Flat 4B", baseCurrency: "ZAR", memberCount: 2, myNet: [] }]) };

const base = {
  groupId: G,
  members: [
    { id: ME, displayName: "Zee" },
    { id: SAM, displayName: "Sam" },
  ],
  groups: [{ id: G, name: "Flat 4B" }],
  parsed: {},
};

const dinner: PlainDraft = {
  ...base,
  intent: "expense",
  issues: [],
  expense: {
    description: "Dinner",
    category: "food",
    currency: "ZAR",
    amountMinor: 30000,
    occurredOn: "2026-11-25",
    payerMemberId: ME,
    split: "equal",
    participants: [
      { memberId: ME, name: "me", amountMinor: null },
      { memberId: SAM, name: "Sam", amountMinor: null },
    ],
  },
};

const fakeAi = (result: Awaited<ReturnType<AiClient["parse"]>>): AiClient & { texts: string[] } => {
  const texts: string[] = [];
  return {
    texts,
    parse: async (text) => (texts.push(text), result),
    resolve: async () => result,
    ask: async () => ({ error: "unexpected" }),
  };
};

async function type(sentence: string) {
  await fireEvent.changeText(await screen.findByLabelText("Add an expense or a reminder in a sentence"), sentence);
  await fireEvent.press(screen.getByText("Go"));
}

test("a sentence shows the card and Save posts the expense", async () => {
  const { client, calls } = fakeLedger(groupRoutes({ ...groupsList, [`POST /groups/${G}/expenses`]: () => json(201, {}) }));
  const ai = fakeAi({ draft: dinner });
  const { app } = await renderApp(routes, client, "/groups", ai);

  await type("dinner R300 with Sam");
  expect(await screen.findByText(/Dinner · R\s300,00/)).toBeTruthy();
  expect(ai.texts).toEqual(["dinner R300 with Sam"]);
  await fireEvent.press(screen.getByText("Save"));

  await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === `/groups/${G}/expenses`)).toBe(true));
  const post = calls.find((c) => c.path === `/groups/${G}/expenses`)!;
  expect(post.body).toMatchObject({ description: "Dinner", amountMinor: 30000, payers: [{ memberId: ME, amountMinor: 30000 }] });
  expect(post.body.split.participants.map((p: { memberId: string }) => p.memberId)).toEqual([ME, SAM]);
  await waitFor(() => expect(app.getPathname()).toBe(`/groups/${G}`));
});

test("the card shows each person's share", async () => {
  const { client } = fakeLedger(groupRoutes(groupsList));
  await renderApp(routes, client, "/groups", fakeAi({ draft: dinner }));

  await type("dinner R300 with Sam");

  expect(await screen.findByText(/^Zee R\s150,00 · Sam R\s150,00$/)).toBeTruthy();
});

test("a retried Save keeps its key and its expense id", async () => {
  let attempts = 0;
  const { client, calls } = fakeLedger(
    groupRoutes({
      ...groupsList,
      [`POST /groups/${G}/expenses`]: () => {
        attempts++;
        if (attempts === 1) throw new TypeError("Network request failed");
        return json(201, {});
      },
    }),
  );
  await renderApp(routes, client, "/groups", fakeAi({ draft: dinner }));

  await type("dinner R300 with Sam");
  await fireEvent.press(await screen.findByText("Save"));
  expect(await screen.findByText("Couldn't reach Kitty. Check your connection and try again.")).toBeTruthy();
  await fireEvent.press(screen.getByText("Save"));

  await waitFor(() => expect(attempts).toBe(2));
  const posts = calls.filter((c) => c.path === `/groups/${G}/expenses`);
  expect(posts[1]!.headers.get("Idempotency-Key")).toBe(posts[0]!.headers.get("Idempotency-Key"));
  expect(posts[1]!.body.id).toBe(posts[0]!.body.id);
});

test("Edit with a currency Kitty doesn't know opens an empty form instead of crashing", async () => {
  const { client } = fakeLedger(groupRoutes(groupsList));
  const odd: PlainDraft = { ...dinner, expense: { ...dinner.expense!, currency: "XYZ" } };
  const { app } = await renderApp(routes, client, "/groups", fakeAi({ draft: odd }));

  await type("dinner 300 xyz");
  await fireEvent.press(await screen.findByText("Edit"));

  await waitFor(() => expect(app.getPathname()).toBe(`/groups/${G}/expenses/new`));
  expect((await screen.findByLabelText("What was it for?")).props.value).toBe("");
});

test("an ambiguous name blocks Save until picked", async () => {
  const { client } = fakeLedger(groupRoutes(groupsList));
  const unsure: PlainDraft = {
    ...dinner,
    expense: { ...dinner.expense!, participants: [dinner.expense!.participants[0]!, { memberId: null, name: "S", amountMinor: null }] },
    issues: [{ field: "people[1]", kind: "ambiguous", text: "S", candidates: [SAM, ME] }],
  };
  await renderApp(routes, client, "/groups", fakeAi({ draft: unsure }));

  await type("dinner R300 with S");
  expect(await screen.findByText("Which S?")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save" }).props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.press(screen.getByRole("button", { name: "Sam" }));

  expect(screen.getByRole("button", { name: "Save" }).props.accessibilityState).toMatchObject({ disabled: false });
});

test("Edit opens the form pre-filled", async () => {
  const { client } = fakeLedger(groupRoutes(groupsList));
  const { app } = await renderApp(routes, client, "/groups", fakeAi({ draft: dinner }));

  await type("dinner R300 with Sam");
  await fireEvent.press(await screen.findByText("Edit"));

  await waitFor(() => expect(app.getPathname()).toBe(`/groups/${G}/expenses/new`));
  expect((await screen.findByLabelText("What was it for?")).props.value).toBe("Dinner");
  expect(screen.getByLabelText("Amount").props.value).toBe("300.00");
});

test("a reminder card shows the balance and Send posts the reminder", async () => {
  const { client, calls } = fakeLedger(groupRoutes({ ...groupsList, [`POST /groups/${G}/reminders`]: () => json(204) }));
  const remind: PlainDraft = {
    ...base,
    intent: "reminder",
    issues: [],
    reminder: { memberId: SAM, name: "Sam", owedMinorByCurrency: { ZAR: 15000 }, statedAmountMinor: 2000, statedCurrency: "ZAR" },
  };
  await renderApp(routes, client, "/groups", fakeAi({ draft: remind }));

  await type("tell Sam he owes me R20");
  expect(await screen.findByText(/Remind Sam that they owe you R\s150,00 in Flat 4B\?/)).toBeTruthy();
  expect(screen.getByText(/You said R\s20,00; Kitty's balance says R\s150,00\./)).toBeTruthy();
  await fireEvent.press(screen.getByText("Send reminder"));

  await waitFor(() => expect(calls.find((c) => c.path === `/groups/${G}/reminders`)?.body).toEqual({ memberId: SAM }));
  expect(await screen.findByText("Reminder sent to Sam.")).toBeTruthy();
});

test("already reminded today says so", async () => {
  const { client } = fakeLedger(
    groupRoutes({ ...groupsList, [`POST /groups/${G}/reminders`]: () => json(429, { code: "already_reminded" }) }),
  );
  const remind: PlainDraft = {
    ...base,
    intent: "reminder",
    issues: [],
    reminder: { memberId: SAM, name: "Sam", owedMinorByCurrency: { ZAR: 15000 }, statedAmountMinor: null, statedCurrency: "ZAR" },
  };
  await renderApp(routes, client, "/groups", fakeAi({ draft: remind }));

  await type("remind Sam");
  await fireEvent.press(await screen.findByText("Send reminder"));

  expect(await screen.findByText("You've already reminded them today.")).toBeTruthy();
});

test("ai unavailable offers the full form", async () => {
  const { client } = fakeLedger(groupRoutes(groupsList));
  await renderApp(routes, client, "/groups", fakeAi({ error: "ai_unavailable" }));

  await type("dinner R300 with Sam");

  expect(await screen.findByText("Kitty can't read sentences right now. Use the form instead.")).toBeTruthy();
});
