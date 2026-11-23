import { describe, expect, test, vi } from "vitest";
import { MAX_PHOTO_BYTES, rowsAction, scanStatusMessage, uploadReceipt, type PhotoInput, type ScanView } from "../src/receipt-upload";
import { settle } from "../src/settle";

const photo = (type = "image/jpeg", size = 2048): PhotoInput => ({ type, size, body: new Blob([new Uint8Array(size)], { type }) });
const started = { scanId: "scan-1", uploadUrl: "https://kitty.example/blob/kitty/receipts/s/scan-1?sig=abc" };
const confirmed = { session: null, error: null };

describe("uploadReceipt", () => {
  test("rejects non-images and large files without uploading", async () => {
    const start = vi.fn(async () => started);
    const put = vi.fn();
    expect(await uploadReceipt(photo("application/pdf"), start, vi.fn(), put)).toEqual({ session: null, error: "upload_not_image" });
    expect(await uploadReceipt(photo("image/png", MAX_PHOTO_BYTES + 1), start, vi.fn(), put)).toEqual({ session: null, error: "upload_too_large" });
    expect(start).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  test("PUTs the photo body to the sas url with its content type, then confirms", async () => {
    const file = photo("image/webp");
    const start = vi.fn(async () => started);
    const confirm = vi.fn(async () => confirmed);
    const put = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 201 }));

    expect(await uploadReceipt(file, start, confirm, put)).toBe(confirmed);

    expect(start).toHaveBeenCalledWith("image/webp");
    const [url, init] = put.mock.calls[0]!;
    expect(url).toBe(started.uploadUrl);
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(file.body);
    expect(init.headers).toEqual({ "x-ms-blob-type": "BlockBlob", "Content-Type": "image/webp" });
    expect(confirm).toHaveBeenCalledWith("scan-1");
  });

  test("reports start error", async () => {
    const put = vi.fn();
    const result = await uploadReceipt(photo(), async () => ({ error: "session_locked" }), vi.fn(), put);
    expect(result).toEqual({ session: null, error: "session_locked" });
    expect(put).not.toHaveBeenCalled();
  });

  test("losing the connection at any step is reported, not thrown", async () => {
    const offline = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await uploadReceipt(photo(), offline, vi.fn(), vi.fn())).toEqual({ session: null, error: "upload_failed" });
    expect(await uploadReceipt(photo(), async () => started, vi.fn(), offline)).toEqual({ session: null, error: "upload_failed" });
    const putOk = async () => new Response(null, { status: 201 });
    expect(await uploadReceipt(photo(), async () => started, offline, putOk)).toEqual({ session: null, error: "upload_failed" });
  });

  test("a failed upload is reported and never confirmed", async () => {
    const confirm = vi.fn();
    const result = await uploadReceipt(photo(), async () => started, confirm, async () => new Response(null, { status: 403 }));
    expect(result).toEqual({ session: null, error: "upload_failed" });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("scanStatusMessage", () => {
  const scan = (status: string, more: Partial<ScanView> = {}): ScanView => ({
    id: "s", status, failureReason: null, suggestedItems: null, suggestedCharges: null, ...more,
  });

  test("reading, then a nudge after 20 seconds", () => {
    expect(scanStatusMessage(scan("parsing"), 5_000, 0, "ZAR")).toBe("Reading the receipt…");
    expect(scanStatusMessage(scan("parsing"), 20_000, 0, "ZAR")).toBe("Still reading — you can type the items meanwhile.");
  });

  test("read and added", () => {
    expect(scanStatusMessage(scan("parsed"), 0, 3, "ZAR")).toBe("Added 3 items from the receipt. Check them against the slip.");
  });

  test("read but offered, because items were already typed", () => {
    const offered = scan("parsed", {
      suggestedItems: [
        { id: "a", description: "Burger", quantity: 1, lineTotalMinor: 12000 },
        { id: "b", description: "Coke", quantity: 2, lineTotalMinor: 5000 },
      ],
      suggestedCharges: [{ id: "t", kind: "tip", amountMinor: 1700 }],
    });
    expect(scanStatusMessage(offered, 0, 1, "ZAR")).toMatch(/^Kitty read 2 items \(R\s?187,00\) — use them instead\?$/);
  });

  test.each([
    ["rate_limited", "Kitty is busy — try again in a minute, or type the items."],
    ["timed_out", "That took too long — type the items, or try again."],
    ["unreadable", "Couldn't read that photo — try a clearer one, or type the items."],
    ["no_items", "Couldn't find any items on that receipt — type them instead."],
    ["totals_mismatch", "The items didn't add up to the receipt's total — type them, or try a clearer photo."],
    ["model_unavailable", "Receipt reading isn't switched on here — type the items."],
    ["something_new", "Couldn't read it — type the items."],
  ])("failure %s", (reason, text) => {
    expect(scanStatusMessage(scan("failed", { failureReason: reason }), 0, 0, "ZAR")).toBe(text);
  });
});

describe("rowsAction (rows typed, items the rows were built from, items on the bill now)", () => {
  test("rows follow the bill when the host hasn't edited them", () => {
    expect(rowsAction("v1", "v1", "v2")).toBe("reset");
  });
  test("the host's unsaved edits are never replaced", () => {
    expect(rowsAction("edited", "v1", "v2")).toBe("keep");
  });
  test("after saving, the rows already match the bill", () => {
    expect(rowsAction("v2", "v1", "v2")).toBe("adopt");
  });
  test("nothing changed", () => {
    expect(rowsAction("v1", "v1", "v1")).toBe("keep");
  });
});

describe("settle", () => {
  test("an action that throws (the network dropped) becomes an error, so the screen never stays busy", async () => {
    const result = await settle(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(result).toEqual({ session: null, error: "network" });
  });
  test("results pass through", async () => {
    const ok = { session: null, error: "session_locked" };
    expect(await settle(async () => ok)).toBe(ok);
  });
});
