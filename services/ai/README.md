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

| Variable | | |
|---|---|---|
| `AI_GEMINI_API_KEY` / `AI_OLLAMA_URL` | | the model (Gemini first); neither: scans and sentences say "unavailable" |
| `AI_AUTH_ISSUER` | (empty: entry off) | the Keycloak realm URL whose tokens `/parse` accepts |
| `AI_AUTH_AUDIENCE` | `kitty-ai` | |
| `AI_LEDGER_URL` | | the ledger's internal address |
