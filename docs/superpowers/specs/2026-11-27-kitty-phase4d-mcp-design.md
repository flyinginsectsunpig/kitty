# Kitty Phase 4d: Kitty in ChatGPT and Claude (MCP server)

Status: draft for approval · 2026-11-27 · Parent: `2026-11-15-kitty-design.md` (§5.1 MCP server, phase 4) · Builds on: `2026-11-25-kitty-phase4a-plain-language-entry-design.md`, `2026-11-25-kitty-phase4b-ask-kitty-design.md`, `2026-11-26-kitty-phase4c-cross-off-design.md`

## 1. Intent

Someone who already lives in ChatGPT or Claude (on their phone or computer) connects Kitty once, signs in with their Kitty account, and from then on uses Kitty from that chat: "who still owes me across my groups?", "summarise the Cape Town trip by category", "add the R450 dinner, split with Sam and Ana", "I paid Bob back for the Uber", "remind Bob about the coffee".

Kitty itself already does all of this in the app (4a, 4b, 4c), and the app stays the main way in. The MCP server is an extra door for people who don't want to switch apps. It is also one of the skills Kitty exists to show (parent design §1): connecting an app to AI assistants through the standard protocol, with a proper sign-in.

The direction is the reverse of Kitty's Gemini features. There Kitty calls a model; here someone else's assistant calls Kitty, and Kitty runs no model at all.

## 2. What people do (agreed)

| They say (in ChatGPT or Claude) | What happens |
|---|---|
| Add Kitty as a connector | The assistant registers itself with Kitty's sign-in, the person signs in with their Kitty account and approves access |
| "What do I owe, and to whom?" | The assistant reads the person's balances and open items and answers in its own words |
| "Summarise the trip's spending" | It reads the group's spending (totals, categories, who paid, biggest) and summarises |
| "Show me last week's expenses in Flat 4B" | It lists the expenses |
| "Add the R450 dinner, split with Sam and Ana" | It prepares an expense draft. The reply has a short summary and a link; the link opens Kitty's usual card, filled in. Nothing is saved until Save |
| "I paid Bob back for the Uber" | The same, with Kitty's payment card (4c): the Uber is ticked |
| "Remind Bob about the coffee" | The same, with Kitty's reminder card. Nothing is sent until Send |
| A name or group that doesn't fit | The tool says so ("no member called Sem in Flat 4B; members are …"), so the assistant can ask the person |

## 3. Goals, non-goals, anti-goals

**Goals**
- A remote MCP server (Streamable HTTP) that ChatGPT, Claude (claude.ai, desktop, mobile, Claude Code) and other MCP clients can connect to, with OAuth sign-in through Kitty's Keycloak.
- Read tools: groups and members; balances and open items, per group and across groups; a group's spending summary; an expense list with filters.
- Draft tools: an expense, a payment (crossing off), a reminder. Each returns a summary and a link to Kitty's card; the person confirms in Kitty (web or Android).
- Works now from Claude Code on the owner's PC against the local stack; ChatGPT and claude.ai follow once Kitty has a public address (Oracle VM, Phase 5 / interim deploy).

**Non-goals**
- Writing to the ledger from the MCP server. Every change is Saved or Sent by the person in Kitty.
- Running a model in Kitty for MCP calls. The assistant does the understanding; Kitty's tools take structured arguments.
- A drafts list in the app. A draft lives behind its link only (decided).
- Showing the card inside the chat (MCP Apps / widgets). Possible later; the link is the confirmation step.
- Editing or deleting expenses, groups, members or payments through MCP.
- Listing Kitty in the ChatGPT or Claude connector directories (that needs the public deploy and their review).

**Anti-goals**
- Any data from a group the person isn't in, through any tool (parent anti-goal).
- The assistant changing the ledger without the person's tap in Kitty (parent anti-goal 2).
- A token issued to an assistant that also works directly against the ledger.
- Amounts, names or descriptions in a draft link's address.

## 4. Approaches (decided: A)

- **A. An `/mcp` endpoint in the ai service (Python, official `mcp` SDK). Chosen.** It reuses the sign-in check, the ledger reader that acts as the person, Ask Kitty's lookups and 4a's name matching and draft building. Drafts go in a small table in the database the ai service already uses. Cost: the ai service grows, and it gains one dependency, `mcp` (approved by the owner). The ledger changes in one place only: filters on its expense list (§5.2).
- B. In the ledger (.NET, official C# SDK). Closest to the data, but the name matching and draft building are Python; the ledger would copy them or call the ai service anyway.
- C. A new service (TypeScript SDK). Cleanest separation, but a fourth service in the 12 GB budget, with the sign-in check and ledger client written again.

## 5. Design

### 5.1 Sign-in (OAuth through Keycloak)

The MCP authorization spec makes the MCP server an OAuth resource server and Keycloak the authorization server.

- The ai service publishes Protected Resource Metadata (RFC 9728) for `/mcp`, naming the Keycloak realm as its authorization server, and answers an unauthenticated `/mcp` call with 401 and a `WWW-Authenticate` header pointing to that metadata.
- Assistants register themselves with Keycloak by Dynamic Client Registration (ChatGPT requires it; Claude uses it). The realm allows anonymous registration under policies: allowed redirect URIs limited to the known assistant callbacks plus localhost (for Claude Code and testing), public clients with PKCE, and only the MCP scope. If Keycloak 26.6 supports Client ID Metadata Documents, the builder may enable them too.
- Tokens issued to these clients carry one audience: the MCP server (`kitty-mcp`), through a realm default client scope with an audience mapper. They do **not** carry `kitty-ledger`, so a token held by an assistant can't call the ledger directly.
- **No token passthrough** (MCP spec): the ai service doesn't forward the assistant's token to the ledger. It exchanges it at Keycloak (standard token exchange) for a short-lived ledger token for the same person, as a confidential client of its own (`kitty-ai-mcp`, secret from an AppHost parameter). The ledger keeps deciding what the person may see. Ask Kitty and `/parse` keep their current first-party tokens unchanged.
- The person sees Keycloak's normal sign-in and a consent screen naming the assistant.

### 5.2 Tools

All run as the person (through the exchanged ledger token). Arguments are structured: the assistant has already understood the sentence. Amounts are formatted by the ledger, as in Ask Kitty, so the assistant quotes them. Each tool has a short description that says what it does and when to use it. Read tools are marked read-only (MCP tool annotations).

| Tool | Arguments | Returns | Reuses |
|---|---|---|---|
| `list_groups` | none | groups: id, name, currency, members (name, whether they have an account) | ledger `/groups`, `/groups/{id}` |
| `get_balances` | optional group | totals per currency, per person and per group, settle-up plan, open items with what's left, recent payments | Ask's `what_i_owe` (`/me/owing`), group `/balances` |
| `group_spending` | group, optional from, to, category, text | totals, the person's share, by category, by payer, biggest and latest | Ask's `group_spending` |
| `list_expenses` | group, optional from, to, category, text, person, page | expenses newest first: date, description, amount, payer, the person's share; a next page marker | ledger expense list, extended (below) |
| `draft_expense` | group (name or id), description, amount, currency, payer, people, split (equal or amounts, with each amount), date, category | summary, link, any issues | 4a's group matching and `build_draft` |
| `draft_payment` | group, direction (I paid / they paid), the other person, items (as described), optional amount, date | summary, link, issues (e.g. two open Ubers: which one?) | 4c's payment drafting |
| `draft_reminder` | group, person, optional what for, optional amount | summary, link, issues | 4a's reminder drafting |

**The expense list needs a ledger change (my call).** Today `GET /groups/{id}/expenses` takes only `cursor` and `limit` and returns raw minor amounts. 4d extends it with optional `from`, `to`, `category`, `q` (description contains) and `member` filters, and adds each expense's formatted amount and the caller's share (formatted), the way `/spending` formats money. `member` means anyone involved: the payer or someone sharing the expense. The filtering happens in the ledger's query, not by paging everything into Python; the existing cursor paging stays. The apps keep calling it without filters, unchanged.

Draft tools map their arguments onto 4a's `ParsedSentence` (intent `expense`, `payment` or `reminder`) and run the same resolution `/parse` runs after the model, so every rule 4a and 4c check (unknown names, amounts that don't add up, a person not in the group, which open item) applies unchanged. Issues are returned as text the assistant can act on.

**When a draft tool returns a link (my call).** Whenever the group is known: the draft is stored and the link returned, with any issues listed beside it. The card in Kitty already handles those issues the way it does for a typed sentence (4a asks about names and amounts, 4c asks which of two open Ubers), so the person settles them with a tap. Only when the group can't be matched (unknown or ambiguous) is there no draft and no link: the tool returns the person's groups so the assistant can ask and call again. `ParsedSentence` and `/resolve` stay unchanged; tools don't take item ids.

Text that other members typed (descriptions, names) reaches the assistant's model. Tool results present it as data, never as instructions; whatever an assistant does with it, it can only read what the person can read and draft what the person must confirm.

### 5.3 Drafts and the link

- A draft is stored by the ai service: id (random, unguessable), the person's Keycloak `sub`, the group id, the `ParsedSentence`, created at. It expires after **24 hours**. It's deleted once the card is saved or sent.
- The link is `{web}/d/{id}`. It carries nothing else.
- The web page `/d/{id}` needs the person signed in. It asks the ai service `GET /drafts/{id}` with the person's normal token; the ai service returns the draft only to the same `sub`, and only if it hasn't expired. The page then gets a fresh card through 4a's `/resolve` (balances may have moved since the draft) and shows the same card `PlainEntry` shows, with Save or Send. Expired, used or someone else's: "This draft has expired or was already used. Ask again in your chat."
- Android: `/d/` joins the App Links that already open `/invite/` and `/t/` in the app, and the app shows the same card. Without the app, the link opens the web app.

### 5.4 Limits and logging

- Per-person rate limits on tool calls, like `/parse` and `/ask` (reads and drafts separately).
- Logs record the tool name, the person's `sub` and timing; never arguments, descriptions or results, as for `/parse` and `/ask`.

## 6. Constraints

- Free tiers only (parent §3). Kitty runs no model for MCP.
- One new dependency: the official `mcp` Python SDK (owner approved). No others without asking.
- Keycloak stays at 26.6 (the version compose runs). Realm changes go in `infra/keycloak/kitty-realm.json` so every fresh dev realm and the deployed realm get them; the deployed realm also needs them applied by hand (as with the `kitty-ai` audience mapper).
- Until the public deploy, the server is reachable only at `http://localhost:5085/mcp`; test with Claude Code (and the MCP Inspector).
- **The interim deploy is wired in this phase, ready for the VM (my call).** Caddy serves the ai service under `/ai/`, so the public MCP address is `https://{host}/ai/mcp`, and RFC 9728 puts its metadata at `https://{host}/.well-known/oauth-protected-resource/ai/mcp`: Caddy routes that path to the ai service too. The compose file gets the `kitty-ai-mcp` client secret, the realm's registration policy lists the ChatGPT and claude.ai callback addresses, and `deploy/compose/RUNBOOK.md` gets the steps for applying the realm changes by hand. The ai service is told its public address by setting, so the metadata names the right URL. All of this is checked locally against compose; the public check waits for the VM.
- The parent anti-goals hold for every tool: tests must show a person can't read or draft into a group they're not in, and can't open someone else's draft.

## 7. Left to the builder

- How the SDK is mounted in the FastAPI app (Streamable HTTP, stateless if the SDK allows).
- Exact tool names' descriptions and output shapes (text plus structured content), within §5.2.
- The drafts table's name and the cleanup of expired rows.
- Keycloak's exact DCR policy configuration, and whether CIMD is available in 26.6.
- Whether the token exchange result is cached for its lifetime.
- How the web and Android screens for `/d/{id}` are split into components, reusing 4a/4c's cards.
