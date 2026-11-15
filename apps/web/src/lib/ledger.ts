import "server-only";
import { createLedgerClient, type LedgerClient, type LedgerProblem } from "@kitty/api-client";
import { notFound, redirect } from "next/navigation";
import { getAccessToken } from "@/auth/token";

/** A ledger client for the signed-in user; sends them to sign in when there is no valid session. */
export async function getLedger(): Promise<LedgerClient> {
  const baseUrl = process.env.LEDGER_URL;
  if (!baseUrl) throw new Error("LEDGER_URL must be set.");
  const token = await getAccessToken();
  if (!token) redirect("/");
  return createLedgerClient(baseUrl, async () => token);
}

/** The ledger's stable error code from a failed call, e.g. "split_sum_mismatch". */
export function problemCode(error: unknown): string {
  return (error as LedgerProblem | undefined)?.code ?? "unexpected";
}

/** Returns the data, renders the 404 page for not_found, and throws for anything else (error boundary). */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.data !== undefined) return result.data;
  if (result.response.status === 404) notFound();
  throw new Error(`Ledger request failed (${result.response.status}): ${problemCode(result.error)}`);
}
