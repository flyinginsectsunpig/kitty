# Kitty Phase 4c: Crossing Things Off

Status: draft for approval · 2026-11-26 · Parent: `2026-11-15-kitty-design.md` (phase 4) · Builds on: `2026-11-25-kitty-phase4a-plain-language-entry-design.md`, `2026-11-25-kitty-phase4b-ask-kitty-design.md`

## 1. Intent

You've paid Joe back for the Uber, outside Kitty. You type "Cross off the Uber for Joe, I paid him". Kitty shows a payment card ("You paid Joe R 25,00 for the Uber, 18 Nov"). You press Save, and from then on the Uber no longer appears in what you owe Joe. Settle up can do the same: when you record a payment there, you can tick which items it covers.

The owner's words: the list under what you owe should show **only what I still owe after the crossed-off items**. Today a payment is only an amount between two people, so after a part payment the list can't tell which things are paid. 4b worked around this by listing everything since you were last square, plus the payments made since then (4b's rule A). 4c replaces that rule.

## 2. What people do (agreed)

| They say or do | What Kitty does |
|---|---|
| "Cross off the Uber for Joe, I paid him" | A payment card: you paid Joe your open amount on the Uber, linked to it. Save records it |
| "Joe paid me back for the pizza" | The mirror image: Joe paid you, linked to the pizza |
| "Cross off the Uber and the groceries, I paid Joe" | One payment for the sum of the open amounts, linked to both |
| "I paid Joe R 10 for the Uber" | R 10,00 against the Uber. The Uber stays on the list with R 15,00 left |
| Two Ubers with Joe are still open | The card asks which one, the way 4a asks for a group |
| Settle up, Mark as paid | Unchanged, except the open items between the two people are listed with ticks. Ticked items are linked to the payment |
| A linked payment is deleted from Settle up's new "Recent payments" list | Its items come back on the list |
| You and Joe both owe each other | Nothing stops you. After you save, Kitty adds one line: "Counting what Joe owes you, Joe owes you R 5,00" |

Crossing off by sentence records a payment that has **already happened**, so there's no warning before Save, only the "counting both" line afterwards. A warning *before* paying belongs with a pay button, and Kitty has none: Settle up records payments, it doesn't send money.

## 3. Goals, non-goals, anti-goals

**Goals**
- A payment can say which expenses it covers, and how much of each. A payment can cover part of an item, and several items at once.
- The 4a box drafts a payment from a crossing-off sentence. The payment is saved only when you press Save on the card. Web and Android.
- Settle up on web and Android lists the open items between the two people, with ticks.
- "What you owe" (`/me/owing`, and so Ask Kitty) lists only what's still open, with the amount left on each item.

**Non-goals**
- Moving money, or a pay button.
- Editing a payment. Payments can't be edited today; you delete one and record it again.
- Ticking off an expense *without* a payment ("we called it even"). Every cross-off is a payment.
- Marking items on the group's expense list or the expense screen as paid. The open list lives in Settle up, `/me/owing` and Ask Kitty.
- Linking payments recorded before 4c to items afterwards. Old payments stay unlinked; delete and re-record one to link it.
- Changing or deleting an expense by sentence. Ask Kitty still points to the group for that.

**Anti-goals**
- **A total that disagrees with the balance.** Links never change any balance. Every total still comes from the ledger's running balances and settle-up plan, exactly as today. Links only decide which items are listed and how much is left on each.
- **Something hidden that's still owed.** An item drops off the list only once it's fully covered, or once you're square in that group and currency. Where the open items don't add up to the balance, the difference is shown as its own line (§5.3), never silently.
- **The model saving anything.** The sentence only produces a draft. Matching "the Uber" to an expense happens in code, against the ledger, with the person's own token. Ask Kitty still has no write tools.

## 4. Approaches (decided: A)

- **A. Each payment records the items it covers, with an amount for each (chosen).** A new table holds rows of (payment, expense, amount). The ledger works out what's left on each item from those rows. This supports partial payments, one payment covering several items, and undo by deleting the payment. The sentence and Settle up write the same thing. Cost: a new table, and a more involved `/me/owing`.
- **B. A tick on the item itself.** Each item gets a "covered by payment X" mark. Simpler, but it can't record "R 10 for the Uber", and one item can't be spread over two payments.
- **C. No stored links; payments pay off the oldest items first.** Nothing new to store, but you can't say a payment was *for* the Uber. Kitty would pick, which is the opposite of what was asked.

## 5. Design

### 5.1 Who owes whom on one item (a ledger rule, mine)

Splits already say what each member's share is (`ExpenseShare`) and who paid how much (`ExpensePayer`). For a debtor D and a creditor C on expense E:

- **owed(D→C, E)** = D's share × (what C paid ÷ what all payers paid). With several payers, D's share is divided among them using the largest-remainder rule, so the parts add up to the share exactly. Someone who is a payer owes nothing to themselves.
- **covered(D→C, E)** = the sum of the cover amounts on live (not deleted) payments from D to C linked to E.
- **open(D→C, E)** = max(0, owed − covered).

An item is **open** between D and C while open > 0, and it's after the last time D was square in that group and currency (4b's `LastSquare`, kept as it is). Everything before D was last square is closed, linked or not.

If an expense is edited so a share drops below what's already covered, open becomes 0. The extra stays part of the payment and shows up as "not tied to an item" (§5.3). If an expense is deleted, its covers are ignored the same way.

### 5.2 Ledger

**Table** `settlement_covers`: `settlement_id`, `expense_id`, `amount_minor` (> 0); the key is (settlement_id, expense_id). Each is a foreign key with no cascade, since settlements and expenses are soft-deleted. There's an EF migration. Old settlements have no rows.

**Write.** `SettlementWriteDto` gets `Covers: [{ ExpenseId, AmountMinor }]`, optional and empty by default. `POST /groups/{id}/settlements` checks, in this order, failing fast:
- each expense is in this group and not deleted, and in the payment's currency (the debt currency; `PaidInGroupCurrency` doesn't change that);
- the payment's From owes its To on that expense: owed(From→To, E) > 0;
- the amount is ≥ 1 and ≤ open(From→To, E), worked out inside the same transaction;
- no expense appears twice;
- the sum of covers ≤ the payment's `AmountMinor`.

Violations are a 400 `ProblemDetails` with a new code: `cover_invalid`, with a detail naming the expense. The audit entry's after-state includes the covers. Deleting a payment works as it does now; its covers stop counting because the payment is deleted.

**Read: open items between two members.** `GET /groups/{groupId}/open-items?from={memberId}&to={memberId}` returns, per currency:
- `FromOwes`: the items where `from` owes `to`, newest first. Each is an `ExpenseLineDto` plus `Open` (a `MoneyDto`).
- `ToOwes`: the same in the other direction.
- `FromOwesTotal` and `ToOwesTotal`: the sums of the open amounts.

Any member of the group may ask about any two members, because Settle up lists everyone's transfers and anyone can mark one as paid. Expenses are already visible to the whole group. A caller who isn't in the group gets 404, as every group route does. **Read: recent payments (agreed, after the builder check).** `GET /groups/{groupId}/settlements?limit=20` returns the group's live payments, newest first. For each one:
- the `SettlementDto` fields;
- the payer's and receiver's names;
- the date, in South African time;
- `Covers`: a list of `{ ExpenseId, Description, Amount }`, where an expense deleted since then shows as "(deleted expense)".

`limit` is 1 to 50, default 20. Deleting stays as it is today: any member of the group can delete a payment, and the audit log records who did.

The resolver in 5.4 calls it with `from` and `to` set to the person and the counterpart, in the sentence's direction. The Settle up ticks call it with the transfer's payer and receiver. (My call, after the builder check.)

**Read: `/me/owing`.** In each group and currency, `Since` becomes the **open** items involving me, both ways. Each line gains `Open`: a list of `{ MemberId, Name, Direction ("i_pay" | "pays_me"), Amount }`, one for each person the item is still open with.
- `Payments` keeps listing the payments since I was last square. Each payment gains `Unallocated`: the part not tied to an item.
- The totals and `Transfers` don't change.

4b's ten-line cap and `MoreSince` stay.

### 5.3 When the list and the balance disagree

Settle-up plans simplify debts across the group, and payments made without links (old ones, or Settle up with nothing ticked) aren't tied to an item. So what's open item by item can differ from what the plan says you owe. Kitty shows both, and never adjusts either one:

```
You owe Joe R 70,00 in Flat 4B (settle-up plan). Still open:
- Groceries, 20 Nov: R 95,00 (Joe paid)
You paid Joe R 25,00 not tied to an item.
```

This is the same honesty rule 4b already has: "say the amount is from the settle-up plan".

### 5.4 The sentence (ai `/parse`, 4a's route)

- **Schema:** `intent` gains `"payment"`. New fields:
  - `direction`: `"i_paid"` or `"they_paid"`;
  - `counterpart`: the other person, as written;
  - `items`: a list of short descriptions as written, e.g. `["Uber", "groceries"]`, possibly empty;
  - `amount` is reused (the stated amount, optional).

  The model never sees the ledger. It only turns the sentence into these fields.
- **Resolve** (code, with the person's token):
  1. Match the group (4a's `match_group`) and the counterpart (4a's `match_member`).
  2. Call `open-items` for the person and the counterpart and match each item phrase to the open items in the chosen direction. A phrase matches an item whose description contains all of the phrase's words, ignoring case, as 4a's group matching does.
  3. A phrase with several matches becomes an issue with the matches as choices. A phrase with no match becomes an issue that lists what's open.
  4. With no phrases ("I paid Joe back"), every open item in that direction is a candidate, ticked by default.
  5. Amount: with no amount stated, the cover for each item is its open amount and the payment is their sum. With an amount stated and one item, that amount is the cover (it may be less than open). With an amount stated and several items, the covers go to the items oldest first, and anything left over stays unallocated.
- **Draft:** `intent: "payment"`, `groupId`, `fromMemberId`, `toMemberId`, `currency`, `amountMinor`, `covers` (each with its description, date and open amount for the card), and `issues`.
- **Currency (my call, after the builder check):** a sentence only crosses off items in the **group's currency**. A stated amount is read with 4a's currency rule, so "R" means ZAR. A matched item in another currency becomes an issue ("Record this one in Settle up"), because only Settle up handles exchange rates (`ForeignSettleFields`). So the card never needs a rate.
- **Ask Kitty:** the 4b prompt and the `not_a_question` description flip. Crossing off or marking as paid an existing expense is now **something to add**, so the agent calls `not_a_question` and the app sends the sentence to `/parse`. Changing or deleting an expense still gets the "do that in the group" answer. The eval case "Cross off the Uber for Joe, I paid him" now expects `entry: true`.

### 5.5 Apps (web and Android)

- **Payment card** in the 4a box: "You paid Joe R 25,00" or "Joe paid you R 30,00", the items it covers with the amount for each, and Save and Cancel.
  - Issues are fixed on the card, as in 4a: pick an item, or untick one.
  - Saving posts the settlement with `covers`, with 4a's idempotency key and safe retry.
  - After it saves, the card fetches `open-items` again. If items are still open **in both directions**, it shows one line comparing the two open totals, e.g. "Counting what Joe owes you, Joe owes you R 5,00." That is the owner's "30 − 25". It's the difference between the open items on each side, not a new balance, and it's labelled that way. Nothing is shown when only one side has open items. It appears only on the card, not in Settle up.
- **Settle up:** under each transfer, a collapsed "What it covers" list of the open items from the payer to the receiver, each with a tick. Nothing is ticked by default.
  - Mark as paid sends the plan amount, as it does today, plus the ticked items as covers, oldest first, up to that amount.
  - If the ticked items add up to more than the payment, the last one is partly covered and the list says so before you save ("Uber: R 10,00 of R 25,00").
  - Foreign-currency payments keep `ForeignSettleFields`, and covers stay in the debt currency.
- **Recent payments (agreed):** a section under the transfers on Settle up, listing the last 20 payments in the group.
  - Each row reads like "You paid Joe R 25,00 · 21 Nov · for: Uber".
  - Each row has a Delete button, which asks "Delete this payment? Its items go back on the list" before deleting.
  - This is how a wrong cross-off is undone, and how an old payment is re-recorded with links.
  - The section shows even when everyone is settled up, as long as there are payments.
- **Notice and limits:** the 4a notice and rate limits apply unchanged. A payment sentence is one `/parse` call, like any entry.

## 6. Constraints

- The money rules are unchanged: amounts are integer minor units, formatted by `MoneyText`, and every POST needs an `Idempotency-Key`.
- OpenAPI and the api-client are regenerated (`KITTY_UPDATE_OPENAPI=1`, then `pnpm --filter @kitty/api-client generate`). The contract-drift CI check must pass.
- Red-Green TDD throughout. There are no new dependencies.
- The evals are extended:
  - `evals/nl/phrases.jsonl` gets payment sentences (the five in §2, plus a part payment, a "they paid" sentence and one that's ambiguous);
  - `evals/ask/questions.jsonl` case 6 flips to `entry: true`;
  - the ask world gets one linked payment, so "how much do I owe Joe" shows only the open items.

## 7. Left to the builder

- The EF configuration and migration names, and the DTO property order.
- How the largest-remainder rule breaks ties (it must be deterministic, e.g. by member id).
- The exact card and Settle up layout, following the existing components.
- How the "What it covers" list collapses on mobile.
