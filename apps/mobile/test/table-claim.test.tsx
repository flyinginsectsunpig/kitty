import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import { AppState, Text } from "react-native";
import GroupLayout from "../src/app/(app)/groups/[id]/_layout";
import TableScreen from "../src/app/(app)/groups/[id]/table/[sessionId]";
import NewTable from "../src/app/(app)/groups/[id]/table/new";
import TableLink from "../src/app/(app)/t/[sessionId]";
import { config } from "../src/config";
import { fakeLedger, json } from "./support/fake-ledger";
import { connections } from "./support/fake-signalr";
import { G, groupRoutes, ME, SAM } from "./support/group";
import { base, bill, I1, S } from "./support/table";
import { renderApp } from "./support/render-app";

jest.mock("@microsoft/signalr", () => require("./support/fake-signalr"));

const routes = {
  "(app)/groups/[id]/_layout": GroupLayout,
  "(app)/groups/[id]/table/new": NewTable,
  "(app)/groups/[id]/table/[sessionId]": TableScreen,
  "(app)/t/[sessionId]": TableLink,
  "(app)/groups/index": () => <Text>Groups</Text>,
};

/** The ledger as one bill: `current` is what a GET returns; tests move it forward. */
function tableLedger() {
  const state = { current: bill(1) as ReturnType<typeof bill> };
  const ledger = fakeLedger(
    groupRoutes({
      [`GET /groups/${G}/table-sessions`]: () => json(200, [{ id: S, title: "Friday dinner", status: "open", hostedByMe: false }]),
      [`GET ${base}`]: () => json(200, state.current),
      [`GET ${base}/listen-token`]: () => json(200, { token: "listen-1", expiresAt: "2026-11-23T23:00:00Z" }),
      [`PUT ${base}/items/${I1}/claim`]: () => {
        state.current = bill(state.current.version + 1, { items: [{ ...bill(1).items[0]!, claimants: [{ kind: "member", id: ME, displayName: "Zee" }] }, bill(1).items[1]!] });
        return json(200);
      },
    }),
  );
  const gets = () => ledger.calls.filter((c) => c.method === "GET" && c.path === base).length;
  return { ...ledger, state, gets };
}

beforeEach(() => connections.splice(0));

async function openBill(l: ReturnType<typeof tableLedger>) {
  await renderApp(routes, l.client, `/groups/${G}/table/${S}`);
  expect(await screen.findByText("Burger")).toBeTruthy();
  await waitFor(() => expect(connections[0]?.invoked).toEqual([{ method: "JoinSession", args: [S] }]));
  await waitFor(() => expect(l.gets()).toBe(2)); // the screen's load, then a catch-up once the connection is up
}

test("listens on the hub with this bill's listen token", async () => {
  const l = tableLedger();
  await openBill(l);
  expect(connections[0]!.url).toBe(`${config.hubUrl}?listen_token=listen-1`);
});

test("a hub change event triggers one re-fetch", async () => {
  const l = tableLedger();
  await openBill(l);
  l.state.current = bill(2, { title: "Friday dinner (moved)" });
  await act(async () => connections[0]!.emit("SessionChanged", { version: 2, status: "open" }));
  expect(await screen.findByText("Friday dinner (moved)")).toBeTruthy();
  expect(l.gets()).toBe(3);
  await act(async () => connections[0]!.emit("SessionChanged", { version: 2, status: "open" })); // already have it
  expect(l.gets()).toBe(3);
});

test("returning to the foreground re-fetches", async () => {
  const l = tableLedger();
  await openBill(l);
  // React Native's jest setup already mocks AppState.addEventListener; find the listener the screen registered.
  const calls = (AppState.addEventListener as jest.Mock).mock.calls.filter(([type]) => type === "change");
  const onChange = calls[calls.length - 1]![1] as (s: string) => void;
  await act(async () => onChange("active"));
  await waitFor(() => expect(l.gets()).toBe(3));
});

test("tapping an item claims it and shows my share", async () => {
  const l = tableLedger();
  await openBill(l);
  await fireEvent.press(screen.getByLabelText(/^Burger/));
  expect(l.calls.some((c) => c.method === "PUT" && c.path === `${base}/items/${I1}/claim`)).toBe(true);
  expect(await screen.findByText(/^R\s90,00$/, {}, { timeout: 2000 })).toBeTruthy(); // the share bar
});

test("a confirmed bill ends the live connection and shows the final share", async () => {
  const l = tableLedger();
  await openBill(l);
  l.state.current = bill(3, { status: "confirmed", preview: [{ kind: "member", id: ME, displayName: "Zee", amountMinor: 4500 }] });
  await act(async () => connections[0]!.emit("SessionChanged", { version: 3, status: "confirmed" }));
  expect(await screen.findByText("Done. The bill has been split.")).toBeTruthy();
  expect(screen.getByText(/^Your share is R\s45,00\. Pay Sam\.$/)).toBeTruthy();
  await waitFor(() => expect(connections[0]!.stopped).toBe(true));
});

test("malformed table link shows not found", async () => {
  const l = tableLedger();
  await renderApp(routes, l.client, `/groups/${G}/table/not-a-uuid`);
  expect(await screen.findByText("We couldn't find that.")).toBeTruthy();
  expect(l.calls.filter((c) => c.path.includes("table-sessions"))).toHaveLength(0);
});

test("the QR link opens the bill inside its group", async () => {
  const l = tableLedger();
  const { app } = await renderApp(routes, l.client, `/t/${S}?g=${G}`);
  expect(await screen.findByText("Burger")).toBeTruthy();
  expect(app.getPathname()).toBe(`/groups/${G}/table/${S}`);
});

test("a table link without its group says to use the web page", async () => {
  const l = tableLedger();
  await renderApp(routes, l.client, `/t/${S}`);
  expect(await screen.findByText(/Open this bill from its group/)).toBeTruthy();
});

test("starting a table creates it and opens it", async () => {
  const created: unknown[] = [];
  const ledger = fakeLedger({
    ...groupRoutes(),
    [`POST /groups/${G}/table-sessions`]: async (req) => {
      created.push(await req.json());
      return json(201, bill(1));
    },
    [`GET /groups/${G}/table-sessions`]: () => json(200, [{ id: S, title: "Friday dinner", status: "open", hostedByMe: false }]),
    [`GET ${base}`]: () => json(200, bill(1)),
    [`GET ${base}/listen-token`]: () => json(200, { token: "listen-1", expiresAt: "2026-11-23T23:00:00Z" }),
  });
  const { app } = await renderApp(routes, ledger.client, `/groups/${G}/table/new`);
  await fireEvent.changeText(await screen.findByLabelText("Where are you?"), "Friday dinner");
  await fireEvent.press(screen.getByText("Start"));
  await waitFor(() => expect(app.getPathname()).toMatch(new RegExp(`^/groups/${G}/table/[0-9a-f-]{36}$`)));
  expect(created[0]).toMatchObject({ title: "Friday dinner", currency: "ZAR", payerMemberId: ME });
});
