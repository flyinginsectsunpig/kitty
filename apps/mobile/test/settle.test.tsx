import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import { Alert } from "react-native";
import GroupLayout from "../src/app/(app)/groups/[id]/_layout";
import Settle from "../src/app/(app)/groups/[id]/settle";
import { fakeLedger, json } from "./support/fake-ledger";
import { G, groupRoutes, ME, SAM } from "./support/group";
import { renderApp } from "./support/render-app";

const routes = { "(app)/groups/[id]/_layout": GroupLayout, "(app)/groups/[id]/settle": Settle };

const owing = { currencies: [{ currency: "ZAR", members: [], transfers: [{ fromMemberId: ME, toMemberId: SAM, amountMinor: 5000 }] }] };
const settled = { currencies: [{ currency: "ZAR", members: [], transfers: [] }] };

test("suggested transfer shows amount and the payee's payment details", async () => {
  const { client } = fakeLedger(groupRoutes({ [`GET /groups/${G}/balances`]: () => json(200, owing) }));
  await renderApp(routes, client, `/groups/${G}/settle`);
  expect(await screen.findByText(/^You pay Sam R\s50,00$/)).toBeTruthy();
  expect(screen.getByText("FNB 123")).toBeTruthy();
  expect(screen.getByText("Copy")).toBeTruthy();
});

test("marking paid records a settlement and refreshes balances", async () => {
  let paid = false;
  const { client, calls } = fakeLedger(
    groupRoutes({
      [`GET /groups/${G}/balances`]: () => json(200, paid ? settled : owing),
      [`POST /groups/${G}/settlements`]: () => {
        paid = true;
        return json(201, {});
      },
    }),
  );
  await renderApp(routes, client, `/groups/${G}/settle`);
  await fireEvent.press(await screen.findByText("Mark as paid"));
  expect(await screen.findByText("Payment recorded.")).toBeTruthy();
  expect(await screen.findByText(/^Everyone is settled up/)).toBeTruthy();
  const post = calls.find((c) => c.method === "POST")!;
  expect(post.body).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), fromMemberId: ME, toMemberId: SAM, currency: "ZAR", amountMinor: 5000, paidInGroupCurrency: false });
  expect(post.headers.get("Idempotency-Key")).toBeTruthy();
});

test("a payee without details says so", async () => {
  const toMe = { currencies: [{ currency: "ZAR", members: [], transfers: [{ fromMemberId: SAM, toMemberId: ME, amountMinor: 700 }] }] };
  const { client } = fakeLedger(groupRoutes({ [`GET /groups/${G}/balances`]: () => json(200, toMe) }));
  await renderApp(routes, client, `/groups/${G}/settle`);
  expect(await screen.findByText(/^Sam pays you R\s7,00$/)).toBeTruthy();
  expect(screen.queryByText("Copy")).toBeNull(); // your own details aren't shown to you
});

describe("a debt in another currency", () => {
  const euros = { currencies: [{ currency: "EUR", members: [], transfers: [{ fromMemberId: ME, toMemberId: SAM, amountMinor: 2000 }] }] };
  const ecb = () => json(200, { rate: "19.1987", rateDate: "2026-11-20", source: "ecb" });

  test("settle pays a EUR debt in ZAR at the confirmed rate", async () => {
    const { client, calls } = fakeLedger(
      groupRoutes({
        [`GET /groups/${G}/balances`]: () => json(200, euros),
        [`GET /groups/${G}/fx-rate`]: ecb,
        [`POST /groups/${G}/settlements`]: () => json(201, {}),
      }),
    );
    await renderApp(routes, client, `/groups/${G}/settle`);

    expect(await screen.findByText("1 EUR = 19.1987 ZAR · ECB, 20 Nov 2026")).toBeTruthy();
    await fireEvent.press(screen.getByText("Pay in ZAR instead"));
    await fireEvent.changeText(await screen.findByLabelText(/^Rate/), "19.5");
    expect(await screen.findByText(/^Pay R\s390,00$/)).toBeTruthy();
    await fireEvent.press(screen.getByText("Mark as paid"));

    expect(await screen.findByText("Payment recorded.")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ currency: "EUR", amountMinor: 2000, fxRate: "19.5", paidInGroupCurrency: true });
  });

  test("paying in ZAR at the shown rate sends that rate, so the amount stored is the amount shown", async () => {
    const { client, calls } = fakeLedger(
      groupRoutes({
        [`GET /groups/${G}/balances`]: () => json(200, euros),
        [`GET /groups/${G}/fx-rate`]: ecb,
        [`POST /groups/${G}/settlements`]: () => json(201, {}),
      }),
    );
    await renderApp(routes, client, `/groups/${G}/settle`);
    await screen.findByText("1 EUR = 19.1987 ZAR · ECB, 20 Nov 2026");
    await fireEvent.press(screen.getByText("Pay in ZAR instead"));
    expect(await screen.findByText(/^Pay R\s383,97$/)).toBeTruthy();
    await fireEvent.press(screen.getByText("Mark as paid"));

    expect(await screen.findByText("Payment recorded.")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ fxRate: "19.1987", paidInGroupCurrency: true });
  });

  test("an invalid typed rate is rejected, not swapped for the ECB rate", async () => {
    const { client, calls } = fakeLedger(
      groupRoutes({
        [`GET /groups/${G}/balances`]: () => json(200, euros),
        [`GET /groups/${G}/fx-rate`]: ecb,
        [`POST /groups/${G}/settlements`]: () => json(400, { code: "fx_rate_invalid" }),
      }),
    );
    await renderApp(routes, client, `/groups/${G}/settle`);
    await screen.findByText("1 EUR = 19.1987 ZAR · ECB, 20 Nov 2026");
    await fireEvent.press(screen.getByText("Pay in ZAR instead"));
    await fireEvent.changeText(await screen.findByLabelText(/^Rate/), "19.");
    await fireEvent.press(screen.getByText("Mark as paid"));

    expect(await screen.findByText("That exchange rate doesn't look right.")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")!.body.fxRate).toBe("19.");
  });

  test("a rate typed and then hidden again isn't sent", async () => {
    const { client, calls } = fakeLedger(
      groupRoutes({
        [`GET /groups/${G}/balances`]: () => json(200, euros),
        [`GET /groups/${G}/fx-rate`]: ecb,
        [`POST /groups/${G}/settlements`]: () => json(201, {}),
      }),
    );
    await renderApp(routes, client, `/groups/${G}/settle`);
    await screen.findByText("1 EUR = 19.1987 ZAR · ECB, 20 Nov 2026");
    await fireEvent.press(screen.getByText("Pay in ZAR instead"));
    await fireEvent.changeText(await screen.findByLabelText(/^Rate/), "25");
    await fireEvent.press(screen.getByText("Pay in ZAR instead")); // changed their mind: paying in euros
    await fireEvent.press(screen.getByText("Mark as paid"));

    expect(await screen.findByText("Payment recorded.")).toBeTruthy();
    const body = calls.find((c) => c.method === "POST")!.body;
    expect(body).not.toHaveProperty("fxRate");
    expect(body.paidInGroupCurrency).toBe(false);
  });

  test("settle shows the rate input after fx_rate_required", async () => {
    const { client, calls } = fakeLedger(
      groupRoutes({
        [`GET /groups/${G}/balances`]: () => json(200, euros),
        [`GET /groups/${G}/fx-rate`]: ecb,
        [`POST /groups/${G}/settlements`]: () => json(422, { code: "fx_rate_required" }),
      }),
    );
    await renderApp(routes, client, `/groups/${G}/settle`);
    await screen.findByText("1 EUR = 19.1987 ZAR · ECB, 20 Nov 2026");
    expect(screen.queryByLabelText(/^Rate/)).toBeNull();

    await fireEvent.press(screen.getByText("Mark as paid"));

    expect(await screen.findByText("We couldn't look up the exchange rate. Enter it to record this payment.")).toBeTruthy();
    expect(screen.getByLabelText(/^Rate/)).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});

describe("what a payment covers", () => {
  const PIZZA = "44444444-4444-4444-8444-444444444444";
  const UBER = "55555555-5555-4555-8555-555555555555";
  const money = (minor: number) => ({ currency: "ZAR", minor, text: "" });
  const line = (expenseId: string, description: string, date: string, open: number) => ({
    item: { expenseId, description, date, category: "food", total: money(open * 2), myShare: money(open), paidBy: "Sam" },
    open: money(open),
  });
  const open = {
    fromMemberId: ME,
    toMemberId: SAM,
    currencies: [
      {
        currency: "ZAR",
        fromOwes: [line(PIZZA, "Pizza", "2026-11-01", 4000), line(UBER, "Uber", "2026-11-10", 2500)],
        fromOwesTotal: money(6500),
        toOwes: [],
        toOwesTotal: money(0),
      },
    ],
  };

  test("ticked items go with Mark as paid", async () => {
    const { client, calls } = fakeLedger(
      groupRoutes({
        [`GET /groups/${G}/balances`]: () => json(200, owing),
        [`GET /groups/${G}/open-items`]: () => json(200, open),
        [`POST /groups/${G}/settlements`]: () => json(201, {}),
      }),
    );
    await renderApp(routes, client, `/groups/${G}/settle`);
    await fireEvent.press(await screen.findByText("What it covers"));
    await fireEvent.press(screen.getByRole("checkbox", { name: /^Uber · 10 Nov · R\s25,00 open$/ }));
    await fireEvent.press(screen.getByText("Mark as paid"));

    expect(await screen.findByText("Payment recorded.")).toBeTruthy();
    expect(calls.find((c) => c.method === "GET" && c.path === `/groups/${G}/open-items`)!.search).toBe(`?from=${ME}&to=${SAM}`);
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ amountMinor: 5000, covers: [{ expenseId: UBER, amountMinor: 2500 }] });
  });

  test("a partly covered item says so", async () => {
    const { client } = fakeLedger(
      groupRoutes({ [`GET /groups/${G}/balances`]: () => json(200, owing), [`GET /groups/${G}/open-items`]: () => json(200, open) }),
    );
    await renderApp(routes, client, `/groups/${G}/settle`);
    await fireEvent.press(await screen.findByText("What it covers"));
    await fireEvent.press(screen.getByRole("checkbox", { name: /^Uber/ }));
    await fireEvent.press(screen.getByRole("checkbox", { name: /^Pizza/ }));

    expect(await screen.findByText(/^Uber: R\s10,00 of R\s25,00$/)).toBeTruthy();
  });

  test("a ticked item the payment doesn't reach says so", async () => {
    const withGroceries = {
      ...open,
      currencies: [{ ...open.currencies[0]!, fromOwes: [...open.currencies[0]!.fromOwes, line("e-groceries", "Groceries", "2026-11-20", 3000)] }],
    };
    const { client } = fakeLedger(
      groupRoutes({ [`GET /groups/${G}/balances`]: () => json(200, owing), [`GET /groups/${G}/open-items`]: () => json(200, withGroceries) }),
    );
    await renderApp(routes, client, `/groups/${G}/settle`);
    await fireEvent.press(await screen.findByText("What it covers"));
    for (const name of [/^Groceries/, /^Uber/, /^Pizza/]) await fireEvent.press(screen.getByRole("checkbox", { name }));

    expect(await screen.findByText(/^Uber: R\s10,00 of R\s25,00$/)).toBeTruthy();
    expect(screen.getByText("Groceries: not covered, the payment runs out")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /^Groceries/ }).props.accessibilityState).toMatchObject({ checked: true });
  });

  test("open items that can't be loaded leave the transfer without ticks", async () => {
    const { client } = fakeLedger(
      groupRoutes({
        [`GET /groups/${G}/balances`]: () => json(200, owing),
        [`GET /groups/${G}/open-items`]: () => {
          throw new TypeError("Network request failed");
        },
      }),
    );
    await renderApp(routes, client, `/groups/${G}/settle`);
    expect(await screen.findByText("Mark as paid")).toBeTruthy();
    expect(screen.queryByText("What it covers")).toBeNull();
  });
});

describe("recent payments", () => {
  const P = "66666666-6666-4666-8666-666666666666";
  const payment = {
    payment: {
      id: P, fromMemberId: ME, toMemberId: SAM, currency: "ZAR", amountMinor: 2500, createdBy: ME, createdAt: "2026-11-20T10:00:00Z",
      fxRate: null, fxRateDate: null, fxRateSource: null, convertedAmountMinor: null, paidInGroupCurrency: false,
      covers: [{ expenseId: "e-uber", amountMinor: 2500 }],
    },
    from: "Zee",
    to: "Sam",
    date: "2026-11-20",
    covers: [{ expenseId: "e-uber", description: "Uber", amount: { currency: "ZAR", minor: 2500, text: "" } }],
  };

  test("recent payments list and delete", async () => {
    const alert = jest.spyOn(Alert, "alert");
    let deleted = false;
    const { client, calls } = fakeLedger(
      groupRoutes({
        [`GET /groups/${G}/balances`]: () => json(200, settled),
        [`GET /groups/${G}/settlements`]: () => json(200, deleted ? [] : [payment]),
        [`DELETE /groups/${G}/settlements/${P}`]: () => {
          deleted = true;
          return json(204);
        },
      }),
    );
    await renderApp(routes, client, `/groups/${G}/settle`);

    expect(await screen.findByText("Recent payments")).toBeTruthy();
    expect(screen.getByText(/^You paid Sam R\s25,00 · 20 Nov · for: Uber$/)).toBeTruthy();
    expect(screen.getByText(/^Everyone is settled up/)).toBeTruthy();
    expect(calls.find((c) => c.path === `/groups/${G}/settlements`)!.search).toBe("?limit=20");
    await fireEvent.press(screen.getByRole("button", { name: /^Delete payment: You paid Sam R\s25,00$/ }));
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0); // nothing until confirmed

    const [title, message, buttons] = alert.mock.calls[0]!;
    expect([title, message]).toEqual(["Delete this payment?", "Its items go back on the list."]);
    expect(buttons!.map((b) => b.text)).toEqual(["Cancel", "Delete"]);
    await act(async () => buttons!.find((b) => b.text === "Delete")!.onPress!());

    expect(await screen.findByText("Payment deleted.")).toBeTruthy();
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.path).toBe(`/groups/${G}/settlements/${P}`);
    expect(del.headers.get("Idempotency-Key")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Recent payments")).toBeNull());
    expect(calls.filter((c) => c.path === `/groups/${G}/balances`)).toHaveLength(2);
    alert.mockRestore();
  });

  test("payments that can't be loaded leave the section out", async () => {
    const { client } = fakeLedger(
      groupRoutes({ [`GET /groups/${G}/balances`]: () => json(200, owing), [`GET /groups/${G}/settlements`]: () => json(500, { code: "unexpected" }) }),
    );
    await renderApp(routes, client, `/groups/${G}/settle`);
    expect(await screen.findByText(/^You pay Sam R\s50,00$/)).toBeTruthy();
    expect(screen.queryByText("Recent payments")).toBeNull();
  });
});
