import createClient, { type Client, type Middleware } from "openapi-fetch";
import type { components, paths } from "./schema";

export type { components, paths };
export type Schemas = components["schemas"];
export type GroupDto = Schemas["GroupDto"];
export type GroupSummaryDto = Schemas["GroupSummaryDto"];
export type MemberDto = Schemas["MemberDto"];
export type ExpenseDto = Schemas["ExpenseDto"];
export type ExpenseWriteDto = Schemas["ExpenseWriteDto"];
export type ExpensePageDto = Schemas["ExpensePageDto"];
export type BalancesDto = Schemas["BalancesDto"];
export type SettlementDto = Schemas["SettlementDto"];
export type ActivityDto = Schemas["ActivityDto"];
export type InvitePreviewDto = Schemas["InvitePreviewDto"];
export type LedgerClient = Client<paths>;

/** Problem-details error body from the ledger; `code` is stable and safe to switch on. */
export type LedgerProblem = { status?: number; title?: string; detail?: string; code?: string };

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * A typed ledger client. Every request carries the bearer token; every mutation carries an
 * Idempotency-Key — the caller's (e.g. one rendered into a form, so double-submits replay) or a fresh UUID.
 */
export function createLedgerClient(
  baseUrl: string,
  getToken: () => Promise<string>,
  fetchFn?: (request: Request) => Promise<Response>,
): LedgerClient {
  const client = createClient<paths>({ baseUrl, ...(fetchFn ? { fetch: fetchFn } : {}) });
  const auth: Middleware = {
    async onRequest({ request }) {
      request.headers.set("Authorization", `Bearer ${await getToken()}`);
      if (MUTATING.has(request.method) && !request.headers.has("Idempotency-Key"))
        request.headers.set("Idempotency-Key", crypto.randomUUID());
      return request;
    },
  };
  client.use(auth);
  return client;
}
