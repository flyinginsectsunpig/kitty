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

describe("a payment card", () => {
  const PIZZA = "44444444-4444-4444-8444-444444444444";
  const UBER = "55555555-5555-4555-8555-555555555555";
  const pizza = { expenseId: PIZZA, description: "Pizza", date: "2026-11-01", openMinor: 9500 };
  const uber = { expenseId: UBER, description: "Uber", date: "2026-11-10", openMinor: 2500 };
  const uberPayment = (covers: { expenseId: string; amountMinor: number }[]): PlainDraft => ({
    ...base,
    parsed: { kind: "payment", counterpart: "Sam", direction: "i_paid" },
    intent: "payment",
    issues: [],
    payment: {
      fromMemberId: ME,
      toMemberId: SAM,
      currency: "ZAR",
      amountMinor: covers.reduce((sum, c) => sum + c.amountMinor, 0),
      statedAmountMinor: null,
      openItems: [pizza, uber],
      covers,
    },
  });
  const money = (minor: number) => ({ currency: "ZAR", minor, text: "" });
  const openBoth = (iOwe: number, theyOwe: number) => ({
    fromMemberId: ME,
    toMemberId: SAM,
    currencies: [{ currency: "ZAR", fromOwes: [], fromOwesTotal: money(iOwe), toOwes: [], toOwesTotal: money(theyOwe) }],
  });

  test("a payment card saves the covers", async () => {
    const { client, calls } = fakeLedger(groupRoutes({ ...groupsList, [`POST /groups/${G}/settlements`]: () => json(201, {}) }));
    await renderApp(routes, client, "/groups", fakeAi({ draft: uberPayment([{ expenseId: UBER, amountMinor: 2500 }]) }));

    await type("paid Sam for the Uber");
    expect(await screen.findByText(/^You paid Sam R\s25,00$/)).toBeTruthy();
    await fireEvent.press(screen.getByText("Save"));

    expect(await screen.findByText("Payment recorded.")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST" && c.path === `/groups/${G}/settlements`)!;
    expect(post.body).toMatchObject({ fromMemberId: ME, toMemberId: SAM, currency: "ZAR", amountMinor: 2500, covers: [{ expenseId: UBER, amountMinor: 2500 }] });
    expect(post.headers.get("Idempotency-Key")).toBe(post.body.id);
  });

  test("the card says what each ticked item gets before saving", async () => {
    const { client } = fakeLedger(groupRoutes(groupsList));
    const part: PlainDraft = {
      ...uberPayment([{ expenseId: PIZZA, amountMinor: 5000 }]),
    };
    part.payment = { ...part.payment!, statedAmountMinor: 5000 };
    await renderApp(routes, client, "/groups", fakeAi({ draft: part }));

    await type("paid Sam R50 for the pizza");
    expect(await screen.findByText(/^Pizza: R\s50,00 of R\s95,00$/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("checkbox", { name: /^Uber/ }));

    expect(await screen.findByText("Uber: not covered, the payment runs out")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /^Uber/ }).props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByText(/^You paid Sam R\s50,00$/)).toBeTruthy();
  });

  test("saving a payment reloads the groups list", async () => {
    const { client, calls } = fakeLedger(groupRoutes({ ...groupsList, [`POST /groups/${G}/settlements`]: () => json(201, {}) }));
    await renderApp(routes, client, "/groups", fakeAi({ draft: uberPayment([{ expenseId: UBER, amountMinor: 2500 }]) }));

    await type("paid Sam for the Uber");
    await fireEvent.press(await screen.findByText("Save"));

    expect(await screen.findByText("Payment recorded.")).toBeTruthy();
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.path === "/groups")).toHaveLength(2));
  });

  test("unticking an item re-totals the card", async () => {
    const { client } = fakeLedger(groupRoutes(groupsList));
    const both = uberPayment([
      { expenseId: PIZZA, amountMinor: 9500 },
      { expenseId: UBER, amountMinor: 2500 },
    ]);
    await renderApp(routes, client, "/groups", fakeAi({ draft: both }));

    await type("paid Sam for the pizza and the Uber");
    expect(await screen.findByText(/^You paid Sam R\s120,00$/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("checkbox", { name: /^Pizza · 1 Nov · R\s95,00 open$/ }));

    expect(await screen.findByText(/^You paid Sam R\s25,00$/)).toBeTruthy();
  });

  test("the counting-both line shows after saving", async () => {
    const { client } = fakeLedger(
      groupRoutes({
        ...groupsList,
        [`POST /groups/${G}/settlements`]: () => json(201, {}),
        [`GET /groups/${G}/open-items`]: () => json(200, openBoth(3000, 5000)),
      }),
    );
    await renderApp(routes, client, "/groups", fakeAi({ draft: uberPayment([{ expenseId: UBER, amountMinor: 2500 }]) }));

    await type("paid Sam for the Uber");
    await fireEvent.press(await screen.findByText("Save"));

    expect(await screen.findByText("Payment recorded.")).toBeTruthy();
    expect(await screen.findByText(/^Counting what Sam owes you, Sam owes you R\s20,00\.$/)).toBeTruthy();
  });

  test("a retried Save keeps its key; a changed card gets a new one", async () => {
    let attempts = 0;
    const { client, calls } = fakeLedger(
      groupRoutes({
        ...groupsList,
        [`POST /groups/${G}/settlements`]: () => {
          attempts++;
          if (attempts <= 2) throw new TypeError("Network request failed");
          return json(201, {});
        },
      }),
    );
    const both = uberPayment([
      { expenseId: PIZZA, amountMinor: 9500 },
      { expenseId: UBER, amountMinor: 2500 },
    ]);
    await renderApp(routes, client, "/groups", fakeAi({ draft: both }));

    await type("paid Sam for the pizza and the Uber");
    await fireEvent.press(await screen.findByText("Save"));
    expect(await screen.findByText("Couldn't reach Kitty. Check your connection and try again.")).toBeTruthy();
    await fireEvent.press(screen.getByText("Save"));
    await waitFor(() => expect(attempts).toBe(2));
    await fireEvent.press(screen.getByRole("checkbox", { name: /^Pizza/ }));
    await fireEvent.press(screen.getByText("Save"));

    expect(await screen.findByText("Payment recorded.")).toBeTruthy();
    const keys = calls.filter((c) => c.path === `/groups/${G}/settlements`).map((c) => c.headers.get("Idempotency-Key"));
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  test("an item that matched several open items is picked on the card", async () => {
    const { client } = fakeLedger(groupRoutes(groupsList));
    const unsure: PlainDraft = {
      ...uberPayment([]),
      issues: [{ field: "payment.items[0]", kind: "ambiguous", text: "food", candidates: [PIZZA, UBER] }],
    };
    await renderApp(routes, client, "/groups", fakeAi({ draft: unsure }));

    await type("paid Sam for the food");
    expect(await screen.findByText("Which food?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" }).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByRole("button", { name: /^Pizza · 1 Nov/ }));

    expect(await screen.findByText(/^You paid Sam R\s95,00$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" }).props.accessibilityState).toMatchObject({ disabled: false });
  });

  test("picking the other person reads the sentence again with that name", async () => {
    const { client } = fakeLedger(groupRoutes(groupsList));
    const unsure: PlainDraft = {
      ...uberPayment([]),
      payment: { ...uberPayment([]).payment!, toMemberId: null, openItems: [] },
      issues: [{ field: "payment.counterpart", kind: "no_match", text: "Sammy", candidates: [] }],
    };
    const resolved: unknown[] = [];
    const ai: AiClient = {
      parse: async () => ({ draft: unsure }),
      resolve: async (parsed, groupId) => (resolved.push({ parsed, groupId }), { draft: uberPayment([{ expenseId: UBER, amountMinor: 2500 }]) }),
      ask: async () => ({ error: "unexpected" }),
    };
    await renderApp(routes, client, "/groups", ai);

    await type("paid Sammy for the Uber");
    expect(await screen.findByText("“Sammy” isn't someone you can pay in this group. Who did you mean?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Zee" })).toBeNull(); // not yourself
    await fireEvent.press(screen.getByRole("button", { name: "Sam" }));

    expect(await screen.findByText(/^You paid Sam R\s25,00$/)).toBeTruthy();
    expect(resolved).toEqual([{ parsed: { kind: "payment", counterpart: "Sam", direction: "i_paid" }, groupId: G }]);
  });
});
