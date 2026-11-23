import { fireEvent, screen, waitFor } from "expo-router/testing-library";
import * as ImagePicker from "expo-image-picker";
import GroupLayout from "../src/app/(app)/groups/[id]/_layout";
import TableScreen from "../src/app/(app)/groups/[id]/table/[sessionId]";
import { fakeLedger, json, type Handler } from "./support/fake-ledger";
import { connections } from "./support/fake-signalr";
import { G, groupRoutes, ME } from "./support/group";
import { base, bill, S } from "./support/table";
import { renderApp } from "./support/render-app";

jest.mock("@microsoft/signalr", () => require("./support/fake-signalr"));
jest.mock("react-native-qrcode-svg", () => () => null);
jest.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));
jest.mock("../src/lib/photo", () => ({
  preparePhoto: jest.fn(async () => ({ type: "image/jpeg", size: 4, body: "jpeg-bytes" })),
}));

const picker = ImagePicker as jest.Mocked<typeof ImagePicker>;
const SCAN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const routes = { "(app)/groups/[id]/_layout": GroupLayout, "(app)/groups/[id]/table/[sessionId]": TableScreen };
const hosted = (over: Parameters<typeof bill>[1] = {}) => bill(1, { payerMemberId: ME, payerDisplayName: "Zee", items: [], ...over });
const asset = { assets: [{ uri: "file:///r.jpg", width: 3000, height: 4000 }], canceled: false };
const puts: { url: string; init: RequestInit }[] = [];

function scanLedger(initial: ReturnType<typeof bill>, extra: Record<string, Handler> = {}) {
  return fakeLedger(
    groupRoutes({
      [`GET /groups/${G}/table-sessions`]: () => json(200, [{ id: S, title: "Friday dinner", status: "open", hostedByMe: true }]),
      [`GET ${base}`]: () => json(200, initial),
      [`GET ${base}/listen-token`]: () => json(200, { token: "listen-1", expiresAt: "2026-11-23T23:00:00Z" }),
      ...extra,
    }),
  );
}

beforeEach(() => {
  connections.splice(0);
  puts.length = 0;
  jest.clearAllMocks();
  picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true } as never);
  globalThis.fetch = jest.fn(async (url: string, init: RequestInit) => (puts.push({ url, init }), new Response(null, { status: 201 }))) as never;
});

async function open(l: ReturnType<typeof scanLedger>) {
  await renderApp(routes, l.client, `/groups/${G}/table/${S}`);
  expect(await screen.findByText("Scan the receipt")).toBeTruthy();
}

test("taking a photo uploads it straight to storage and shows it being read", async () => {
  picker.launchCameraAsync.mockResolvedValue(asset as never);
  const l = scanLedger(hosted(), {
    [`POST ${base}/scans`]: () => json(201, { scanId: SCAN, uploadUrl: "http://localhost:10000/kitty/receipts/x?sig=1", expiresAt: "2026-11-23T23:00:00Z", maxBytes: 10485760 }),
    [`POST ${base}/scans/${SCAN}/uploaded`]: () => json(200, hosted({ version: 2, scan: { id: SCAN, status: "parsing", failureReason: null, suggestedItems: null, suggestedCharges: null } })),
  });
  await open(l);
  await fireEvent.press(screen.getByText("Take photo"));
  expect(await screen.findByText("Reading the receipt…")).toBeTruthy();
  expect(l.calls.find((c) => c.path === `${base}/scans`)!.body).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), contentType: "image/jpeg" });
  expect(puts).toHaveLength(1);
  expect(puts[0]!.url).toBe("http://localhost:10000/kitty/receipts/x?sig=1");
  expect(puts[0]!.init).toMatchObject({ method: "PUT", body: "jpeg-bytes", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": "image/jpeg" } });
});

test("a cancelled picker sends nothing", async () => {
  picker.launchCameraAsync.mockResolvedValue({ canceled: true, assets: null } as never);
  const l = scanLedger(hosted());
  await open(l);
  await fireEvent.press(screen.getByText("Take photo"));
  await waitFor(() => expect(picker.launchCameraAsync).toHaveBeenCalled());
  expect(l.calls.filter((c) => c.path.includes("/scans"))).toHaveLength(0);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("denied camera permission shows the settings hint and keeps Choose photo", async () => {
  picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: false } as never);
  picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null } as never);
  const l = scanLedger(hosted());
  await open(l);
  await fireEvent.press(screen.getByText("Take photo"));
  expect(await screen.findByText("Allow camera access in Settings, or choose a photo instead.")).toBeTruthy();
  expect(picker.launchCameraAsync).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText("Choose photo"));
  expect(picker.launchImageLibraryAsync).toHaveBeenCalled();
});

test("parsed scan with a suggestion offers Use them and applies it", async () => {
  const suggestion = { id: SCAN, status: "parsed", failureReason: null, suggestedItems: [{ id: "s1", description: "Steak", quantity: 1, lineTotalMinor: 25000 }], suggestedCharges: [] };
  const l = scanLedger(hosted({ items: bill(1).items, scan: suggestion }), {
    [`POST ${base}/scans/${SCAN}/apply`]: () => json(200, hosted({ version: 2, items: [{ id: "n1", description: "Steak", quantity: 1, lineTotalMinor: 25000, claimants: [] }], scan: suggestion })),
  });
  await open(l);
  expect(screen.getByText(/^Kitty read 1 item \(R\s250,00\) — use them instead\?$/)).toBeTruthy();
  await fireEvent.press(screen.getByText("Use the scanned items"));
  expect(await screen.findByDisplayValue("Steak")).toBeTruthy();
  expect(l.calls.some((c) => c.method === "POST" && c.path === `${base}/scans/${SCAN}/apply`)).toBe(true);
});

test("an upload that fails says so", async () => {
  picker.launchCameraAsync.mockResolvedValue(asset as never);
  globalThis.fetch = jest.fn(async () => {
    throw new TypeError("Network request failed");
  }) as never;
  const l = scanLedger(hosted(), {
    [`POST ${base}/scans`]: () => json(201, { scanId: SCAN, uploadUrl: "http://localhost:10000/x", expiresAt: "2026-11-23T23:00:00Z", maxBytes: 10485760 }),
  });
  await open(l);
  await fireEvent.press(screen.getByText("Take photo"));
  expect(await screen.findByText("The photo couldn't be uploaded. Check your connection and try again.")).toBeTruthy();
});
