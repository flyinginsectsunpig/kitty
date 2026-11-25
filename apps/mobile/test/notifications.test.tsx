import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import * as Notifications from "expo-notifications";
import { Text } from "react-native";
import GroupsIndex from "../src/app/(app)/groups/index";
import NotificationsScreen from "../src/app/(app)/notifications";
import { registerDevice } from "../src/notifications/registerDevice";
import { fakeLedger, json } from "./support/fake-ledger";
import { renderApp } from "./support/render-app";

const n = jest.mocked(Notifications);

const settings = {
  expensePush: true, expenseEmail: false, paymentPush: true, paymentEmail: false, weeklyPush: false, weeklyEmail: false,
  emailAvailable: true,
};

function allowNotifications(token = "fcm-1") {
  n.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true } as any);
  n.getDevicePushTokenAsync.mockResolvedValue({ type: "android", data: token } as any);
}

beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  n.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true } as any);
  n.getDevicePushTokenAsync.mockRejectedValue(new Error("no Firebase config"));
});

test("registers the FCM token after permission is granted", async () => {
  n.requestPermissionsAsync.mockResolvedValueOnce({ granted: true, canAskAgain: true } as any);
  n.getDevicePushTokenAsync.mockResolvedValueOnce({ type: "android", data: "fcm-1" } as any);
  const { client, calls } = fakeLedger({ "POST /me/devices": () => json(204) });

  expect(await registerDevice(client)).toBe("registered");

  expect(n.requestPermissionsAsync).toHaveBeenCalled();
  expect(calls.find((c) => c.path === "/me/devices")?.body).toEqual({ token: "fcm-1", platform: "android" });
});

test("denied permission registers nothing", async () => {
  const { client, calls } = fakeLedger({});
  expect(await registerDevice(client)).toBe("denied");
  expect(n.getDevicePushTokenAsync).not.toHaveBeenCalled();
  expect(calls).toHaveLength(0);
});

test("no Firebase config means push is unavailable", async () => {
  n.getPermissionsAsync.mockResolvedValueOnce({ granted: true, canAskAgain: true } as any);
  const { client, calls } = fakeLedger({});
  expect(await registerDevice(client)).toBe("unavailable");
  expect(calls).toHaveLength(0);
});

test("the app registers the phone once signed in", async () => {
  allowNotifications();
  const { client, calls } = fakeLedger({ "GET /groups": () => json(200, []), "POST /me/devices": () => json(204) });
  await renderApp({ "(app)/groups/index": GroupsIndex }, client, "/groups");
  await waitFor(() => expect(calls.some((c) => c.path === "/me/devices")).toBe(true));
});

test("sign-out forgets the device", async () => {
  allowNotifications("fcm-2");
  const { client, calls } = fakeLedger({
    "GET /groups": () => json(200, []),
    "POST /me/devices": () => json(204),
    "POST /me/devices/forget": () => json(204),
  });
  const { store } = await renderApp({ "(app)/groups/index": GroupsIndex }, client, "/groups");
  await fireEvent.press(await screen.findByText("Sign out"));

  await waitFor(() => expect(store.data.has("kitty.tokens")).toBe(false));
  const forget = calls.find((c) => c.path === "/me/devices/forget");
  expect(forget?.body).toEqual({ token: "fcm-2" });
  expect(n.unregisterForNotificationsAsync).toHaveBeenCalled();
});

test("signing out offline, or with notifications switched off, still stops this phone's notifications", async () => {
  n.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false } as any); // revoked in Android settings
  n.getDevicePushTokenAsync.mockResolvedValue({ type: "android", data: "fcm-3" } as any);
  const { client, calls } = fakeLedger({
    "GET /groups": () => json(200, []),
    "POST /me/devices/forget": () => {
      throw new TypeError("Network request failed");
    },
  });
  const { store } = await renderApp({ "(app)/groups/index": GroupsIndex }, client, "/groups");
  await fireEvent.press(await screen.findByText("Sign out"));

  await waitFor(() => expect(store.data.has("kitty.tokens")).toBe(false));
  expect(calls.find((c) => c.path === "/me/devices/forget")?.body).toEqual({ token: "fcm-3" });
  // The token itself is deleted: pulse forgets it the next time a push to it fails.
  expect(n.unregisterForNotificationsAsync).toHaveBeenCalled();
});

test("tapping a notification opens its group", async () => {
  const { client } = fakeLedger({ "GET /groups": () => json(200, []) });
  const { app } = await renderApp(
    { "(app)/groups/index": GroupsIndex, "(app)/groups/[id]/index": () => <Text>Group home</Text> },
    client,
    "/groups",
  );
  await screen.findByText(/^No groups yet/);
  const listener = n.addNotificationResponseReceivedListener.mock.calls.at(-1)![0];

  await act(async () =>
    listener({ notification: { request: { identifier: "n1", content: { data: { link: "kitty://groups/g1" } } } } } as any),
  );

  await waitFor(() => expect(app.getPathname()).toBe("/groups/g1"));
});

test("the settings screen saves a switch", async () => {
  const { client, calls } = fakeLedger({
    "GET /me/notifications": () => json(200, settings),
    "PUT /me/notifications": () => json(204),
  });
  await renderApp({ "(app)/notifications": NotificationsScreen }, client, "/notifications");

  await fireEvent.press(await screen.findByLabelText("Someone adds you to an expense: email"));

  await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
  const { emailAvailable, ...write } = settings;
  expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ ...write, expenseEmail: true });
});

test("after a save the other switches can be used again", async () => {
  const { client, calls } = fakeLedger({
    "GET /me/notifications": () => json(200, settings),
    "PUT /me/notifications": () => json(204),
  });
  await renderApp({ "(app)/notifications": NotificationsScreen }, client, "/notifications");

  await fireEvent.press(await screen.findByLabelText("Someone adds you to an expense: email"));
  await waitFor(() =>
    expect(screen.getByLabelText("A payment with you is recorded: email").props.accessibilityState).toMatchObject({ disabled: false }),
  );
  await fireEvent.press(screen.getByLabelText("A payment with you is recorded: email"));

  await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));
  expect(calls.filter((c) => c.method === "PUT")[1]?.body).toMatchObject({ expenseEmail: true, paymentEmail: true });
});

test("email switches are off until the email address is verified", async () => {
  const { client } = fakeLedger({ "GET /me/notifications": () => json(200, { ...settings, emailAvailable: false }) });
  await renderApp({ "(app)/notifications": NotificationsScreen }, client, "/notifications");
  expect(await screen.findByText("Verify your email address to get email.")).toBeTruthy();
  expect(screen.getByLabelText("Someone adds you to an expense: email").props.accessibilityState).toMatchObject({ disabled: true });
});

// Last in the file: holding a save open across React's act() leaves the act queue unsettled for the tests after it.
test("switches wait while one is saving, so a tap is never silently undone", async () => {
  let finish!: () => void;
  const { client, calls } = fakeLedger({
    "GET /me/notifications": () => json(200, settings),
    "PUT /me/notifications": () => new Promise<Response>((resolve) => (finish = () => resolve(json(204)))),
  });
  await renderApp({ "(app)/notifications": NotificationsScreen }, client, "/notifications");

  const saving = fireEvent.press(await screen.findByLabelText("Someone adds you to an expense: email")); // held until finish()
  await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));

  expect(screen.getByLabelText("A payment with you is recorded: email").props.accessibilityState).toMatchObject({ disabled: true });
  finish();
  await saving;
});
