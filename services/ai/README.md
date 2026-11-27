# kitty-ai

Kitty's AI service:

- **Receipt scanning:** local OCR, PII redaction, structured extraction (Gemini / Ollama), over Kafka. See
  `docs/superpowers/plans/2026-11-20-kitty-phase2b-receipt-scanning.md`.
- **Plain-language entry (phase 4a):** `POST /parse` `{ text, groupId? }` turns one sentence into a draft expense or
  reminder; `POST /resolve` `{ parsed, groupId }` re-matches it to another group without the model. Both need the
  person's Keycloak access token (audience `kitty-ai`), read the ledger *as that person*, and write nothing. Only the
  sentence, today's date and a currency code reach the model; names are matched here. Limits: 30 parses and 120
  resolves per person per hour. Caddy serves them under `/ai/`. See
  `docs/superpowers/specs/2026-11-25-kitty-phase4a-plain-language-entry-design.md`.
- **Ask Kitty (phase 4b):** `POST /ask` `{ messages: [{ role: "person" | "kitty", text }], groupId? }` answers a
  question about the person's own money (`{ answer }`), or says `{ kind: "entry" }` when the latest message is
  something to add (the app then sends it to `/parse`). A tool-using agent with four read-only lookups (`list_groups`,
  `what_i_owe` → the ledger's `GET /me/owing`, `group_spending` → `GET /groups/{id}/spending`, `not_a_question`), run
  with the person's token: at most 4 lookups and 5 model calls a question. The ledger does the arithmetic; the model
  quotes it. The conversation and the lookup results (amounts, descriptions, names) reach the model; logs record only
  the lookups used, the number of model calls and the time. Limits: 15 questions per person per hour; at most 12
  messages, a person's 1–500 characters. See `docs/superpowers/specs/2026-11-25-kitty-phase4b-ask-kitty-design.md`.
- **Kitty in ChatGPT and Claude (MCP, phase 4d):** a Streamable HTTP MCP server at `/mcp` (Caddy: `/ai/mcp`).
  - **Sign-in.** Assistants register themselves with Keycloak and sign the person in. Their tokens carry audience
    `kitty-mcp`, never `kitty-ledger`. The service swaps each one at Keycloak (token exchange, as client `kitty-mcp`)
    for a short-lived ledger token for the same person. A call without a token gets 401 pointing at
    `/.well-known/oauth-protected-resource/mcp`.
  - **Read tools:** `list_groups`, `get_balances`, `group_spending`, `list_expenses` (the ledger's
    `GET /groups/{id}/expense-lines`).
  - **Draft tools:** `draft_expense`, `draft_payment`, `draft_reminder`. They save nothing: each stores a draft for
    24 hours and returns a summary and a `{web}/d/{id}` link, where the person checks the usual card and taps Save or
    Send. The apps open it with `GET /drafts/{id}` (their own `kitty-ai` token, owner only) and finish it with
    `DELETE /drafts/{id}`.
  - **Limits and logs:** 120 reads and 30 drafts per person per hour. Logs record the tool, the person and the time.
  - **Try it locally:** `claude mcp add --transport http kitty http://localhost:5085/mcp`. To check sign-in against
    the running stack, run `uv run python scripts/check_mcp_auth.py <users-file> <email>`.
  - See `docs/superpowers/specs/2026-11-27-kitty-phase4d-mcp-design.md`.

| Variable | | |
|---|---|---|
| `AI_GEMINI_API_KEY` / `AI_OLLAMA_URL` | | the model (Gemini first); neither: scans, sentences and questions say "unavailable" |
| `AI_AUTH_ISSUER` | (empty: entry off) | the Keycloak realm URL whose tokens `/parse` and `/ask` accept |
| `AI_AUTH_AUDIENCE` | `kitty-ai` | |
| `AI_LEDGER_URL` | | the ledger's internal address |
| `AI_MCP_PUBLIC_URL` | (empty: MCP off) | the address assistants use, e.g. `http://localhost:5085/mcp` or `https://{host}/ai/mcp` |
| `AI_MCP_AUDIENCE` | `kitty-mcp` | the audience MCP tokens carry, and the client that exchanges them |
| `AI_MCP_CLIENT_SECRET` | | that client's secret |
| `AI_WEB_URL` | | where draft links point, e.g. `http://localhost:3000` |
