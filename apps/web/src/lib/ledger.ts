import "server-only";
import { createLedgerClient, type LedgerClient, type LedgerProblem } from "@kitty/api-client";
import { redirect } from "next/navigation";
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

/** Throws for errors a page cannot recover from (the error boundary shows them). */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.data !== undefined) return result.data;
  if (result.response.status === 404) throw new NotFoundError();
  throw new Error(`Ledger request failed (${result.response.status}): ${problemCode(result.error)}`);
}

export class NotFoundError extends Error {
  constructor() {
    super("Not found");
  }
}
