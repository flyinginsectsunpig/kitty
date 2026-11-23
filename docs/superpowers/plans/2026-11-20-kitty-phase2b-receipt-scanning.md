# Kitty Phase 2b — Receipt Scanning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At the table, the host photographs the receipt; within seconds the bill's items and tip appear in the open table session (or, if the host already typed items, as a suggestion they can accept), and nothing about the card, cashier or phone numbers ever leaves our server.

**Architecture:** The ledger issues a short-lived write-only SAS URL; the browser uploads the photo straight to blob storage (Azurite locally and on the VM, Azure Blob optional). Confirming the upload writes a `ReceiptUploaded` event to a **transactional outbox** in the same DB transaction; a relay publishes outbox rows to **Kafka (Redpanda)** as **Protobuf** registered in Redpanda's schema registry. A new **Python `ai` service** consumes the event, runs OCR locally, redacts PII from the text, asks an LLM (Gemini free tier; Ollama locally) for a schema-validated receipt, checks the arithmetic, and publishes a `ReceiptResult`. The ledger consumes results (deduped through an inbox table), fills or suggests items on the session, and the existing SignalR hub pushes the change to every screen. Expense changes also go through the outbox (`ledger.events`) so phase 4 can consume them.

**Tech Stack:** New, each pinned to the latest stable release that is at least two weeks old when the task starts. .NET: `Confluent.Kafka`, `Confluent.SchemaRegistry.Serdes.Protobuf`, `Google.Protobuf` + `Grpc.Tools` (codegen only), `Azure.Storage.Blobs`, `Testcontainers.Redpanda`, `Testcontainers.Azurite`, `Aspire.Hosting.Azure.Storage`, `Aspire.Hosting.Python`. Python 3.13 via `uv`: `fastapi`, `uvicorn`, `confluent-kafka[protobuf,schemaregistry]`, `protobuf`, `grpcio-tools` (dev, codegen), `azure-storage-blob`, `rapidocr` + `onnxruntime`, `google-genai`, `httpx` (Ollama), `pydantic`, `psycopg[binary]`, `pytest`, `testcontainers[redpanda,azurite]`, `ruff`, `pillow` (dev, test images). Containers: `redpandadata/redpanda`, `mcr.microsoft.com/azure-storage/azurite`.

**Spec:** `docs/superpowers/specs/2026-11-15-kitty-design.md`. See §5.1 (outbox, ai receipt parsing, evals), §5.2 (topics, Protobuf, blob, 90-day deletion) and §6 item 5 (receipt scan → draft). Earlier plans: `docs/superpowers/plans/2026-11-15-kitty-phase1-core-ledger.md` and `docs/superpowers/plans/2026-11-15-kitty-phase2a-table-mode.md`. Their Global Constraints still apply.

## Global Constraints

- Everything in the phase 1 and 2a Global Constraints applies: integer minor units, member order, idempotency on every mutation, 404 for non-members, host-only table actions, and VAT never as an additive charge in South Africa.
- **Privacy (spec §5.1, owner decision):**
  - The image never leaves our infrastructure. OCR runs inside the `ai` service.
  - Only **redacted text** goes to the LLM. Redaction covers card numbers (13–19 digits passing Luhn, with spaces or dashes), masked cards (`**** 1234`, `XXXX1234`), phone numbers, and the names that follow cashier/server/waiter/operator/card-holder labels.
  - Copy shown next to the scan button: *"Kitty reads the photo on its own server and removes card numbers, names and phone numbers. Only the remaining text goes to Google's Gemini (free tier) to pick out the items, and Google may use it to improve its products. The photo is deleted 90 days after the bill is closed."*
- **Receipt text is untrusted input.** The model gets it as data and has no tools, and its output is validated against the schema.
- **Arithmetic check (spec):** items + charges must equal the printed total within 1%. Tax is added as an `other` charge only when that is needed to reach the total (non-VAT-inclusive receipts). Otherwise the result is `failed` with reason `totals_mismatch`.
- **Never overwrite typed items (spec):** a result applies automatically only if the session is `open` and has **no items**. Otherwise it is stored as a suggestion, which the host can apply on purpose.
- **Delivery:** at-least-once. Every consumer dedupes by `event_id`. Topics are `ledger.events` (keyed by group id), `receipt.uploaded` (keyed by session id), `receipt.uploaded.retry`, and `receipt.parsed` (keyed by session id, carries `ReceiptResult`). Subjects use the `<topic>-value` naming.
- **Uploads:**
  - JPEG, PNG or WebP only, checked by magic bytes, and at most 10 MB (10 485 760 bytes).
  - The SAS is write-only and valid for 10 minutes. The container is private.
  - One active scan per session. A new scan replaces the previous one, whose blob is deleted.
- **Rate limits:** a Gemini 429 goes to `receipt.uploaded.retry`, retried after 30 s, 1 min, 2 min and 5 min. After that the result is `failed: rate_limited`. A scan still `parsing` after 10 minutes is marked `failed: timed_out`. The web app offers manual entry the moment a scan fails, and after 20 s of waiting.
- **Memory (spec §7):** the 12 GB VM budget must hold. Redpanda runs with `--smp 1 --memory 1G`, and the ai service is limited to 1.5 GB.

## Review Focus

1. **Gemini is rate-limited or down during dinner.** The host is never stuck on "Reading…". They see "Couldn't read it — type the items" within 20 s (web), and the scan reaches a final state (`rate_limited` or `timed_out`). Tests: Task 8 `Rate_limited_scan_ends_failed_after_retries` and Task 5 `Parsing_scan_times_out_after_10_minutes`.
2. **The same Kafka message is delivered twice.** Items are applied once: no duplicate items and no second version bump. Test: Task 4 `Duplicate_result_is_applied_once`.
3. **A card number or phone number is printed on the receipt.** It never reaches the LLM. Test: Task 8 `Extractor_never_sees_card_or_phone` (captures the text the fake extractor receives).
4. **A non-image, a 30 MB photo, or a scan for someone else's session.** It is rejected, its blob is deleted, and nothing is published. Tests: Task 3 `Upload_that_is_not_an_image_is_rejected_and_deleted`, `Oversized_upload_is_rejected`, `Only_the_host_can_scan`.
5. **The host typed items before the scan finished.** The typed items stay and the scan becomes a suggestion. Test: Task 4 `Result_never_overwrites_typed_items`.

---

## File Structure

```
contracts/proto/kitty/events/v1/{ledger_events,receipts}.proto
contracts/fixtures/receipt_result_parsed.bin           (golden bytes, written by Python, read by C#)
services/ledger/src/Kitty.Ledger/
  Infrastructure/Messaging/  Outbox.cs OutboxRelay.cs KafkaOptions.cs Topics.cs InboxConsumer.cs
  Infrastructure/Blob/       ReceiptBlobs.cs (SAS issue, inspect, delete, CORS setup)
  Data/Entities/             OutboxMessage.cs InboxMessage.cs ReceiptScan.cs
  Features/Scans/            ScanEndpoints.cs ScanResultHandler.cs ScanCleanup.cs ScanDtos.cs
services/ai/                 (uv project, Python 3.13)
  pyproject.toml uv.lock Dockerfile
  src/kitty_ai/  main.py settings.py currencies.py
    contracts/              (generated *_pb2.py, committed)
    receipts/  redact.py validate.py schema.py ocr.py extract.py pipeline.py worker.py
  tests/  test_redact.py test_validate.py test_extract.py test_ocr.py test_worker.py test_contracts.py
  evals/  run_receipts.py fetch_cord.py README.md
apps/web/src/  components/table/ReceiptScan.tsx  lib/receipt-upload.ts  app/groups/[id]/table/scan-actions.ts
aspire/Kitty.AppHost/AppHost.cs   deploy/compose/{docker-compose.yml,Caddyfile,smoke.sh,RUNBOOK.md}
.github/workflows/{ai.yml,evals.yml}
```

---

### Task 1: Event contracts (Protobuf, both languages)

**Files:** Create `contracts/proto/kitty/events/v1/receipts.proto`, `ledger_events.proto`, `contracts/fixtures/receipt_result_parsed.bin`, `services/ai/src/kitty_ai/contracts/` (generated), `services/ai/tests/test_contracts.py`, `services/ledger/tests/Kitty.Ledger.Tests/ContractTests.cs`. Modify the ledger csproj (`<Protobuf Include="../../../../contracts/proto/**/*.proto" GrpcServices="None" />`). Scaffold `services/ai` here: a `uv init` package with Python 3.13, `ruff` and `pytest`, plus a `scripts/gen_contracts.py` that runs `grpc_tools.protoc` into `src/kitty_ai/contracts`.

**Interfaces — Produces** (package `kitty.events.v1`, C# namespace `Kitty.Contracts.Events.V1`):
- `ReceiptUploaded { string event_id=1; google.protobuf.Timestamp occurred_at=2; string scan_id=3; string session_id=4; string group_id=5; string blob_name=6; string currency=7; string content_type=8; int32 attempt=9; }`
- `ReceiptResult { string event_id=1; Timestamp occurred_at=2; string scan_id=3; string session_id=4; oneof outcome { ParsedReceipt parsed=5; ScanFailure failed=6; } }`
- `ParsedReceipt { string merchant=1; string receipt_date=2 /* yyyy-mm-dd or "" */; string currency=3; repeated ParsedItem items=4; repeated ParsedCharge charges=5; int64 total_minor=6; }`
- `ParsedItem { string description=1; int32 quantity=2; int64 line_total_minor=3; }`
- `ParsedCharge { string kind=1 /* tip|service|delivery|other */; int64 amount_minor=2; }`
- `ScanFailure { Reason reason=1; enum Reason { REASON_UNSPECIFIED=0; UNREADABLE=1; NO_ITEMS=2; TOTALS_MISMATCH=3; RATE_LIMITED=4; MODEL_UNAVAILABLE=5; } }`
- `ExpenseChanged { string event_id=1; Timestamp occurred_at=2; string group_id=3; string expense_id=4; Change change=5; enum Change { CHANGE_UNSPECIFIED=0; CREATED=1; UPDATED=2; DELETED=3; } }`

- [ ] **Step 1:** Write `test_contracts.py::test_golden_parsed_result`. It builds a `ReceiptResult` (scan_id `"7b0c…"`, items `[("Burger",1,12000),("Coke",2,5000)]`, charge `("tip",1700)`, total `18700`, currency `"ZAR"`) and asserts it serializes to exactly `contracts/fixtures/receipt_result_parsed.bin`. The test writes the file if it is missing and `KITTY_UPDATE_FIXTURES=1` is set. Also write `ContractTests.Golden_parsed_result_reads_in_csharp`, which parses the same file and asserts the same values.
- [ ] **Step 2:** Run both and confirm they fail (no generated types).
- [ ] **Step 3:** Write the two `.proto` files, generate the Python code (committed) and the C# code (build-time), and write the fixture once with `KITTY_UPDATE_FIXTURES=1`.
- [ ] **Step 4:** `cd services/ai && uv run pytest tests/test_contracts.py` and `dotnet test --solution Kitty.slnx --filter-class "*ContractTests"` → PASS.
- [ ] **Step 5:** Commit `feat(contracts): protobuf receipt and ledger events, shared by C# and Python`.

### Task 2: Transactional outbox and relay to Kafka

**Files:** Create `Data/Entities/OutboxMessage.cs`, `Infrastructure/Messaging/{Outbox.cs,OutboxRelay.cs,KafkaOptions.cs,Topics.cs}`, a migration `*_Outbox`, `tests/.../OutboxTests.cs`, and `tests/.../KafkaFixture.cs` (Testcontainers Redpanda, shared collection). Modify the expense create/update/delete handlers to call `Outbox.Add`, and `Program.cs` (register when `ConnectionStrings:kafka` is set; otherwise rows just accumulate, and a warning is logged once).

**Interfaces — Produces:**
- `OutboxMessage { Guid Id; string Topic; string Key; string Type; byte[] Payload; DateTimeOffset OccurredAt; DateTimeOffset? SentAt; int Attempts; }` (index on `SentAt IS NULL, OccurredAt`).
- `sealed class Outbox(LedgerDbContext db) { void Add<T>(string topic, string key, T message) where T : IMessage<T>; }` adds the row to the change tracker. It is saved by the caller's `SaveChanges`, so it lands in the same transaction.
- `Topics.LedgerEvents = "ledger.events"`, `ReceiptUploaded = "receipt.uploaded"`, `ReceiptUploadedRetry = "receipt.uploaded.retry"`, `ReceiptParsed = "receipt.parsed"`. `Topics.EnsureAsync(IAdminClient)` creates them (3 partitions, replication 1) if they are missing.
- `OutboxRelay : BackgroundService`: every 500 ms (or when woken), it claims up to 100 unsent rows ordered by `OccurredAt` using `SELECT … FOR UPDATE SKIP LOCKED`. It produces with an idempotent producer (`acks=all`, `enable.idempotence=true`), serializing with the Protobuf serializer and the schema registry. Then it sets `SentAt`. On failure it increments `Attempts` and leaves the row, and it never drops one.

- [ ] **Step 1:** Write the tests. `Expense_create_publishes_ExpenseChanged`: create an expense and consume `ledger.events` within 10 s, expecting `change=CREATED`, `group_id`, `expense_id`, message key = group id, and the outbox row's `SentAt` set. `Failed_write_leaves_no_outbox_row`: an expense request rejected by validation leaves no row. `Events_for_one_group_keep_their_order`: create, update and delete, and they are consumed in that order.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement the code above.
- [ ] **Step 4:** Run `OutboxTests` and the full ledger suite → PASS.
- [ ] **Step 5:** Commit `feat(ledger): transactional outbox relayed to Kafka`.

### Task 3: Receipt scans — SAS upload and confirmation

**Files:** Create `Data/Entities/ReceiptScan.cs` (+ migration), `Infrastructure/Blob/ReceiptBlobs.cs`, `Features/Scans/{ScanEndpoints.cs,ScanDtos.cs}`, `tests/.../ScanTests.cs`, and `AzuriteFixture.cs`. Modify `TableSessionDto` (+`Scan`), `TableEndpoints.MapTableSessions` (map scan routes), `Program.cs`, and the OpenAPI document and TS client.

**Interfaces — Produces:**
- `ReceiptScan { Guid Id; Guid SessionId; string BlobName /* "{sessionId}/{scanId}" */; string ContentType; string Status /* awaiting_upload|parsing|parsed|failed */; string? FailureReason; string? SuggestionJson; DateTimeOffset CreatedAt; DateTimeOffset? UploadedAt; DateTimeOffset? FinishedAt; DateTimeOffset? BlobDeletedAt; }`
- `ReceiptBlobs`:
  - `(Uri UploadUrl, DateTimeOffset ExpiresAt) IssueUpload(string blobName, string contentType)`. The URL is rewritten onto `Blob:PublicUrl` when that is set.
  - `Task<BlobCheck> InspectAsync(string blobName, CancellationToken)`, which returns the size, content type and first 16 bytes.
  - `Task DeleteAsync(string blobName, CancellationToken)`.
  - `Task ConfigureCorsAsync(IEnumerable<string> origins)` runs at startup when `Blob:ConfigureCors=true`.
  - The container is `receipts`.
- `POST /groups/{g}/table-sessions/{s}/scans` takes `{ id, contentType }` and returns 201 `{ scanId, uploadUrl, expiresAt, maxBytes: 10485760 }`. It is host-only and requires the session to be open.
- `POST /groups/{g}/table-sessions/{s}/scans/{scanId}/uploaded` returns 200 `TableSessionDto`. It checks the blob exists, the size is ≤ max, and the magic bytes are JPEG `FF D8 FF`, PNG `89 50 4E 47` or WebP `RIFF....WEBP`. It marks the scan `parsing` and adds a `ReceiptUploaded` outbox row. All of this happens in one transaction with a version bump and a hub notify. Any earlier scan's blob is deleted.
- `TableScanDto(Guid Id, string Status, string? FailureReason, IReadOnlyList<ItemWriteDto>? SuggestedItems, IReadOnlyList<ChargeWriteDto>? SuggestedCharges)` is placed on `TableSessionDto.Scan` (null if there is none).
- New `ErrorCodes`: `upload_missing`, `upload_too_large`, `upload_not_image`.

- [ ] **Step 1:** Write the tests:
  - `Host_gets_upload_url_and_confirms_scan`: PUT a small JPEG to the returned URL with `x-ms-blob-type: BlockBlob`, confirm it, and expect the DTO `Scan.Status == "parsing"` and one `receipt.uploaded` outbox row carrying `blob_name`.
  - `Upload_that_is_not_an_image_is_rejected_and_deleted`: a text file → 400 `upload_not_image`, the blob is gone, and there is no outbox row.
  - `Oversized_upload_is_rejected`: 10 485 761 bytes → 400 `upload_too_large`.
  - `Confirm_without_upload_returns_upload_missing`.
  - `Only_the_host_can_scan`: another member gets 403 `host_only`, and a stranger gets 404.
  - `Scan_on_locked_session_returns_409`.
  - `New_scan_replaces_the_old_one_and_deletes_its_blob`.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement the code above, using `BlobSasBuilder` with `Create | Write`, a 10-minute expiry, and the account key from the connection string.
- [ ] **Step 4:** Run `ScanTests` and the full suite. Set `KITTY_UPDATE_OPENAPI=1` once, then run `corepack pnpm --filter @kitty/api-client generate` → PASS.
- [ ] **Step 5:** Commit `feat(ledger): receipt scans upload straight to blob storage with a short-lived SAS`.

### Task 4: Ledger applies scan results

**Files:** Create `Data/Entities/InboxMessage.cs` (+ migration), `Infrastructure/Messaging/InboxConsumer.cs`, `Features/Scans/ScanResultHandler.cs`, and `tests/.../ScanResultTests.cs`. Modify `ScanEndpoints` (+apply).

**Interfaces:**
- Consumes: `ReceiptResult` (Task 1), `ReceiptScan` and `ReceiptBlobs` (Task 3), `TableSessionService.NotifyAsync`.
- Produces:
  - `InboxMessage { string EventId PK; string Topic; DateTimeOffset ProcessedAt; }`.
  - `ScanResultHandler.ApplyAsync(ReceiptResult, CancellationToken)` runs in one transaction. It inserts the inbox row first, and on a duplicate it returns without doing anything. If the scan is not `parsing`, it ignores the result (a late result for a replaced scan). For `failed`, it sets the scan to `failed` with the reason as a snake_case string. For `parsed`, it sets the scan to `parsed` and `SuggestionJson`. If the session is open and has zero items, it also writes those items and charges to the session. It bumps the version and notifies.
  - `InboxConsumer : BackgroundService` reads `receipt.parsed` in group `ledger-scans` and commits the offset after `ApplyAsync` succeeds.
  - `POST /groups/{g}/table-sessions/{s}/scans/{scanId}/apply` (host, open) replaces the session's items and charges with the suggestion and returns `TableSessionDto`.

- [ ] **Step 1:** Write the tests. Each one publishes a `ReceiptResult` to Redpanda and waits up to 10 s for the session DTO.
  - `Parsed_result_fills_an_empty_session`: the items and the tip charge match, and `Scan.Status == "parsed"`.
  - `Result_never_overwrites_typed_items`: the session has 1 typed item, so after the result the items are unchanged and `Scan.SuggestedItems` has 2.
  - `Duplicate_result_is_applied_once`: publish the same event twice, and there are 2 items and exactly one version bump.
  - `Failed_result_sets_reason`: `RATE_LIMITED` → `Scan.FailureReason == "rate_limited"`.
  - `Host_applies_suggestion`: after apply, the items equal the suggestion. A non-host gets 403.
  - `Result_for_a_replaced_scan_is_ignored`.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement the code above.
- [ ] **Step 4:** Run `ScanResultTests` and the full suite → PASS.
- [ ] **Step 5:** Commit `feat(ledger): apply receipt scan results, deduped, never over typed items`.

### Task 5: Scan housekeeping (90-day deletion, stuck scans)

**Files:** Create `Features/Scans/ScanCleanup.cs` (a `BackgroundService` that runs hourly and takes `TimeProvider`) and `tests/.../ScanCleanupTests.cs` (`FakeTimeProvider`, calling `ScanCleanup.RunOnceAsync`).

**Interfaces — Produces:** `Task<CleanupReport> RunOnceAsync(CancellationToken)`, which returns `(int TimedOut, int StaleUploadsDeleted, int ExpiredBlobsDeleted)`. A scan in `parsing` for more than 10 min becomes `failed: timed_out`, with a notify. An `awaiting_upload` scan older than 24 h gets its blob deleted and the row removed. A scan whose session was confirmed or cancelled more than 90 days ago gets its blob deleted and `BlobDeletedAt` set.

- [ ] **Step 1:** Write the tests. `Parsing_scan_times_out_after_10_minutes` (9 min → untouched; 11 min → `timed_out`). `Blob_is_deleted_90_days_after_the_bill_closes` (89 days → kept; 91 → deleted, `BlobDeletedAt` set). `Abandoned_upload_is_removed_after_a_day`.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement the code above.
- [ ] **Step 4:** Run the tests → PASS.
- [ ] **Step 5:** Commit `feat(ledger): delete receipt photos 90 days after the bill closes; time out stuck scans`.

### Task 6: ai — redaction and arithmetic (pure functions)

**Files:** Create `src/kitty_ai/receipts/{redact.py,validate.py,schema.py}`, `src/kitty_ai/currencies.py` (reads `contracts/currencies.json`, which is copied into the image), `tests/test_redact.py`, and `tests/test_validate.py`.

**Interfaces — Produces:**
- `redact(text: str) -> str` replaces each match with `[card]`, `[phone]` or `[name]`.
- `schema.py` (Pydantic, decimal strings as printed):
  - `ExtractedItem(description: str, quantity: int = 1, line_total: str)`
  - `ExtractedReceipt(merchant: str = "", date: str = "", currency: str = "ZAR", items: list[ExtractedItem], tip: str | None, service_charge: str | None, delivery: str | None, tax: str | None, total: str)`
- `validate.to_parsed(receipt: ExtractedReceipt) -> ParsedReceipt | ScanFailure.Reason` converts to minor units using the currency's exponent, applies the 1% rule and the tax-only-if-needed rule, and returns `NO_ITEMS` for an empty item list.

- [ ] **Step 1:** Write the tests:
  - `test_card_numbers_are_redacted`: `"4111 1111 1111 1111"` and `"4111-1111-1111-1111"` → `[card]`. A 16-digit number that fails Luhn (a barcode) is kept.
  - `test_masked_cards`: `"**** 1234"` and `"XXXX1234"` → `[card]`.
  - `test_sa_phone_numbers`: `"+27 82 123 4567"`, `"082 123 4567"` and `"(021) 555-1234"` → `[phone]`.
  - `test_names_after_labels`: `"Cashier: Thandi M"` → `"Cashier: [name]"`, and likewise for `Waiter`, `Server`, `Operator` and `Card holder`.
  - `test_prices_and_dates_survive`: `"2 x Coke 50,00"` and `"2026-11-20"` are unchanged.
  - `test_totals_within_one_percent_pass` (items 170.00 + tip 17.00, total 187.00).
  - `test_off_by_more_than_one_percent_fails` → `TOTALS_MISMATCH`.
  - `test_vat_inclusive_tax_is_not_added` (SA receipt: items 100.00, VAT 13.04, total 100.00 → no `other` charge).
  - `test_additive_tax_becomes_other_charge` (items 100.00, tax 8.00, total 108.00 → `other` 800).
  - `test_comma_decimal_prices`: `"1 234,50"` → 123450.
  - `test_no_items_fails`.
- [ ] **Step 2:** `uv run pytest tests/test_redact.py tests/test_validate.py` → FAIL.
- [ ] **Step 3:** Implement the code above.
- [ ] **Step 4:** Run the tests and `uv run ruff check` → PASS.
- [ ] **Step 5:** Commit `feat(ai): redact receipt text and check its arithmetic`.

### Task 7: ai — OCR and model providers

**Files:** Create `src/kitty_ai/receipts/{ocr.py,extract.py}`, `src/kitty_ai/settings.py`, `tests/test_ocr.py`, and `tests/test_extract.py`.

**Interfaces — Produces:**
- `class Ocr(Protocol): def read(self, image: bytes) -> str`. `RapidOcr` implements it with PaddleOCR PP-OCRv5 ONNX models baked into the image. It returns lines joined top-to-bottom.
- `class Extractor(Protocol): def extract(self, text: str) -> ExtractedReceipt`. It raises `RateLimited` or `ModelUnavailable`.
  - `GeminiExtractor(api_key, model)` uses `google-genai` with `response_schema=ExtractedReceipt` and a system prompt. The prompt says the text is untrusted data and to extract only what is printed. It maps HTTP 429 to `RateLimited`.
  - `OllamaExtractor(base_url, model)` calls `/api/chat` with `format` set to the JSON schema.
  - `extractor_from(settings)` picks Gemini when `AI_GEMINI_API_KEY` is set, then Ollama when `AI_OLLAMA_URL` is set, and otherwise an extractor that always raises `ModelUnavailable`.
- `Settings` (pydantic-settings, `AI_` prefix):
  - `kafka_bootstrap`, `schema_registry_url`, `blob_connection_string`, `postgres_dsn`
  - `gemini_api_key`, `gemini_model` (default: the current free Flash model, checked against Google's models page when this task starts), `ollama_url`, `ollama_model`

- [ ] **Step 1:** Write the tests:
  - `test_rapidocr_reads_rendered_receipt`: render `"Burger 120,00\nTOTAL 120,00"` with Pillow, and the text contains `"Burger"` and `"120"`. Mark it `@pytest.mark.slow`.
  - `test_gemini_maps_429_to_rate_limited` and `test_gemini_parses_structured_response` use a fake `google-genai` client injected through the constructor.
  - `test_ollama_request_sends_schema` uses `httpx.MockTransport`.
  - `test_no_model_configured_raises_unavailable`.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement the code above. The Dockerfile downloads the OCR models at build time, so they are never fetched at runtime.
- [ ] **Step 4:** `uv run pytest` (including slow tests) → PASS.
- [ ] **Step 5:** Commit `feat(ai): local OCR and Gemini/Ollama receipt extraction`.

### Task 8: ai — the receipt worker

**Files:** Create `src/kitty_ai/receipts/{pipeline.py,worker.py}`, `src/kitty_ai/main.py` (FastAPI `/health`, with a lifespan that starts the worker thread), `tests/test_worker.py` (Testcontainers Redpanda + Azurite + Postgres), and the `ai` schema bootstrap (`CREATE SCHEMA IF NOT EXISTS ai; CREATE TABLE IF NOT EXISTS ai.processed_events(event_id text primary key, processed_at timestamptz default now())`).

**Interfaces:**
- Consumes: Tasks 1, 6 and 7.
- Produces:
  - `process(image: bytes, ocr: Ocr, extractor: Extractor) -> ParsedReceipt | ScanFailure.Reason`. The order is OCR → `redact` → `extract` → `validate.to_parsed`. Empty OCR text gives `UNREADABLE`.
  - `Worker` consumes `receipt.uploaded` and `receipt.uploaded.retry` in group `ai-receipts`. It skips events already in `ai.processed_events` and downloads the blob. It publishes a `ReceiptResult` to `receipt.parsed` (key = session id), records the event id, and then commits.
  - On `RateLimited`, it republishes to the retry topic with `attempt+1` and a `not_before` header. The worker holds a retry message until it is due. After attempt 4 it publishes `failed: RATE_LIMITED`.

- [ ] **Step 1:** Write the tests:
  - `test_uploaded_receipt_produces_parsed_result`: put an image in Azurite, publish `ReceiptUploaded`, and consume a `ReceiptResult.parsed` with the fake extractor's items within 15 s.
  - `Extractor_never_sees_card_or_phone`: the fake OCR returns text with `4111 1111 1111 1111` and `082 123 4567`, and the text the fake extractor captured contains neither.
  - `Rate_limited_scan_ends_failed_after_retries`: the extractor always raises `RateLimited`, with retry delays patched to 0.1 s, and the result is `failed: RATE_LIMITED` after 4 retries.
  - `test_duplicate_upload_event_is_processed_once`: the extractor is called once.
  - `test_unreadable_image_fails`.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement the code above.
- [ ] **Step 4:** `uv run pytest` → PASS.
- [ ] **Step 5:** Commit `feat(ai): receipt worker on Kafka with retries and dedupe`.

### Task 9: Running it — Aspire, compose, Caddy, CI

**Files:** Modify `aspire/Kitty.AppHost/{AppHost.cs,Kitty.AppHost.csproj}`, `deploy/compose/{docker-compose.yml,Caddyfile,smoke.sh,RUNBOOK.md,.env.example}`, `.github/workflows/*` (a new `ai.yml`; the images job builds `kitty-ai` for amd64 + arm64), and `services/ai/Dockerfile`.

- Aspire:
  - Redpanda as a container with the Kafka and schema-registry endpoints.
  - Azurite through `AddAzureStorage("storage").RunAsEmulator()` and `.AddBlobs("blobs")`.
  - ai through `AddUvicornApp`, with an optional `gemini-api-key` secret parameter.
  - The ledger gets `ConnectionStrings__kafka`, `Kafka__SchemaRegistryUrl`, the blob connection, and `Blob__ConfigureCors=true`.
- Compose:
  - `redpanda` (`--smp 1 --memory 1G --overprovisioned`, data volume, healthcheck `rpk cluster health`).
  - `azurite` (blob only, data volume, 256m).
  - `ai` (1.5g, `AI_GEMINI_API_KEY` from env, empty allowed).
  - Ledger env for kafka and blob, plus `Blob__PublicUrl=https://${KITTY_HOST}/blob`.
- Caddy: `handle_path /blob/* { reverse_proxy azurite:10000 }`, so browser uploads are same-origin.
- Smoke: add `"blob uploads are reachable"`, where an unsigned PUT to `/blob/devstoreaccount1/receipts/x` gets 403 from Azurite, not 404 from the web app.
- RUNBOOK: setting the Gemini key (a user step) and switching to Azure Blob with a connection string. Both are optional.

- [ ] **Step 1:** Add the smoke check and run it against the current trial → FAIL.
- [ ] **Step 2:** Wire up the pieces above.
- [ ] **Step 3:** Build the images. Start the compose trial (with a trial-only override giving containers the public name and Caddy's local CA, as in the 2a trial), then run smoke → all ok. Then `dotnet run --project aspire/Kitty.AppHost`: the dashboard shows ledger, ai, redpanda and azurite healthy.
- [ ] **Step 4:** Push the branch, and CI's ai job is green (ruff and pytest, including Testcontainers).
- [ ] **Step 5:** Commit `chore: run redpanda, azurite and the ai service locally, in compose and in CI`.

### Task 10: Web — scan the receipt

**Files:** Create `apps/web/src/components/table/ReceiptScan.tsx`, `lib/receipt-upload.ts`, `app/groups/[id]/table/scan-actions.ts`, and `test/receipt-upload.test.ts`. Modify `HostTable.tsx`: show `ReceiptScan` while the session is open, and reset the item rows from the server when the session's items change and the host has no unsaved edits.

**Interfaces:**
- Consumes: the scan endpoints (Task 3), apply (Task 4), and `useTableSession`.
- Produces:
  - `uploadReceipt(file: File, start: () => Promise<{uploadUrl: string; scanId: string}|{error: string}>, confirm: (scanId) => Promise<Result>, put = fetch)`. It rejects files that aren't JPEG/PNG/WebP or are over 10 MB before uploading, and PUTs with `x-ms-blob-type: BlockBlob`.
  - `scanStatusMessage(scan, waitedMs): string` gives:
    - `parsing`: "Reading the receipt…". After 20 s it becomes "Still reading — you can type the items meanwhile".
    - `parsed`: "Added N items from the receipt", or "Kitty read N items (R…) — use them instead?" when there is a suggestion.
    - `failed`: "Couldn't read it — type the items", worded per reason (rate_limited: "Kitty is busy — try again in a minute or type the items").
- The input is `<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment">`, with the privacy copy from Global Constraints.

- [ ] **Step 1:** Write the tests:
  - `rejects_non_images_and_large_files_without_uploading`.
  - `puts_to_the_sas_url_with_block_blob_header_then_confirms`.
  - `reports_start_error`.
  - `scanStatusMessage` covers each status, each failure reason, and the 20 s switch.
- [ ] **Step 2:** `corepack pnpm --filter ./apps/web test` → FAIL.
- [ ] **Step 3:** Implement the code above.
- [ ] **Step 4:** Run the web tests, typecheck and build → PASS. Then do a manual check on the Aspire stack in the built-in browser: create a bill, scan a photographed test receipt, watch the items appear on both the host and guest screens, type an item first and see the suggestion instead, and with no model configured see the manual-entry message.
- [ ] **Step 5:** Commit `feat(web): scan the receipt from the host's table screen`.

### Task 11: Receipt evals

**Files:** Create `services/ai/evals/{run_receipts.py,fetch_cord.py,README.md}` and `.github/workflows/evals.yml` (`workflow_dispatch` plus nightly; uses the `AI_GEMINI_API_KEY` repo secret, and skips with a notice when it is not set).

**Interfaces — Produces:** `run_receipts.py --data DIR [--limit N] [--min-total-accuracy 0.9]` reads `DIR/*.jpg` with a matching `*.json` (`{"items":[{"description","quantity","line_total_minor"}],"total_minor":…}`). It prints total accuracy (exact `total_minor`) and line-item F1 (an item matches on equal `line_total_minor` and a normalized description ratio ≥ 0.8). It exits 1 below the threshold. `fetch_cord.py --out DIR --limit 50` converts the CORD-v2 test split into that format (run by a person or by CI, not committed).

- [ ] **Step 1:** Write `tests/test_evals.py::test_scoring`, using known predictions vs labels with expected accuracy 0.5 and F1 0.8.
- [ ] **Step 2:** Run it and confirm it fails.
- [ ] **Step 3:** Implement scoring, the runner and the fetcher.
- [ ] **Step 4:** Run the test → PASS. Then do one local run on 5 CORD samples (if a Gemini key is set) and record the numbers in `evals/README.md`.
- [ ] **Step 5:** Commit `feat(ai): receipt eval harness and nightly workflow`.

---

## Owner steps (not automatable here)

- Create a **Gemini API key** in Google AI Studio and set it as `AI_GEMINI_API_KEY` in `deploy/compose/.env` and as a repo secret for evals. Without it, scans fail fast with "type the items", and everything else works.
- Optional: an Azure Blob storage account instead of Azurite on the VM. The plan works without it.
- Later: photograph ≥50 real receipts for the labelled eval set (spec §5.1).
