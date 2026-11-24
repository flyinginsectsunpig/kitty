import { fireEvent, screen } from "expo-router/testing-library";
import { Text } from "react-native";
import GroupLayout from "../src/app/(app)/groups/[id]/_layout";
import NewExpense from "../src/app/(app)/groups/[id]/expenses/new";
import Overview from "../src/app/(app)/groups/[id]/index";
import RecurringScreen from "../src/app/(app)/groups/[id]/recurring/[scheduleId]";
import { fakeLedger, json } from "./support/fake-ledger";
import { G, groupRoutes, ME, SAM } from "./support/group";
import { renderApp } from "./support/render-app";

const S = "55555555-5555-4555-8555-555555555555";

const schedule = (overrides: Record<string, unknown> = {}) => ({
  id: S,
  description: "Rent",
  category: "rent",
  currency: "ZAR",
  amountMinor: 1200000,
  payers: [{ memberId: ME, amountMinor: 1200000 }],
  split: { method: "equal", participants: [{ memberId: ME, value: null }, { memberId: SAM, value: null }] },
  frequency: "monthly",
  startsOn: "2026-12-01",
  endsOn: null,
  paused: false,
  nextDueOn: "2026-12-01",
  lastAddedOn: null,
  version: 1,
  createdBy: "user-me",
  ...overrides,
});

const newRoutes = {
  "(app)/groups/[id]/_layout": GroupLayout,
  "(app)/groups/[id]/index": () => <Text>Group home</Text>,
  "(app)/groups/[id]/expenses/new": NewExpense,
};

async function fillRent() {
  await fireEvent.changeText(await screen.findByLabelText("What was it for?"), "Rent");
  await fireEvent.changeText(screen.getByLabelText("Amount"), "12000");
  await fireEvent.changeText(screen.getByLabelText("Date"), "2026-12-31");
}

test("repeat monthly posts a schedule, not an expense", async () => {
  const { client, calls } = fakeLedger(groupRoutes({ [`POST /groups/${G}/recurring`]: () => json(201, schedule()) }));
  await renderApp(newRoutes, client, `/groups/${G}/expenses/new`);
  await fillRent();
  await fireEvent.press(screen.getByText("Every month"));
  await fireEvent.press(screen.getByText(/^Save expense/));

  expect(await screen.findByText("Group home")).toBeTruthy();
  expect(calls.some((c) => c.method === "POST" && c.path === `/groups/${G}/expenses`)).toBe(false);
  const post = calls.find((c) => c.method === "POST" && c.path === `/groups/${G}/recurring`)!;
  expect(post.body).toMatchObject({ description: "Rent", amountMinor: 1200000, frequency: "monthly", startsOn: "2026-12-31", endsOn: null });
  expect(post.headers.get("Idempotency-Key")).toBeTruthy();
});

test("the rule line follows the date", async () => {
  const { client } = fakeLedger(groupRoutes());
  await renderApp(newRoutes, client, `/groups/${G}/expenses/new`);
  await fillRent();
  await fireEvent.press(screen.getByText("Every month"));

  expect(await screen.findByText(/^Every month on the 31st \(the last day in shorter months\), starting 2026-12-31/)).toBeTruthy();
  await fireEvent.press(screen.getByText("Every week"));
  expect(await screen.findByText(/^Every Thursday, starting 2026-12-31/)).toBeTruthy();
});

test("group home lists repeating schedules with next due", async () => {
  const { client } = fakeLedger(
    groupRoutes({
      [`GET /groups/${G}/balances`]: () => json(200, { currencies: [], converted: null }),
      [`GET /groups/${G}/table-sessions`]: () => json(200, []),
      [`GET /groups/${G}/expenses`]: () => json(200, { items: [], nextCursor: null }),
      [`GET /groups/${G}/recurring`]: () => json(200, [schedule()]),
    }),
  );
  await renderApp({ "(app)/groups/[id]/_layout": GroupLayout, "(app)/groups/[id]/index": Overview }, client, `/groups/${G}`);

  expect(await screen.findByText("Repeating")).toBeTruthy();
  expect(screen.getByText("Rent")).toBeTruthy();
  expect(screen.getByText(/Every month on the 1st · next 1 Dec 2026$/)).toBeTruthy();
});

const scheduleRoutes = { "(app)/groups/[id]/_layout": GroupLayout, "(app)/groups/[id]/recurring/[scheduleId]": RecurringScreen };

test("pause and resume call the ledger and refresh", async () => {
  let paused = false;
  const { client, calls } = fakeLedger(
    groupRoutes({
      [`GET /groups/${G}/recurring/${S}`]: () => json(200, schedule({ paused, nextDueOn: paused ? null : "2026-12-01" })),
      [`POST /groups/${G}/recurring/${S}/pause`]: () => {
        paused = true;
        return json(200, schedule({ paused: true, nextDueOn: null }));
      },
      [`POST /groups/${G}/recurring/${S}/resume`]: () => {
        paused = false;
        return json(200, schedule());
      },
    }),
  );
  await renderApp(scheduleRoutes, client, `/groups/${G}/recurring/${S}`);

  await fireEvent.press(await screen.findByText("Pause"));
  expect(await screen.findByText("Resume")).toBeTruthy();
  await fireEvent.press(screen.getByText("Resume"));
  expect(await screen.findByText("Pause")).toBeTruthy();
  expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
    `/groups/${G}/recurring/${S}/pause`,
    `/groups/${G}/recurring/${S}/resume`,
  ]);
});

test("a started schedule's date is read-only", async () => {
  const { client } = fakeLedger(groupRoutes({ [`GET /groups/${G}/recurring/${S}`]: () => json(200, schedule({ lastAddedOn: "2026-12-01" })) }));
  await renderApp(scheduleRoutes, client, `/groups/${G}/recurring/${S}`);

  expect(await screen.findByLabelText("Date")).toBeDisabled();
  expect(screen.getByText("It has already added expenses, so the start date stays.")).toBeTruthy();
});
