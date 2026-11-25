# Kitty Phase 4c: Crossing Things Off — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A payment can say which expenses it covers. "Cross off the Uber for Joe, I paid him" becomes a payment card you Save. Settle up can tick items and list and delete recent payments. "What you owe" lists only what's still open.

**Architecture:**
- **Ledger:**
  - A settlement owns its cover rows (`SettlementCovers`).
  - One pure helper works out what is owed, covered and open per item between two members. The open-items, owing and payment-list reads all use it.
  - Balances never read covers.
- **ai `/parse`:** gains a `payment` intent. It's resolved in code against the ledger's open items, so the model never sees the ledger.
- **Apps:** core holds the payment-draft logic. Web and Android render it, and add ticks and a payment list to Settle up.

**Tech Stack:** .NET 10 minimal APIs, EF Core and Postgres (ledger); Python FastAPI, pydantic and uv (ai); TypeScript (`@kitty/core`); Next.js (web); Expo and jest (mobile).

**Spec:** `docs/superpowers/specs/2026-11-26-kitty-phase4c-cross-off-design.md` (read it first). Parent: `docs/superpowers/specs/2026-11-15-kitty-design.md`.

## Global Constraints

- Money is integer minor units. Text comes from `MoneyText.Format`, e.g. "R 25,00", with a no-break space.
- Every POST needs an `Idempotency-Key` header.
- Links never change a balance. Totals and `Transfers` come from `BalanceQueries` and `DebtSimplifier`, exactly as today.
- An item is open between debtor D and creditor C while open > 0 and it comes after D was last square in that group and currency (`LastSquare`).
- A sentence only crosses off items in the group's own currency. Items in another currency are recorded in Settle up.
- The model never sees ledger data in `/parse`. Matching happens in code, with the person's token.
- Ask Kitty has no write tools.
- After changing the ledger API: run `KITTY_UPDATE_OPENAPI=1 dotnet test Kitty.slnx --filter OpenApiTests`, then `corepack pnpm --filter @kitty/api-client generate`. The contract-drift CI check must pass.
- Red-Green TDD. No new dependencies. Conventional commits, with no Claude credit lines.
- Test commands:
  - ledger: `dotnet test Kitty.slnx`
  - ai: `cd services/ai && uv run pytest -q && uv run ruff check . && uv run ruff format --check .`
  - core: `corepack pnpm --filter @kitty/core test`
  - web: `corepack pnpm --filter @kitty/web build`
  - mobile: `corepack pnpm --filter @kitty/mobile test`

## Review Focus

1. **An edited expense whose share drops below what's already covered.** Open becomes 0, never negative, and the extra shows as `unallocatedMinor` on the payment (Task 3 test `Edited_share_below_cover_leaves_the_rest_unallocated`).
2. **Several payers on one expense.** The debtor's share is split among payers with the largest-remainder rule and the parts sum exactly to the share (Task 1 tests).
3. **Deleting a linked payment brings its items back, in both `/open-items` and `/me/owing`** (Task 3 test `Deleting_a_linked_payment_reopens_its_items`).
4. **A cover on an item that's closed because D was square before it** is rejected with `cover_invalid` (Task 2 test `Cover_on_an_item_before_last_square_is_rejected`).
5. **A sentence naming no item when nothing is open** gives a `payment.items` "missing" issue, never an empty payment (Task 7 test `test_payment_with_nothing_open_is_an_issue`).

---

### Task 1: Who owes whom on one item (ledger domain)

**Files:**
- Create: `services/ledger/src/Kitty.Ledger/Domain/Balances/ItemDebt.cs`
- Test: `services/ledger/tests/Kitty.Ledger.UnitTests/ItemDebtTests.cs`

**Interfaces:**
- Produces: `public static long ItemDebt.Owed(IReadOnlyList<ExpensePayer> payers, IReadOnlyList<ExpenseShare> shares, Guid debtor, Guid creditor)`.
  - The debtor's share (sum of their `ExpenseShare.AmountMinor`) is divided among all payers in proportion to `ExpensePayer.AmountMinor`. Each part is floored; the leftover minor units go one each to the largest fractional remainders. Ties go to the lower `MemberId` (`Guid.CompareTo`).
  - Returns the creditor's part. Returns 0 when debtor == creditor, when the creditor isn't a payer, or when the debtor has no share.

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public void One_payer_gets_the_whole_share() =>
    Assert.Equal(2500, ItemDebt.Owed([P(Joe, 5000)], [S(Me, 2500), S(Joe, 2500)], Me, Joe));
[Fact] public void Nobody_owes_themselves() =>
    Assert.Equal(0, ItemDebt.Owed([P(Joe, 5000)], [S(Joe, 5000)], Joe, Joe));
[Fact] public void Not_a_payer_is_owed_nothing() =>
    Assert.Equal(0, ItemDebt.Owed([P(Joe, 5000)], [S(Me, 5000)], Me, Sam));
[Fact] public void Two_payers_split_the_share_by_what_they_paid()
{
    // Share 100 between payers who paid 2 and 1: 66,67 → floors 66 and 33, the leftover 1 goes to the larger remainder (Joe's ,67).
    var payers = new[] { P(Joe, 200), P(Sam, 100) };
    var shares = new[] { S(Me, 100), S(Joe, 100), S(Sam, 100) };
    Assert.Equal((67L, 33L), (ItemDebt.Owed(payers, shares, Me, Joe), ItemDebt.Owed(payers, shares, Me, Sam)));
}
[Fact] public void Equal_remainders_go_to_the_lower_member_id() { /* share 1 between two equal payers: the lower Guid gets 1, the other 0 */ }
```

`P` and `S` are local helpers that build `ExpensePayer` and `ExpenseShare`. `Me`, `Joe` and `Sam` are fixed Guids, with `Joe < Sam` in Guid order.

- [ ] **Step 2: Run them and watch them fail.** `dotnet test Kitty.slnx --filter ItemDebtTests` gives a compile error: `ItemDebt` doesn't exist.
- [ ] **Step 3: Implement `ItemDebt.Owed` as in Interfaces.**
- [ ] **Step 4: Run them again.** `dotnet test Kitty.slnx --filter ItemDebtTests` gives 5 passed.
- [ ] **Step 5: Commit.** `feat(ledger): work out what one member owes another on an item`

---

### Task 2: Payments that cover items (table and write)

**Files:**
- Modify: `services/ledger/src/Kitty.Ledger/Data/Entities/Entities.cs` (Settlement and the new SettlementCover)
- Modify: `services/ledger/src/Kitty.Ledger/Data/LedgerDbContext.cs` (Settlement config)
- Create: migration `SettlementCovers` (`dotnet ef migrations add SettlementCovers`)
- Create: `services/ledger/src/Kitty.Ledger/Features/Common/RecordedRows.cs` (moved out of `OwingEndpoints`)
- Create: `services/ledger/src/Kitty.Ledger/Features/Settlements/OpenItems.cs`
- Modify: `services/ledger/src/Kitty.Ledger/Features/Settlements/SettlementEndpoints.cs`
- Modify: `services/ledger/src/Kitty.Ledger/Infrastructure/Errors/ApiError.cs` (adds `CoverInvalid = "cover_invalid"`)
- Test: `services/ledger/tests/Kitty.Ledger.IntegrationTests/CoverTests.cs`

**Interfaces:**
- Consumes: `ItemDebt.Owed` (Task 1).
- Produces:
  - `public sealed class SettlementCover { Guid ExpenseId; long AmountMinor; }`, owned by `Settlement.Covers` (`List<SettlementCover>`, default `[]`). The table is `"SettlementCovers"`. The key is (SettlementId, ExpenseId), and there's a Restrict foreign key to `Expense`.
  - `public sealed record CoverDto(Guid ExpenseId, long AmountMinor)`.
  - `SettlementWriteDto` gains a last parameter, `IReadOnlyList<CoverDto>? Covers = null`. `SettlementDto` gains a last parameter, `IReadOnlyList<CoverDto> Covers`.
  - `public static List<(object Row, long MyDelta)> RecordedRows.Order(List<Expense> expenses, List<Settlement> settlements, string currency, Guid member)`. This is `OwingEndpoints.RecordedOrder` moved here unchanged; Owing calls it from here.
  - `public static class OpenItems`:
    - `IReadOnlyList<OpenItem> Between(List<Expense> expenses, List<Settlement> liveSettlements, string currency, Guid debtor, Guid creditor)`
    - `public sealed record OpenItem(Expense Expense, long Owed, long Open)`
    - `Dictionary<(Guid SettlementId, Guid ExpenseId), long> Effective(List<Expense> expenses, List<Settlement> liveSettlements)`

**The algorithm (`OpenItems`):**
- **Effective covers.** Go through the live settlements in `CreatedAt`, then `Id`, order. Each cover on a live expense counts `min(cover, max(0, owed(From→To, E) − effective so far on (From, To, E)))`. A cover on a deleted expense counts 0.
- **`Between`.** Take the expenses in `LastSquare.Since(RecordedRows.Order(..., debtor))`. Each one has `Owed = ItemDebt.Owed(...)` and `Open = Owed − Σ effective(debtor → creditor on it)`. Keep those with `Open > 0`, newest first by `OccurredOn`, then `CreatedAt` descending, then `Id`.

**Checks on `POST /groups/{id}/settlements`.** They run in this order, after the existing checks and before saving:
1. No expense appears twice.
2. Each expense is in this group, not deleted, and in `body.Currency`.
3. Each amount is at least 1 and no more than that item's `Open` from `OpenItems.Between(…, From, To)`. That also covers "From owes To on it" and "after last square".
4. The covers sum to no more than `AmountMinor`.

Any failure returns `ApiError.BadRequest(ErrorCodes.CoverInvalid, "<detail naming the expense description>")`. The audit after-state is the DTO with its covers.

Ruling: the table is named `"SettlementCovers"`, not the spec's `settlement_covers`, following the project's PascalCase tables (`ExpensePayers`, `ExpenseShares`).

Ruling: there's no row locking. A race can over-cover an item, but that's harmless: `Effective` clamps the second payment's cover, so the extra shows as not tied to an item. This replaces the spec's "inside the same transaction", which only bought locking.

- [ ] **Step 1: Write the failing integration tests in `CoverTests.cs`.** They use the `SpendingData.SpendAsync` helper and a new `SettleCoveringAsync(c, g, from, to, amount, params (Guid ExpenseId, long Amount)[] covers)` helper.
  - `Payment_with_covers_is_saved_and_returned`: Joe paid an R50 Uber split with me. I pay R25 covering it. The 201 body's `covers` equals `[{expenseId, 2500}]`.
  - `Cover_more_than_open_is_rejected`: a cover of 2600 on that Uber returns 400 `cover_invalid`.
  - `Cover_on_an_item_I_dont_owe_is_rejected`: I paid, and I cover my own expense. That returns 400 `cover_invalid`.
  - `Covers_above_the_payment_are_rejected`: a payment of 2000 covering 2500 returns 400 `cover_invalid`.
  - `Cover_in_another_currency_is_rejected`: a USD expense covered by a ZAR payment returns 400 `cover_invalid`.
  - `Cover_on_an_item_before_last_square_is_rejected`: Uber, then a full plain settle, then a new pizza. Covering the Uber returns 400 `cover_invalid`.
  - `A_second_payment_can_cover_the_rest`: R10 covering the Uber, then R15 covering the Uber. Both return 201. A third, R1, returns 400.
  - `Old_payments_without_covers_still_work`: a body without `covers` returns 201 with `covers: []`.
- [ ] **Step 2: Run them and watch them fail.** `dotnet test Kitty.slnx --filter CoverTests` fails: `covers` is ignored or missing from the response.
- [ ] **Step 3: Add the entity, config and migration; `RecordedRows`; `OpenItems`; and the checks.** Update `ToDto` to include covers. Run `dotnet ef migrations add SettlementCovers --project services/ledger/src/Kitty.Ledger`.
- [ ] **Step 4: Run the full suite.** `dotnet test Kitty.slnx` passes, including `OwingTests` after the move and `SchemaTests`.
- [ ] **Step 5: Commit.** `feat(ledger): a payment can say which expenses it covers`

---

### Task 3: Open items between two members, and owing lists only what's open

**Files:**
- Create: `services/ledger/src/Kitty.Ledger/Features/Settlements/OpenItemsEndpoints.cs` (DTOs in the same file, as in Settlements)
- Modify: `services/ledger/src/Kitty.Ledger/Program.cs` (`group.MapOpenItems()`)
- Modify: `services/ledger/src/Kitty.Ledger/Features/Owing/OwingDtos.cs` and `OwingEndpoints.cs`
- Test: `services/ledger/tests/Kitty.Ledger.IntegrationTests/OpenItemsTests.cs`, and update `OwingTests.cs`

**Interfaces:**
- Consumes: `OpenItems.Between`, `OpenItems.Effective`, `RecordedRows.Order` (Task 2); `ExpenseLineDto.Of`.
- Produces:
  - `GET /groups/{groupId}/open-items?from={memberId}&to={memberId}` (name `GetOpenItems`). It returns `OpenItemsDto(Guid FromMemberId, Guid ToMemberId, IReadOnlyList<OpenItemsCurrencyDto> Currencies)`.
    - `OpenItemsCurrencyDto(string Currency, IReadOnlyList<OpenItemDto> FromOwes, MoneyDto FromOwesTotal, IReadOnlyList<OpenItemDto> ToOwes, MoneyDto ToOwesTotal)`
    - `OpenItemDto(ExpenseLineDto Item, MoneyDto Open)`, where `Item.MyShare` is the debtor's share.
    - Only currencies with something open in either direction are included.
    - A `from` or `to` not in the group gives 400 `member_not_in_group`. `from == to` gives a 400 validation error.
  - `/me/owing`:
    - `OwingCurrencyDto.Since` becomes `IReadOnlyList<OwingLineDto>`.
      - `OwingLineDto(Guid ExpenseId, string Description, DateOnly Date, string Category, MoneyDto Total, MoneyDto MyShare, string PaidBy, IReadOnlyList<OpenWithDto> Open)`.
      - `OpenWithDto(Guid MemberId, string Name, string Direction, MoneyDto Amount)`, where `Direction` is `"i_pay"` or `"pays_me"`.
    - `OwingPaymentDto` gains `MoneyDto Unallocated`.

**The new `Since`:** for every other member X, the union of `Between(me→X)` (`i_pay`) and `Between(X→me)` (`pays_me`), grouped by expense, newest first. The ten-line cap and `MoreSince` stay as they are.

**`Payments`:** unchanged: the payments since my last square. `Unallocated = AmountMinor − Σ Effective` on that payment.

- [ ] **Step 1: Write the failing tests.**
  - `OpenItemsTests`:
    - `Covered_item_drops_off`: Uber (I owe Joe 2500) and groceries (I owe 9500). A payment of 2500 covers the Uber. `FromOwes` holds only the groceries, with `FromOwesTotal` 9500.
    - `Part_cover_leaves_the_rest_open`: covering 1000 leaves the Uber open with `Open` 1500.
    - `Both_directions_are_listed`: Joe owes me 3000 for pizza. `ToOwes` holds the pizza, with `ToOwesTotal` 3000.
    - `Deleting_a_linked_payment_reopens_its_items`: delete the covering payment and the Uber is back with 2500.
    - `Member_not_in_group_is_rejected`: an unknown member returns 400 `member_not_in_group`.
    - `Edited_share_below_cover_leaves_the_rest_unallocated`: after the cover, edit the Uber so my share is 1000. The Uber isn't open, and `/me/owing`'s payment has `Unallocated` 1500.
  - `OwingTests` (updated):
    - The existing `Since` assertions now read `OwingLineDto`.
    - New `Owing_lists_only_open_items_with_who_they_are_open_with`: after covering the Uber, `Since` doesn't include it. The groceries line has `Open = [{JoeM, "Friend", "i_pay", 9500}]`.
    - New `Payment_shows_its_unallocated_part`: a payment of 5000 covering 2500 gives `Unallocated` 2500.
- [ ] **Step 2: Run them and watch them fail.** `dotnet test Kitty.slnx --filter "OpenItemsTests|OwingTests"` fails: route 404 and a shape mismatch.
- [ ] **Step 3: Implement the endpoint and the owing changes as in Interfaces.**
- [ ] **Step 4: Run the full suite.** `dotnet test Kitty.slnx` passes.
- [ ] **Step 5: Commit.** `feat(ledger): list what's still open between two members, and only that in owing`

---

### Task 4: Recent payments list, then the API contract

**Files:**
- Modify: `services/ledger/src/Kitty.Ledger/Features/Settlements/SettlementEndpoints.cs` (`MapGet("/")`, named `ListSettlements`)
- Test: `services/ledger/tests/Kitty.Ledger.IntegrationTests/CoverTests.cs` (same file)
- Regenerate: `openapi/ledger.json`, `packages/api-client/src/schema.d.ts`

**Interfaces:**
- Produces: `GET /groups/{groupId}/settlements?limit=20` returns `IReadOnlyList<SettlementLineDto>`, newest first, live payments only.
  - `SettlementLineDto(SettlementDto Payment, string From, string To, DateOnly Date, IReadOnlyList<CoverLineDto> Covers)`
  - `CoverLineDto(Guid ExpenseId, string Description, MoneyDto Amount)`. A deleted expense's description is `"(deleted expense)"`.
  - `Date` is `CreatedAt` in UTC+2.
  - `limit` must be 1–50, default 20; outside that is a 400 validation error.

- [ ] **Step 1: Write the failing tests.**
  - `Recent_payments_are_newest_first_with_covers`: two payments, one covering the Uber. The list is newest first, and the covering one's `Covers` is `[{uberId, "Uber", R25}]`.
  - `Deleted_payments_are_not_listed`
  - `A_deleted_expense_shows_as_deleted`
  - `Limit_out_of_range_is_rejected`: `limit=0` and `limit=51` both return 400.
- [ ] **Step 2: Run them and watch them fail.** `dotnet test Kitty.slnx --filter CoverTests` gives 405 or 404.
- [ ] **Step 3: Implement the list.**
- [ ] **Step 4: Run the full suite and regenerate the contract.** `dotnet test Kitty.slnx` passes. Then run `KITTY_UPDATE_OPENAPI=1 dotnet test Kitty.slnx --filter OpenApiTests` and `corepack pnpm --filter @kitty/api-client generate`. `corepack pnpm --filter @kitty/api-client test` passes.
- [ ] **Step 5: Commit.** `feat(ledger): list a group's recent payments with what they covered`, including the regenerated contract.

---

### Task 5: ai reads open items and the new owing shape

**Files:**
- Modify: `services/ai/src/kitty_ai/ledger.py`
- Modify: `services/ai/evals/ask/world.json` and `services/ai/evals/ask/questions.jsonl` (case 2)
- Test: `services/ai/tests/test_ledger_reader.py`

**Interfaces:**
- Produces: `LedgerReader.open_items(group_id: str, from_member: str, to_member: str) -> dict`, the raw `OpenItemsDto` JSON from `GET /groups/{g}/open-items?from=&to=`. `owing()` is unchanged: it passes the new shape through.
- `world.json`:
  - The canned `/me/owing` takes the Task 3 shape.
  - In Flat 4B, R 25,00 of the R 50,00 payment to Joe covers the Uber. So `Since` holds only the groceries, with `Open` R 95,00 to Joe, and the payment's `Unallocated` is R 25,00. The totals are unchanged (owe Joe R 70,00).
  - Case 2's `expect` becomes `{"calls": ["what_i_owe"], "contains": ["R 70,00", "Groceries", "Flat 4B"], "not_contains": ["Uber"]}`.

- [ ] **Step 1: Write the failing test.** `test_open_items_reads_both_members` uses a `MockTransport` asserting the path `/groups/g1/open-items` and the params `from=m1`, `to=m2`, and returns a body that's passed through as-is.
- [ ] **Step 2: Run it and watch it fail.** `uv run pytest -q tests/test_ledger_reader.py` fails with `AttributeError: open_items`.
- [ ] **Step 3: Implement `open_items`, and update `world.json` and case 2.**
- [ ] **Step 4: Run the tests and lint.** `uv run pytest -q` passes, `test_ask_evals_file` included, and ruff is clean.
- [ ] **Step 5: Commit.** `feat(ai): read open items, and teach the ask world a linked payment`

---

### Task 6: The `payment` intent (schema and parse prompt)

**Files:**
- Modify: `services/ai/src/kitty_ai/entry/schema.py`, `services/ai/src/kitty_ai/entry/parse.py`
- Modify: `services/ai/evals/nl/phrases.jsonl`, `services/ai/tests/test_nl_evals_file.py` (`EXPECT_FIELDS` gains `direction`, `counterpart` and `items`; the intent set gains `payment`)
- Test: `services/ai/tests/test_entry_parse.py` (or the existing parse test file)

**Interfaces:**
- Produces, on `ParsedSentence`:
  - `intent: Literal["expense", "reminder", "question", "payment", "unclear"]`
  - `direction: Literal["i_paid", "they_paid"] | None = None`
  - `counterpart: str | None = Field(default=None, description="The other person in a payment, as written.")`
  - `items: list[str] = Field(default_factory=list, description='What a payment was for, as written, e.g. ["Uber"].')`
- These lines are added to `SYSTEM`, before "Otherwise intent is unclear":
  - `'intent is "payment" when they say they paid someone back, or someone paid them back, for something already recorded, or ask to cross something off ("cross off the Uber for Joe, I paid him", "Joe paid me back for the pizza"):'`
  - `'direction "i_paid" or "they_paid", counterpart the other person, items what it was for as written, amount only if stated.'`
- Eight new phrases go in `phrases.jsonl`, with `today` 2026-11-26 and currency ZAR. They're the five from the spec's §2, "I paid Joe R10 for the Uber", "Sam paid me back", and "cross off the Uber" (with no counterpart). Each expects `intent: "payment"` and the right `direction`, `counterpart`, `items` and `amount`.

- [ ] **Step 1: Write the failing tests.**
  - `test_payment_fields_validate`: `ParsedSentence.model_validate({"intent": "payment", "direction": "i_paid", "counterpart": "Joe", "items": ["Uber"]})` succeeds.
  - `test_prompt_describes_payments`: `"cross off the Uber for Joe, I paid him"` is in `parse.SYSTEM`.
  - Update `test_nl_evals_file` for the new fields.
- [ ] **Step 2: Run them and watch them fail.** `uv run pytest -q tests/test_entry_parse.py tests/test_nl_evals_file.py` fails with a validation error.
- [ ] **Step 3: Implement the schema, prompt and phrases.**
- [ ] **Step 4: Run the tests and lint.** `uv run pytest -q` and ruff pass.
- [ ] **Step 5: Commit.** `feat(ai): read crossing-off sentences as payments`

---

### Task 7: Resolve a payment draft against open items

**Files:**
- Modify: `services/ai/src/kitty_ai/entry/resolve.py`, `services/ai/src/kitty_ai/entry/routes.py`
- Test: `services/ai/tests/test_entry_resolve.py`, `services/ai/tests/test_entry_routes.py`

**Interfaces:**
- Consumes: `LedgerReader.open_items` (Task 5) and `ParsedSentence` payment fields (Task 6).
- Produces: `build_draft(parsed, group, me_member_id, today, owed_for, open_items: Callable[[str, str], dict])`. The new last argument is `open_items(from_member, to_member) -> OpenItemsDto` JSON. `routes.draft_for` passes `lambda f, t: reader.open_items(group.id, f, t)`.
  - A `payment` draft adds `draft["payment"]`:

    ```
    {"fromMemberId", "toMemberId", "currency", "amountMinor", "statedAmountMinor",
     "openItems": [{"expenseId", "description", "date", "openMinor"}],   # everything open in that direction, group currency, oldest first
     "covers": [{"expenseId", "amountMinor"}]}
    ```

  - Issue fields:
    - `payment.counterpart`: `no_match` or `ambiguous`, from `match_member`, or `missing`.
    - `payment.items[i]`: `ambiguous`, with the matching expense ids as candidates; `no_match`, with every open id as candidates; or `other_currency`, when only items in another currency match.
    - `payment.items`: `missing`, when nothing is open in that direction.
    - `payment.amount`: `other_currency`, when the sentence's currency isn't the group's.

**Rules:**
- `i_paid` means from = me and to = counterpart; `they_paid` is the reverse.
- A phrase matches an open item when every word of `_norm(phrase)` is a prefix of some word of `_norm(description)`.
- With no phrases, every open item is covered.
- Covers, oldest first:
  - With no stated amount, each item is covered by its open amount, and `amountMinor` is the sum.
  - With a stated amount, it's allocated across the covered items, oldest first, each up to its open amount. `amountMinor` is the stated amount, and any rest stays not tied to an item.

- [ ] **Step 1: Write the failing tests** in `test_entry_resolve.py`. They use a fake `open_items` returning a canned `OpenItemsDto`: the Uber, R 25,00, 18 Nov, and the Groceries, R 95,00, 20 Nov, both owed by me to Joe.
  - `test_payment_covers_the_named_item`: "Uber", no amount. The covers are `[{uber, 2500}]` and `amountMinor` is 2500.
  - `test_payment_part_amount_stays_on_one_item`: amount "10". The covers are `[{uber, 1000}]`.
  - `test_payment_without_items_covers_everything_open`: the covers are both items, and `amountMinor` is 12000.
  - `test_two_matches_is_an_ambiguous_issue`: two "Uber" items give a `payment.items[0]` `ambiguous` issue with both ids.
  - `test_payment_with_nothing_open_is_an_issue`: there's a `payment.items` `missing` issue, and `covers` is `[]`.
  - `test_they_paid_reverses_the_members`: from is Joe and to is me, and `open_items` was called with (joe, me).
  - `test_other_currency_item_is_flagged`.
  - In `test_entry_routes.py`: `test_parse_payment_returns_a_payment_draft`. A fake parser returns a payment and a fake ledger serves open-items, so `/parse` returns `intent: "payment"`.
- [ ] **Step 2: Run them and watch them fail.** `uv run pytest -q tests/test_entry_resolve.py tests/test_entry_routes.py` fails.
- [ ] **Step 3: Implement the payment branch and pass `open_items` through `routes.draft_for`.**
- [ ] **Step 4: Run the tests and lint.** `uv run pytest -q` and ruff pass.
- [ ] **Step 5: Commit.** `feat(ai): turn a crossing-off sentence into a payment draft`

---

### Task 8: Ask Kitty sends crossing off to the payment card

**Files:**
- Modify: `services/ai/src/kitty_ai/ask/agent.py` (prompt) and `services/ai/src/kitty_ai/ask/tools.py` (`not_a_question` description)
- Modify: `services/ai/evals/ask/questions.jsonl` (case 6)
- Test: `services/ai/tests/test_ask_agent.py` and `test_ask_tools.py`. Replace `test_prompt_lets_new_entries_through`, `test_prompt_says_crossing_off_is_not_an_entry` and `test_not_a_question_excludes_changing_an_existing_expense`.

**Interfaces:**
- Produces this prompt rule, replacing the cross-off one:
  - `"- When the latest message crosses off or marks as paid an existing expense, or says a payment happened, call not_a_question: the app turns it into a payment to confirm."`
  - `"- When the person asks you to change or delete an existing expense or payment, say Kitty can't do that from here and point them to the group. Never say you did it."`
- Two existing rules are replaced to match the new owing shape:
  - The "List that group's expenses since they were last square…" rule becomes `"- What the person owes someone comes from each group's settle-up plan. List the items still open in that group, each with what's left and who it's open with; never imply someone paid an expense they didn't. When the settle-up plan has them pay someone the open items aren't with, say the amount is from the settle-up plan."`
  - The "When there were payments since they were last square…" rule becomes `"- When a payment has a part not tied to an item, mention it, so the open items and the total still add up."`
- The `not_a_question` description becomes: `"Call this when the latest message is something to add or a reminder to send, not a question: a new expense, a payment that happened, or crossing off an existing expense as paid."`
- Case 6 becomes `{"calls": ["not_a_question"], "entry": true}`.

- [ ] **Step 1: Write the failing tests.**
  - `test_prompt_sends_crossing_off_to_the_payment_card`: the first new line is in the prompt, and `"record, pay"` isn't.
  - `test_prompt_still_refuses_changing_an_expense`: `"change or delete an existing expense or payment"` is in the prompt.
  - `test_prompt_lists_open_items_and_unallocated_payments`: `"List the items still open"` and `"a part not tied to an item"` are both in the prompt.
  - `test_not_a_question_covers_crossing_off`: `"crossing off an existing expense as paid"` is in the description.
- [ ] **Step 2: Run them and watch them fail.** `uv run pytest -q tests/test_ask_agent.py tests/test_ask_tools.py` fails.
- [ ] **Step 3: Change the prompt, the description and case 6.**
- [ ] **Step 4: Run the tests and lint.** `uv run pytest -q` and ruff pass.
- [ ] **Step 5: Commit.** `feat(ai): Ask Kitty hands crossing off to the payment card`

---

### Task 9: Core payment-draft logic

**Files:**
- Modify: `packages/core/src/plain-entry.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/plain-entry.test.ts`

**Interfaces:**
- Produces:
  - Types:
    - `type OpenItem = { expenseId: string; description: string; date: string; openMinor: number }`
    - `type PaymentDraft = { fromMemberId: string | null; toMemberId: string | null; currency: string; amountMinor: number | null; statedAmountMinor: number | null; openItems: OpenItem[]; covers: { expenseId: string; amountMinor: number }[] }`
    - `PlainDraft.intent` gains `"payment"`, and `PlainDraft` gains `payment?: PaymentDraft`.
    - `DraftIssue.kind` gains `"other_currency"`.
  - `allocateCovers(items: OpenItem[], ticked: string[], amountMinor: number | null): { covers: {expenseId: string; amountMinor: number}[]; amountMinor: number }`.
    - The ticked items are taken oldest first (by `date`, then `expenseId`).
    - With no amount, each gets its open amount, and the amount is the sum.
    - With an amount, each gets up to its open amount until the amount runs out, and the amount stays as given.
  - `toggleCover(draft: PlainDraft, expenseId: string): PlainDraft`: ticks or unticks the item, then re-runs `allocateCovers` with `statedAmountMinor`.
  - `applyPick(draft, i, id)` for a `payment.items[i]` issue: a non-null id ticks that item and removes the issue; null just removes the issue.
  - `withCounterpart(parsed: unknown, displayName: string): unknown` returns a copy of `parsed` with `counterpart` set to `displayName`. A `payment.counterpart` pick can't be finished client-side, because the open items depend on who it is. The apps call `/resolve` again with `withCounterpart(draft.parsed, picked.displayName)` (4a's `rematchGroup` path). If the name is still ambiguous, the issue simply stays.
  - `canSave` for a payment: no issues, `groupId`, both members set, `amountMinor > 0`, at least one cover, and covers summing to no more than `amountMinor`.
  - `toSettlementWriteDto(draft: PlainDraft, id: string): Schemas["SettlementWriteDto"]`.
  - `countingBoth(open: Schemas["OpenItemsDto"], currency: string, meMemberId: string, otherName: string): string | null` uses the `open.currencies` entry for `currency`, the payment's currency. It returns null unless both totals are above 0. Otherwise:
    - they owe more: `"Counting what {otherName} owes you, {otherName} owes you {money}."`
    - I owe more: `"Counting what {otherName} owes you, you still owe {otherName} {money}."`
    - equal: `"Counting what {otherName} owes you, you're even."`

    Here money is the absolute difference, formatted with `formatMoney`, and "you" is whichever of from/to is `meMemberId`.

- [ ] **Step 1: Write the failing tests** in `plain-entry.test.ts`.
  - `allocateCovers`:
    - "oldest first, whole amounts";
    - "a stated amount stops part-way" (items 2500 and 9500 with an amount of 3000 give covers 2500 and 500);
    - "an amount below the first item covers part of it".
  - "toggleCover re-totals"
  - "picking an ambiguous item ticks it and clears the issue"
  - "withCounterpart replaces only the counterpart"
  - "canSave refuses a payment with no covers"
  - "toSettlementWriteDto sends the covers"
  - `countingBoth`: "says who owes whom net" (pizza 3000 against Uber 2500 gives "Counting what Joe owes you, Joe owes you R 5,00."), and "is null when only one side is open".
- [ ] **Step 2: Run them and watch them fail.** `corepack pnpm --filter @kitty/core test` fails: the functions aren't exported.
- [ ] **Step 3: Implement them as in Interfaces.**
- [ ] **Step 4: Run the core tests and the web typecheck.** `corepack pnpm --filter @kitty/core test` passes. `corepack pnpm --filter @kitty/web build` still compiles: the card doesn't handle `"payment"` yet, but it renders nothing for it.
- [ ] **Step 5: Commit.** `feat(core): payment drafts, cover allocation and the counting-both line`

---

### Task 10: Web — payment card, Settle up ticks, recent payments

**Files:**
- Modify: `apps/web/src/components/PlainEntry.tsx` (`PaymentSummary`, Save for payments)
- Modify: `apps/web/src/app/plain-entry/actions.ts` (`savePayment`, `openItems`)
- Modify: `apps/web/src/app/groups/[id]/settle/page.tsx` and `apps/web/src/app/groups/[id]/actions.ts` (`recordSettlement` reads `cover` fields; `deleteSettlement`)
- Create: `apps/web/src/components/CoversPicker.tsx` (client component: the ticks plus the partial-cover note)

**Interfaces:**
- Consumes: Task 9 (`allocateCovers`, `toggleCover`, `canSave`, `toSettlementWriteDto`, `countingBoth`); the Task 3 and 4 endpoints through `@kitty/api-client`.
- Produces:
  - `savePayment(draft: PlainDraft, idempotencyKey: string): Promise<{ error: string | null; countingBoth: string | null }>`. It posts the settlement, using the key as both the settlement id and the `Idempotency-Key`. On success it reads `open-items` between from and to, and returns `countingBoth(...)`.
  - `recordSettlement` reads repeated `cover` form fields as `expenseId:amountMinor`.
  - `deleteSettlement(form)` deletes the payment and redirects to `/groups/{id}/settle?deleted=1`.

**Card and Settle up text:**
- The payment card summary:
  - `"You paid Joe R 25,00"` or `"Joe paid you R 30,00"`;
  - then one line per open item, with a checkbox, `"Uber · 18 Nov · R 25,00 open"`;
  - Save and Cancel.

  After saving, it shows `"Payment recorded."`, plus the `countingBoth` line when there is one.
- Settle up: under each transfer, a `<details>` titled `"What it covers"` lists the open items from payer to receiver, all unticked.
  - With items ticked, the partial note reads `"{description}: {covered} of {open}"`. It shows only when the last ticked item is partly covered.
  - A `"Recent payments"` section comes after the transfers, rendered even when everyone is settled up as long as the list isn't empty. Each row reads `"{From} paid {To} {money} · {d MMM} · for: {descriptions joined ', '}"`, with a Delete form whose button runs `confirm("Delete this payment? Its items go back on the list.")`.

Ruling: web has no component tests (its tests are lib-level). Correctness lives in core (Task 9), so this task is verified by a build plus the end-to-end check in Task 12.

- [ ] **Step 1: Build the card, the actions and Settle up as in Interfaces.**
- [ ] **Step 2: Verify the build.** `corepack pnpm --filter @kitty/web build` succeeds, and `corepack pnpm --filter @kitty/web test` passes.
- [ ] **Step 3: Commit.** `feat(web): cross things off from the box and from Settle up`

---

### Task 11: Android — payment card, Settle up ticks, recent payments

**Files:**
- Modify: `apps/mobile/src/components/PlainEntry.tsx`
- Modify: `apps/mobile/src/app/(app)/groups/[id]/settle.tsx`
- Test: `apps/mobile/test/plain-entry.test.tsx` and `apps/mobile/test/settle.test.tsx`, using the `fakeLedger` routes for `GET /groups/{id}/open-items`, `GET /groups/{id}/settlements`, `POST` and `DELETE` settlements

**Interfaces:**
- Consumes: Task 9; the copy from Task 10, kept identical.
- Produces: the same behaviour as web.
  - The card's Save posts through `ledger.POST("/groups/{groupId}/settlements")`, with a `randomUUID()` key kept across retries (4a's pattern).
  - Settle up: a `"What it covers"` toggle per transfer, with `Checkbox` rows; and `"Recent payments"`, with Delete behind `Alert.alert("Delete this payment?", "Its items go back on the list.", [Cancel, Delete])`.

- [ ] **Step 1: Write the failing tests.**
  - `plain-entry`:
    - "a payment card saves the covers": `fakeAi` returns the Uber payment draft. Pressing Save posts `covers: [{expenseId: uber, amountMinor: 2500}]` and shows "Payment recorded."
    - "unticking an item re-totals the card": R 120,00 becomes R 25,00.
    - "the counting-both line shows after saving": open-items returns both sides, and the line text appears.
  - `settle`:
    - "ticked items go with Mark as paid": the POST body's `covers` holds the ticked item.
    - "a partly covered item says so": `"Uber: R 10,00 of R 25,00"`.
    - "recent payments list and delete": the row text appears; Delete, then confirm, sends a DELETE and reloads.
- [ ] **Step 2: Run them and watch them fail.** `corepack pnpm --filter @kitty/mobile test -- plain-entry settle` fails.
- [ ] **Step 3: Implement as in Interfaces.**
- [ ] **Step 4: Run the full mobile suite and the export.** `corepack pnpm --filter @kitty/mobile test` passes, and `npx expo export --platform android` succeeds.
- [ ] **Step 5: Commit.** `feat(mobile): cross things off from the box and from Settle up`

---

### Task 12: End-to-end under Aspire, and the docs

**Files:**
- Modify: `docs/superpowers/specs/2026-11-15-kitty-design.md` (phase list: 4c done, shipped as designed); `services/ai/evals/README.md` (a note that the ask world now has a linked payment)

- [ ] **Step 1: Run the whole stack.** `export PATH="/c/Program Files/Go/bin:/c/Users/zakhi/.local/bin:$PATH" && dotnet run --project aspire/Kitty.AppHost`.
- [ ] **Step 2: Script the ledger checks against a running stack**, signing in as the local test accounts (PKCE on `kitty-mobile`, as in 4b). Expected:
  - an expense and a covering payment succeed;
  - `/open-items` no longer lists the item;
  - `/me/owing` shows `Unallocated`;
  - the payments list shows the cover;
  - deleting the payment brings the item back.
- [ ] **Step 3: Check web Settle up in the browser pane.** Expected: the ticks, a partial note, and Recent payments with Delete all work.
- [ ] **Step 4: Run every suite.** Expected: dotnet, ai, core, web build, mobile, money and api-client all green.
- [ ] **Step 5: Commit.** `docs: phase 4c shipped`

The owner then runs the ask and NL evals live with Gemini before merge. Phases 4a and 4b used the same command.
