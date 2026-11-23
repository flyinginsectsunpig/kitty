"use client";

import { useEffect, useState } from "react";
import { applyScan, confirmScan, startScan } from "@/app/groups/[id]/table/scan-actions";
import { PHOTO_TYPES, SCAN_PRIVACY_NOTE, SLOW_SCAN_MS, scanStatusMessage, uploadReceipt, type TableSession } from "@kitty/core";

type Result = { session: TableSession | null; error: string | null };

/** The host photographs the receipt; the items fill in on every screen once it's read. */
export function ReceiptScan({
  session,
  groupId,
  busy,
  run,
}: {
  session: TableSession;
  groupId: string;
  busy: boolean;
  run: (action: () => Promise<Result>) => void;
}) {
  const scan = session.scan;
  const reading = scan?.status === "parsing";
  const [readingSince, setReadingSince] = useState<{ id: string; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Note when this scan started reading (as seen here), and tick until the "still reading" nudge is due.
  if (reading && readingSince?.id !== scan.id) setReadingSince({ id: scan.id, at: Date.now() });
  const waited = reading && readingSince ? now - readingSince.at : 0;
  useEffect(() => {
    if (!reading || waited >= SLOW_SCAN_MS) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [reading, waited]);

  function onPhoto(file: File | undefined) {
    if (!file) return;
    run(() =>
      uploadReceipt(
        { type: file.type, size: file.size, body: file },
        (contentType) => startScan(groupId, session.id, contentType),
        (scanId) => confirmScan(groupId, session.id, scanId),
      ),
    );
  }

  return (
    <div className="card space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Scan the receipt</h2>
          <p className="text-xs text-stone-500">Or type the items below.</p>
        </div>
        <label className={`btn-secondary shrink-0 ${busy || reading ? "pointer-events-none opacity-50" : "cursor-pointer"}`}>
          {scan ? "Scan again" : "Take a photo"}
          <input
            type="file"
            accept={PHOTO_TYPES.join(",")}
            capture="environment"
            className="sr-only"
            disabled={busy || reading}
            onChange={(e) => {
              onPhoto(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {scan && (
        <p role="status" className="text-sm text-stone-700 dark:text-stone-300">
          {scanStatusMessage(scan, waited, session.items.length, session.currency)}
        </p>
      )}
      {scan?.status === "parsed" && scan.suggestedItems && (
        <button type="button" className="btn-primary w-full" disabled={busy}
          onClick={() => run(() => applyScan(groupId, session.id, scan.id))}>
          Use the scanned items
        </button>
      )}
      <p className="text-xs text-stone-500">{SCAN_PRIVACY_NOTE}</p>
    </div>
  );
}
