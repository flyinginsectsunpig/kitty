import { createLedgerClient } from "@kitty/api-client";

export type Handler = (req: Request) => Response | Promise<Response>;

export const json = (status: number, body?: unknown) =>
  body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export type Call = { method: string; path: string; search: string; headers: Headers; body: any };

/**
 * The real ledger client over a fake network. Routes are "METHOD /path" (exact path); anything else is a 404.
 * A handler may throw to act like a dropped connection. Every request is recorded, with its JSON body.
 */
export function fakeLedger(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchFn = async (req: Request) => {
    const url = new URL(req.url);
    const text = req.method === "GET" ? "" : await req.clone().text();
    calls.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body: text ? JSON.parse(text) : undefined });
    const handler = routes[`${req.method} ${url.pathname}`];
    return handler ? handler(req) : json(404, { code: "not_found" });
  };
  return { client: createLedgerClient("http://ledger.test", async () => "test-token", fetchFn), calls };
}
