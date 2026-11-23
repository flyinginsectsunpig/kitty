"use server";

import type { TableSessionDto } from "@kitty/api-client";
import { isUuid } from "@kitty/core";
import { getLedger, problemCode } from "@/lib/ledger";

// The host's receipt scans. The photo itself never passes through here: the browser uploads it straight to
// blob storage with the short-lived URL startScan returns. The ledger checks host and state on every call.

type Result = { session: TableSessionDto | null; error: string | null };

export async function startScan(groupId: string, sessionId: string, contentType: string): Promise<{ scanId: string; uploadUrl: string } | { error: string }> {
  if (!isUuid(groupId) || !isUuid(sessionId)) return { error: "not_found" };
  const { data, error } = await (await getLedger()).POST("/groups/{groupId}/table-sessions/{sessionId}/scans", {
    params: { path: { groupId, sessionId } },
    body: { id: crypto.randomUUID(), contentType },
  });
  return data ? { scanId: data.scanId, uploadUrl: data.uploadUrl } : { error: problemCode(error) };
}

export async function confirmScan(groupId: string, sessionId: string, scanId: string): Promise<Result> {
  if (!isUuid(groupId) || !isUuid(sessionId) || !isUuid(scanId)) return { session: null, error: "not_found" };
  const { data, error } = await (await getLedger()).POST("/groups/{groupId}/table-sessions/{sessionId}/scans/{scanId}/uploaded", {
    params: { path: { groupId, sessionId, scanId } },
  });
  return { session: data ?? null, error: error ? problemCode(error) : null };
}

/** Replaces the bill's items and charges with what the scan read (the host chose to). */
export async function applyScan(groupId: string, sessionId: string, scanId: string): Promise<Result> {
  if (!isUuid(groupId) || !isUuid(sessionId) || !isUuid(scanId)) return { session: null, error: "not_found" };
  const { data, error } = await (await getLedger()).POST("/groups/{groupId}/table-sessions/{sessionId}/scans/{scanId}/apply", {
    params: { path: { groupId, sessionId, scanId } },
  });
  return { session: data ?? null, error: error ? problemCode(error) : null };
}
