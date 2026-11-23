import { act, fireEvent, screen, testRouter, waitFor } from "expo-router/testing-library";
import { Text } from "react-native";
import GroupsIndex from "../src/app/(app)/groups/index";
import NewGroup from "../src/app/(app)/groups/new";
import { fakeLedger, json } from "./support/fake-ledger";
import { renderApp } from "./support/render-app";

const routes = {
  "(app)/groups/index": GroupsIndex,
  "(app)/groups/new": NewGroup,
  "(app)/groups/[id]/index": () => <Text>Group home</Text>,
};

test("lists groups with each balance formatted in the group currency", async () => {
  const { client } = fakeLedger({
    "GET /groups": () =>
      json(200, [
        { id: "g1", name: "Flat 4B", baseCurrency: "ZAR", memberCount: 3, myNet: [{ currency: "ZAR", netMinor: 12345 }] },
        { id: "g2", name: "Trip", baseCurrency: "USD", memberCount: 1, myNet: [{ currency: "USD", netMinor: -500 }] },
        { id: "g3", name: "Even", baseCurrency: "ZAR", memberCount: 2, myNet: [] },
      ]),
  });
  await renderApp(routes, client, "/groups");
  expect(await screen.findByText("Flat 4B")).toBeTruthy();
  expect(screen.getByText(/^You're owed R\s123,45$/)).toBeTruthy();
  expect(screen.getByText(/^You owe .*5[.,]00/)).toBeTruthy();
  expect(screen.getByText("Settled up")).toBeTruthy();
  expect(screen.getByText("3 people")).toBeTruthy();
  expect(screen.getByText("1 person")).toBeTruthy();
});

test("empty list shows No groups yet", async () => {
  const { client } = fakeLedger({ "GET /groups": () => json(200, []) });
  await renderApp(routes, client, "/groups");
  expect(await screen.findByText(/^No groups yet/)).toBeTruthy();
});

test("a failed load says so and can retry", async () => {
  let up = false;
  const { client } = fakeLedger({
    "GET /groups": () => {
      if (!up) throw new TypeError("Network request failed");
      return json(200, []);
    },
  });
  await renderApp(routes, client, "/groups");
  expect(await screen.findByText("Couldn't reach Kitty. Check your connection and try again.")).toBeTruthy();
  up = true;
  await fireEvent.press(screen.getByText("Try again"));
  expect(await screen.findByText(/^No groups yet/)).toBeTruthy();
});

test("creating a group posts name+currency and opens it", async () => {
  const { client, calls } = fakeLedger({ "POST /groups": () => json(201, {}) });
  const { app } = await renderApp(routes, client, "/groups/new");
  await fireEvent.changeText(await screen.findByLabelText("Name"), "Cape Town trip");
  await fireEvent.press(screen.getByText("Create group"));
  await waitFor(() => expect(app.getPathname()).toMatch(/^\/groups\/[0-9a-f-]{36}$/));
  const post = calls.find((c) => c.method === "POST")!;
  expect(post.body).toEqual({ id: app.getPathname().split("/")[2], name: "Cape Town trip", baseCurrency: "ZAR" });
  expect(post.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
  expect(await screen.findByText("Group home")).toBeTruthy();
});

test("a group needs a name", async () => {
  const { client, calls } = fakeLedger({});
  await renderApp(routes, client, "/groups/new");
  await fireEvent.press(await screen.findByText("Create group"));
  expect(await screen.findByText("Give the group a name.")).toBeTruthy();
  expect(calls).toHaveLength(0);
});

test("coming back to the list after creating a group shows it", async () => {
  const groups: unknown[] = [];
  const { client } = fakeLedger({
    "GET /groups": () => json(200, groups),
    "POST /groups": async (req) => {
      const body = await req.json();
      groups.push({ id: body.id, name: body.name, baseCurrency: "ZAR", memberCount: 1, myNet: [] });
      return json(201, {});
    },
  });
  await renderApp(routes, client, "/groups");
  expect(await screen.findByText(/^No groups yet/)).toBeTruthy();
  await fireEvent.press(screen.getByText("New group"));
  await fireEvent.changeText(await screen.findByLabelText("Name"), "Book club");
  await fireEvent.press(screen.getByText("Create group"));
  expect(await screen.findByText("Group home")).toBeTruthy();
  await act(async () => testRouter.back());
  expect(await screen.findByText("Book club")).toBeTruthy();
});

test("the currency list stays folded away until asked for", async () => {
  const { client, calls } = fakeLedger({ "POST /groups": () => json(201, {}) });
  const { app } = await renderApp(routes, client, "/groups/new");
  expect(await screen.findByText("ZAR")).toBeTruthy();
  expect(screen.queryByText("EUR")).toBeNull();
  await fireEvent.press(screen.getByText("Change currency"));
  await fireEvent.press(screen.getByText("EUR"));
  expect(screen.queryByText("GBP")).toBeNull(); // folds away again once picked
  await fireEvent.changeText(screen.getByLabelText("Name"), "Paris trip");
  await fireEvent.press(screen.getByText("Create group"));
  await waitFor(() => expect(app.getPathname()).toMatch(/^\/groups\/[0-9a-f-]{36}$/));
  expect(calls.find((c) => c.method === "POST")!.body.baseCurrency).toBe("EUR");
});
