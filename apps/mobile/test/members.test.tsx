import { act, fireEvent, screen } from "expo-router/testing-library";
import { Share, Text } from "react-native";
import Invite from "../src/app/(app)/invite/[token]";
import GroupLayout from "../src/app/(app)/groups/[id]/_layout";
import Members from "../src/app/(app)/groups/[id]/members";
import { config } from "../src/config";
import { fakeLedger, json } from "./support/fake-ledger";
import { G, group, groupRoutes, ME } from "./support/group";
import { renderApp } from "./support/render-app";

const routes = {
  "(app)/groups/[id]/_layout": GroupLayout,
  "(app)/groups/[id]/members": Members,
  "(app)/groups/[id]/index": () => <Text>Group home</Text>,
  "(app)/invite/[token]": Invite,
};

const GRAN = "55555555-5555-4555-8555-555555555555";

afterEach(() => jest.restoreAllMocks());

test("invite creates a link and opens the share sheet with it", async () => {
  const share = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" } as never);
  const { client, calls } = fakeLedger(groupRoutes({ [`POST /groups/${G}/invites`]: () => json(201, { token: "tok 1", expiresAt: "2026-11-30T00:00:00Z" }) }));
  await renderApp(routes, client, `/groups/${G}/members`);
  await fireEvent.press(await screen.findByText("Create invite link"));
  const link = `${config.webUrl}/invite/tok%201`;
  expect(await screen.findByText(link)).toBeTruthy();
  expect(share).toHaveBeenCalledWith({ message: expect.stringContaining(link) });
  expect(calls.find((c) => c.method === "POST")!.body).toEqual({ memberId: null });
});

test("inviting a placeholder scopes the link to them", async () => {
  jest.spyOn(Share, "share").mockResolvedValue({ action: "dismissedAction" } as never);
  const withGran = { ...group, members: [...group.members, { id: GRAN, displayName: "Gran", userId: null, isPlaceholder: true, paymentDetails: null }] };
  const { client, calls } = fakeLedger(
    groupRoutes({ [`GET /groups/${G}`]: () => json(200, withGran), [`POST /groups/${G}/invites`]: () => json(201, { token: "t2", expiresAt: "2026-11-30T00:00:00Z" }) }),
  );
  await renderApp(routes, client, `/groups/${G}/members`);
  expect(await screen.findByText("Not on Kitty yet")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("Invite Gran"));
  expect(await screen.findByText(`${config.webUrl}/invite/t2`)).toBeTruthy();
  expect(calls.find((c) => c.method === "POST")!.body).toEqual({ memberId: GRAN });
});

test("adding a placeholder shows them in the list", async () => {
  let members = group.members;
  const { client, calls } = fakeLedger(
    groupRoutes({
      [`GET /groups/${G}`]: () => json(200, { ...group, members }),
      [`POST /groups/${G}/members`]: () => {
        members = [...members, { id: GRAN, displayName: "Gran", userId: null, isPlaceholder: true, paymentDetails: null }];
        return json(201, {});
      },
    }),
  );
  await renderApp(routes, client, `/groups/${G}/members`);
  await fireEvent.changeText(await screen.findByLabelText("Add someone by name"), "Gran");
  await fireEvent.press(screen.getByText("Add person"));
  expect(await screen.findByText("Gran")).toBeTruthy();
  expect(calls.find((c) => c.method === "POST")!.body).toEqual({ displayName: "Gran" });
});

test("saving my details updates my member row", async () => {
  const { client, calls } = fakeLedger(groupRoutes({ [`PATCH /groups/${G}/members/${ME}`]: () => json(200, {}) }));
  await renderApp(routes, client, `/groups/${G}/members`);
  await fireEvent.changeText(await screen.findByLabelText("How people pay you back"), "PayShap 082");
  await fireEvent.press(screen.getByText("Save"));
  expect(await screen.findByText("Saved.")).toBeTruthy();
  expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ displayName: "Zee", paymentDetails: "PayShap 082" });
});

test("invite preview names the group and the spot being taken over, and joining opens the group", async () => {
  const { client, calls } = fakeLedger({
    "GET /invites/t3": () => json(200, { groupName: "Flat 4B", placeholderName: "Gran", expiresAt: "2026-11-30T00:00:00Z" }),
    "POST /invites/t3/accept": () => json(200, group),
    ...groupRoutes(),
  });
  const { app } = await renderApp(routes, client, "/invite/t3");
  expect(await screen.findByText("Flat 4B")).toBeTruthy();
  expect(screen.getByText("Gran")).toBeTruthy();
  await fireEvent.press(screen.getByText("Join group"));
  expect(await screen.findByText("Group home")).toBeTruthy();
  expect(app.getPathname()).toBe(`/groups/${G}`);
  expect(calls.find((c) => c.method === "POST")!.headers.get("Idempotency-Key")).toBeTruthy();
});

test("accepting an expired invite shows invite_expired text", async () => {
  const { client } = fakeLedger({
    "GET /invites/t4": () => json(200, { groupName: "Flat 4B", placeholderName: null, expiresAt: "2026-11-01T00:00:00Z" }),
    "POST /invites/t4/accept": () => json(410, { code: "invite_expired" }),
  });
  await renderApp(routes, client, "/invite/t4");
  await act(async () => fireEvent.press(await screen.findByText("Join group")));
  expect(await screen.findByText("This invite link has expired. Ask for a new one.")).toBeTruthy();
});

test("a used invite shows why on the preview", async () => {
  const { client } = fakeLedger({ "GET /invites/t5": () => json(410, { code: "invite_used" }) });
  await renderApp(routes, client, "/invite/t5");
  expect(await screen.findByText("This invite link has already been used. Ask for a new one.")).toBeTruthy();
  expect(screen.queryByText("Join group")).toBeNull();
});
