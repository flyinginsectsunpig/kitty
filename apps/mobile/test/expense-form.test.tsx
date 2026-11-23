import { act, fireEvent, screen } from "expo-router/testing-library";
import { Alert, Text } from "react-native";
import GroupLayout from "../src/app/(app)/groups/[id]/_layout";
import EditExpense from "../src/app/(app)/groups/[id]/expenses/[expenseId]";
import NewExpense from "../src/app/(app)/groups/[id]/expenses/new";
import { fakeLedger, json } from "./support/fake-ledger";
import { G, groupRoutes, ME, SAM } from "./support/group";
import { renderApp } from "./support/render-app";

const routes = {
  "(app)/groups/[id]/_layout": GroupLayout,
  "(app)/groups/[id]/index": () => <Text>Group home</Text>,
  "(app)/groups/[id]/expenses/new": NewExpense,
  "(app)/groups/[id]/expenses/[expenseId]": EditExpense,
};

const E = "44444444-4444-4444-8444-444444444444";
const saved = {
  id: E,
  description: "Dinner",
  category: "food",
  currency: "ZAR",
  amountMinor: 30000,
  occurredOn: "2026-11-20",
  payers: [{ memberId: SAM, amountMinor: 30000 }],
  split: { method: "equal", participants: [{ memberId: ME, value: null }, { memberId: SAM, value: null }] },
  shares: [],
  version: 3,
  createdBy: SAM,
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-20T10:00:00Z",
};

async function fillNew() {
  await fireEvent.changeText(await screen.findByLabelText("What was it for?"), "Groceries");
  await fireEvent.changeText(screen.getByLabelText("Amount"), "100");
}

test("retrying a failed save reuses the same Idempotency-Key", async () => {
  let attempts = 0;
  const { client, calls } = fakeLedger(
    groupRoutes({
      [`POST /groups/${G}/expenses`]: () => {
        attempts++;
        if (attempts === 1) throw new TypeError("Network request failed");
        return json(201, {});
      },
    }),
  );
  const { app } = await renderApp(routes, client, `/groups/${G}/expenses/new`);
  await fillNew();
  await fireEvent.press(screen.getByText(/^Save expense/));
  expect(await screen.findByText("Couldn't reach Kitty. Check your connection and try again.")).toBeTruthy();
  await fireEvent.press(screen.getByText(/^Save expense/));
  expect(await screen.findByText("Group home")).toBeTruthy();
  expect(app.getPathname()).toBe(`/groups/${G}`);

  const posts = calls.filter((c) => c.method === "POST");
  expect(posts).toHaveLength(2);
  expect(posts[0]!.headers.get("Idempotency-Key")).toBe(posts[1]!.headers.get("Idempotency-Key"));
  expect(posts[0]!.body.id).toBe(posts[1]!.body.id);
  expect(posts[1]!.body).toMatchObject({ description: "Groceries", amountMinor: 10000, currency: "ZAR", payers: [{ memberId: ME, amountMinor: 10000 }], split: { method: "equal" } });
});

test("an exact split that doesn't add up shows the split_sum_mismatch message before sending", async () => {
  const { client, calls } = fakeLedger(groupRoutes());
  await renderApp(routes, client, `/groups/${G}/expenses/new`);
  await fillNew();
  await fireEvent.press(screen.getByText("Amounts"));
  await fireEvent.changeText(screen.getByLabelText("You amount"), "30");
  await fireEvent.changeText(screen.getByLabelText("Sam amount"), "30");
  expect(await screen.findByText("The split must add up to the total.")).toBeTruthy();
  await fireEvent.press(screen.getByText(/^Save expense/));
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
});

test("editing sends the version and shows version_conflict text on 409", async () => {
  const { client, calls } = fakeLedger(
    groupRoutes({
      [`GET /groups/${G}/expenses/${E}`]: () => json(200, saved),
      [`PUT /groups/${G}/expenses/${E}`]: () => json(409, { code: "version_conflict" }),
    }),
  );
  await renderApp(routes, client, `/groups/${G}/expenses/${E}`);
  expect(await screen.findByDisplayValue("Dinner")).toBeTruthy();
  expect(screen.getByDisplayValue("300.00")).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText("What was it for?"), "Dinner out");
  await fireEvent.press(screen.getByText(/^Save changes/));
  expect(await screen.findByText("Someone else changed this expense. Reload to see their version.")).toBeTruthy();
  const put = calls.find((c) => c.method === "PUT")!;
  expect(put.body).toMatchObject({ id: E, version: 3, description: "Dinner out", payers: [{ memberId: SAM, amountMinor: 30000 }] });
});

test("delete asks for confirmation and returns to the group", async () => {
  const alert = jest.spyOn(Alert, "alert");
  const { client, calls } = fakeLedger(
    groupRoutes({
      [`GET /groups/${G}/expenses/${E}`]: () => json(200, saved),
      [`DELETE /groups/${G}/expenses/${E}`]: () => json(204),
    }),
  );
  const { app } = await renderApp(routes, client, `/groups/${G}/expenses/${E}`);
  await fireEvent.press(await screen.findByText("Delete expense"));
  expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0); // nothing until confirmed

  const buttons = alert.mock.calls[0]![2]!;
  await act(async () => buttons.find((b) => b.style === "destructive")!.onPress!());
  expect(await screen.findByText("Group home")).toBeTruthy();
  expect(app.getPathname()).toBe(`/groups/${G}`);
  expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  alert.mockRestore();
});

test("an itemized expense is shown read-only with delete", async () => {
  const { client } = fakeLedger(groupRoutes({ [`GET /groups/${G}/expenses/${E}`]: () => json(200, { ...saved, split: { method: "itemized", participants: [] } }) }));
  await renderApp(routes, client, `/groups/${G}/expenses/${E}`);
  expect(await screen.findByText(/split item by item at the table/)).toBeTruthy();
  expect(screen.queryByText(/^Save changes/)).toBeNull();
  expect(screen.getByText("Delete expense")).toBeTruthy();
});
