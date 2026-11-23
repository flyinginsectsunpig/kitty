import { formatMoney } from "@kitty/money";
import type { TableSession } from "./table-state";

export type ScanView = NonNullable<TableSession["scan"]>;
type Result = { session: TableSession | null; error: string | null };
type Started = { scanId: string; uploadUrl: string } | { error: string };
type Put = (url: string, init: RequestInit) => Promise<Response>;

/** A photo to upload, from any platform: a browser `File`, or a `Blob` read from a phone's photo. */
export type PhotoInput = { type: string; size: number; body: BodyInit };

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** What happens to a receipt photo, shown next to every scan button (web and app). */
export const SCAN_PRIVACY_NOTE =
  "Kitty reads the photo on its own server and removes card numbers, names and phone numbers. Only the remaining text " +
  "goes to Google's Gemini (free tier) to pick out the items, and Google may use it to improve its products. The photo " +
  "is deleted 90 days after the bill is closed.";

/** After this long, "reading" also suggests typing the items meanwhile. */
export const SLOW_SCAN_MS = 20_000;

/**
 * Uploads a receipt photo straight to blob storage: the ledger issues a short-lived write-only URL (start), the
 * browser PUTs the file there, and the ledger checks it and hands it to the ai service (confirm). Files that
 * can't be scanned are turned away before anything is sent.
 */
export async function uploadReceipt(
  photo: PhotoInput,
  start: (contentType: string) => Promise<Started>,
  confirm: (scanId: string) => Promise<Result>,
  put: Put = fetch,
): Promise<Result> {
  if (!PHOTO_TYPES.includes(photo.type)) return { session: null, error: "upload_not_image" };
  if (photo.size > MAX_PHOTO_BYTES) return { session: null, error: "upload_too_large" };

  // Phones at a table drop signal: any step that throws is an upload that didn't happen, not a crash.
  try {
    const started = await start(photo.type);
    if ("error" in started) return { session: null, error: started.error };

    const uploaded = await put(started.uploadUrl, {
      method: "PUT",
      headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": photo.type },
      body: photo.body,
    });
    if (!uploaded.ok) return { session: null, error: "upload_failed" };
    return await confirm(started.scanId);
  } catch {
    return { session: null, error: "upload_failed" };
  }
}

const FAILURES: Record<string, string> = {
  rate_limited: "Kitty is busy — try again in a minute, or type the items.",
  timed_out: "That took too long — type the items, or try again.",
  unreadable: "Couldn't read that photo — try a clearer one, or type the items.",
  no_items: "Couldn't find any items on that receipt — type them instead.",
  totals_mismatch: "The items didn't add up to the receipt's total — type them, or try a clearer photo.",
  model_unavailable: "Receipt reading isn't switched on here — type the items.",
};

/** One line for the host about the latest scan. */
export function scanStatusMessage(scan: ScanView, waitedMs: number, itemsOnBill: number, currency: string): string {
  switch (scan.status) {
    case "parsing":
      return waitedMs >= SLOW_SCAN_MS ? "Still reading — you can type the items meanwhile." : "Reading the receipt…";
    case "parsed": {
      if (!scan.suggestedItems) return `Added ${itemsOnBill} ${itemsOnBill === 1 ? "item" : "items"} from the receipt. Check them against the slip.`;
      const total =
        scan.suggestedItems.reduce((sum, i) => sum + i.lineTotalMinor, 0) + (scan.suggestedCharges ?? []).reduce((sum, c) => sum + c.amountMinor, 0);
      const n = scan.suggestedItems.length;
      return `Kitty read ${n} ${n === 1 ? "item" : "items"} (${formatMoney(total, currency)}) — use them instead?`;
    }
    default:
      return FAILURES[scan.failureReason ?? ""] ?? "Couldn't read it — type the items.";
  }
}

/**
 * Whether the host's item rows should follow the bill. Keys are any stable serialisation of the items:
 * the rows as typed, the bill items the rows were last built from, and the bill items now.
 * Unedited rows follow a changed bill (a scan filled it); edited rows are never replaced.
 */
export function rowsAction(rowsKey: string, baselineKey: string, itemsKey: string): "keep" | "reset" | "adopt" {
  if (itemsKey === baselineKey) return "keep";
  if (rowsKey === itemsKey) return "adopt";
  return rowsKey === baselineKey ? "reset" : "keep";
}
