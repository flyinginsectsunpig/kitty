import { fireEvent, screen } from "expo-router/testing-library";
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
  expect(post.body).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), fromMemberId: ME, toMemberId: SAM, currency: "ZAR", amountMinor: 5000 });
  expect(post.headers.get("Idempotency-Key")).toBeTruthy();
});

test("a payee without details says so", async () => {
  const toMe = { currencies: [{ currency: "ZAR", members: [], transfers: [{ fromMemberId: SAM, toMemberId: ME, amountMinor: 700 }] }] };
  const { client } = fakeLedger(groupRoutes({ [`GET /groups/${G}/balances`]: () => json(200, toMe) }));
  await renderApp(routes, client, `/groups/${G}/settle`);
  expect(await screen.findByText(/^Sam pays you R\s7,00$/)).toBeTruthy();
  expect(screen.queryByText("Copy")).toBeNull(); // your own details aren't shown to you
});
