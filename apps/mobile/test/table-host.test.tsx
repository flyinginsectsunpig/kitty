import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import { Text } from "react-native";
import GroupLayout from "../src/app/(app)/groups/[id]/_layout";
import TableScreen from "../src/app/(app)/groups/[id]/table/[sessionId]";
import { config } from "../src/config";
import { fakeLedger, json, type Handler } from "./support/fake-ledger";
import { connections } from "./support/fake-signalr";
import { G, groupRoutes, ME, SAM } from "./support/group";
import { base, bill, I1, S } from "./support/table";
import { renderApp } from "./support/render-app";

jest.mock("@microsoft/signalr", () => require("./support/fake-signalr"));
jest.mock("react-native-qrcode-svg", () => {
  const { Text: T } = require("react-native");
  return (props: { value: string }) => <T testID="qr">{props.value}</T>;
});

const routes = {
  "(app)/groups/[id]/_layout": GroupLayout,
  "(app)/groups/[id]/table/[sessionId]": TableScreen,
  "(app)/groups/[id]/index": () => <Text>Group home</Text>,
};

const hosted = (over: Parameters<typeof bill>[1] = {}) => bill(1, { payerMemberId: ME, payerDisplayName: "Zee", ...over });

function hostLedger(initial: ReturnType<typeof bill>, extra: Record<string, Handler> = {}) {
  const state = { current: initial };
  const ledger = fakeLedger(
    groupRoutes({
      [`GET /groups/${G}/table-sessions`]: () => json(200, [{ id: S, title: "Friday dinner", status: "open", hostedByMe: true }]),
      [`GET ${base}`]: () => json(200, state.current),
      [`GET ${base}/listen-token`]: () => json(200, { token: "listen-1", expiresAt: "2026-11-23T23:00:00Z" }),
      ...extra,
    }),
  );
  return { ...ledger, state };
}

beforeEach(() => connections.splice(0));

async function openAsHost(l: ReturnType<typeof hostLedger>) {
  await renderApp(routes, l.client, `/groups/${G}/table/${S}`);
  expect(await screen.findByText("You're running this table")).toBeTruthy();
  await waitFor(() => expect(connections[0]?.invoked).toHaveLength(1));
}

test("a thrown lock request shows the network error and re-enables Lock", async () => {
  const l = hostLedger(hosted(), {
    [`POST ${base}/lock`]: () => {
      throw new TypeError("Network request failed");
    },
  });
  await openAsHost(l);
  await fireEvent.press(screen.getByText("Lock the bill"));
  expect(await screen.findByText("Couldn't reach Kitty. Check your connection and try again.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Lock the bill" }).props.accessibilityState).toMatchObject({ disabled: false, busy: false });
});

test("unedited item rows follow a bill a scan just filled", async () => {
  const l = hostLedger(hosted({ items: [] }));
  await openAsHost(l);
  expect(screen.queryByDisplayValue("Burger")).toBeNull();
  l.state.current = hosted({ version: 2, items: bill(1).items });
  await act(async () => connections[0]!.emit("SessionChanged", { version: 2, status: "open" }));
  expect(await screen.findByDisplayValue("Burger")).toBeTruthy();
  expect(screen.getByDisplayValue("90.00")).toBeTruthy();
  expect(screen.getByText("Items saved")).toBeTruthy();
});

test("saving items sends what was typed", async () => {
  let body: any;
  const l = hostLedger(hosted({ items: [] }), {
    [`PUT ${base}/items`]: async (req) => {
      body = await req.json();
      return json(200, hosted({ version: 2, items: [{ id: body.items[0].id, description: "Pizza", quantity: 2, lineTotalMinor: 15000, claimants: [] }] }));
    },
  });
  await openAsHost(l);
  await fireEvent.press(screen.getByText("Add item"));
  await fireEvent.changeText(screen.getByLabelText("Item 1 name"), "Pizza");
  await fireEvent.changeText(screen.getByLabelText("Item 1 quantity"), "2");
  await fireEvent.changeText(screen.getByLabelText("Item 1 price"), "150");
  await fireEvent.press(screen.getByText("Save items"));
  expect(await screen.findByText("Items saved")).toBeTruthy();
  expect(body.items).toEqual([{ id: expect.stringMatching(/^[0-9a-f-]{36}$/), description: "Pizza", quantity: 2, lineTotalMinor: 15000 }]);
});

test("Confirm and split is disabled while nobody has claimed anything, or a guest who claimed is unmatched", async () => {
  const GUEST = "88888888-8888-4888-8888-888888888888";
  const l = hostLedger(hosted());
  await openAsHost(l);
  expect(screen.getByText("Nobody has tapped anything yet, so there is nothing to split.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Confirm and split" }).props.accessibilityState.disabled).toBe(true);

  l.state.current = hosted({
    version: 2,
    items: [{ ...bill(1).items[0]!, claimants: [{ kind: "guest", id: GUEST, displayName: "Thabo" }] }, bill(1).items[1]!],
    guests: [{ id: GUEST, displayName: "Thabo", mappedMemberId: null }],
    preview: [{ kind: "guest", id: GUEST, displayName: "Thabo", amountMinor: 15000 }],
  });
  await act(async () => connections[0]!.emit("SessionChanged", { version: 2, status: "open" }));
  expect(await screen.findByText("Match Thabo to someone in the group before confirming.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Confirm and split" }).props.accessibilityState.disabled).toBe(true);
});

test("matching a guest to a member posts the mapping", async () => {
  const GUEST = "88888888-8888-4888-8888-888888888888";
  let mapped: unknown;
  const withGuest = hosted({
    items: [{ ...bill(1).items[0]!, claimants: [{ kind: "guest", id: GUEST, displayName: "Thabo" }] }],
    guests: [{ id: GUEST, displayName: "Thabo", mappedMemberId: null }],
    preview: [{ kind: "guest", id: GUEST, displayName: "Thabo", amountMinor: 9000 }],
  });
  const l = hostLedger(withGuest, {
    [`POST ${base}/guests/${GUEST}/map`]: async (req) => {
      mapped = await req.json();
      return json(200, { ...withGuest, version: 2, guests: [{ id: GUEST, displayName: "Thabo", mappedMemberId: SAM }] });
    },
  });
  await openAsHost(l);
  await fireEvent.press(screen.getByRole("radio", { name: "Thabo is Sam" }));
  await waitFor(() => expect(mapped).toEqual({ memberId: SAM }));
  expect(await screen.findByRole("button", { name: "Confirm and split" })).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm and split" }).props.accessibilityState.disabled).toBe(false));
});

test("QR encodes the web table link with the group id", async () => {
  const l = hostLedger(hosted());
  await openAsHost(l);
  expect(screen.getByTestId("qr").props.children).toBe(`${config.webUrl}/t/${S}?g=${G}`);
});

test("confirming lands back on the group", async () => {
  const claimed = hosted({
    items: [{ ...bill(1).items[0]!, claimants: [{ kind: "member", id: ME, displayName: "Zee" }] }],
    preview: [{ kind: "member", id: ME, displayName: "Zee", amountMinor: 9000 }],
  });
  const l = hostLedger(claimed, { [`POST ${base}/confirm`]: () => json(200, { ...claimed, status: "confirmed", expenseId: I1, version: 2 }) });
  const { app } = await renderApp(routes, l.client, `/groups/${G}/table/${S}`);
  await fireEvent.press(await screen.findByText("Confirm and split"));
  expect(await screen.findByText("Group home")).toBeTruthy();
  expect(app.getPathname()).toBe(`/groups/${G}`);
});

test("setting a 10% tip on a R150 bill sends R15", async () => {
  let charges: any;
  const l = hostLedger(hosted(), {
    [`PUT ${base}/charges`]: async (req) => {
      charges = (await req.json()).charges;
      return json(200, hosted({ version: 2, charges: [{ id: charges[0].id, kind: "tip", amountMinor: 1500 }] }));
    },
  });
  await openAsHost(l);
  await fireEvent.changeText(screen.getByLabelText("Tip"), "10");
  await fireEvent.press(screen.getByText("Set tip"));
  await waitFor(() => expect(charges).toEqual([{ id: expect.any(String), kind: "tip", amountMinor: 1500 }]));
});

test("adding a guest to the group creates a placeholder and matches the guest to it", async () => {
  const GUEST = "88888888-8888-4888-8888-888888888888";
  const NEW = "99999999-9999-4999-8999-999999999999";
  const posted: { path: string; body: unknown }[] = [];
  const withGuest = hosted({
    items: [{ ...bill(1).items[0]!, claimants: [{ kind: "guest", id: GUEST, displayName: "Thabo" }] }],
    guests: [{ id: GUEST, displayName: "Thabo", mappedMemberId: null }],
    preview: [{ kind: "guest", id: GUEST, displayName: "Thabo", amountMinor: 9000 }],
  });
  const l = hostLedger(withGuest, {
    [`POST /groups/${G}/members`]: async (req) => {
      posted.push({ path: "members", body: await req.json() });
      return json(201, { id: NEW, displayName: "Thabo", userId: null, isPlaceholder: true, paymentDetails: null });
    },
    [`POST ${base}/guests/${GUEST}/map`]: async (req) => {
      posted.push({ path: "map", body: await req.json() });
      return json(200, { ...withGuest, version: 2, guests: [{ id: GUEST, displayName: "Thabo", mappedMemberId: NEW }] });
    },
  });
  await openAsHost(l);
  await fireEvent.press(screen.getByRole("radio", { name: "Add Thabo to the group" }));
  await waitFor(() => expect(posted).toEqual([{ path: "members", body: { displayName: "Thabo" } }, { path: "map", body: { memberId: NEW } }]));
});
