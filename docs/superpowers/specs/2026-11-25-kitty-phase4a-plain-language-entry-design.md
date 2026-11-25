# Kitty Phase 4a: plain-language entry and reminders

Status: draft for approval · 2026-11-25 · Parent: `2026-11-15-kitty-design.md` (§2 goals, §5.1 ai, feature 7)

## 1. Intent

People add expenses by typing one sentence instead of filling in a form, and remind someone of what they owe the same way. It serves both of Kitty's jobs:
- the owner's friends and family add things faster, including on the phone, where keyboard dictation turns speech into the same sentence;
- it is the first LLM feature people talk to directly, and it builds the ai service's public, signed-in surface that Ask Kitty (4b) and the MCP server (4c) reuse.

## 2. What people type (the owner's scenarios)

| Sentence | What it becomes |
|---|---|
| "add R2000 to expenses under groceries in the family group" | an expense in the named group, category groceries, split equally among everyone in it, you paid |
| "petrol R600, split with Sam and Ana" | an expense split equally between you, Sam and Ana, you paid |
| "me, John and Joe bought dinner, I had a salad for R50, Joe had a steak for R100 and John had the fish for R70" | "Dinner", R220,00, split by amounts (you R50, Joe R100, John R70), you paid |
| "add R20 debt for Bob" | a new debt: you paid R20,00, Bob's share R20,00 |
| "tell Bob he owes me R20" | a **reminder** to Bob about what he already owes you (no new expense) |

So one sentence is understood as one of four things: an equal split, a split by amounts, a single debt, or a reminder. Anything else, or anything only partly understood, opens the full expense form pre-filled as far as it got.

## 3. Goals, non-goals, anti-goals

**Goals**
- One box, reachable from the groups list and from inside a group, that takes a sentence and shows a confirmation card.
- Expenses: amount, currency, description, category, date, payer, participants and an equal or by-amounts split, matched to the group's real members.
- Reminders: Bob is told what he owes you in that group, by push and/or email per his settings, with a **Remind** button on the balances screen as the non-AI way to send one.
- Works on web and the Android app.

**Non-goals**
- Percent and shares splits, several payers, recurring expenses, and editing or deleting by sentence: the full form handles these; the card's **Edit** opens it.
- Itemized table mode by voice (a split by amounts covers "I had X, Joe had Y").
- Conversation or follow-up questions: one sentence in, one card out. Ask Kitty (4b) is the conversational feature.
- The full eval suite in CI (4d). 4a ships a small labelled set run by hand.

**Anti-goals**
- **The AI writing to the ledger or messaging someone without the person confirming.** Nothing is saved or sent until they tap Save or Send.
- **A wrong amount or a wrong person saved silently.** A name that matches nobody, or more than one person, is flagged on the card and blocks Save until it's picked; money is never a float.
- **Data from a group the person isn't in, via any path.** The ai service only ever reads the ledger with the person's own token.
- **A reminder with a number that isn't true,** or one that can be used to nag (§5.4).

## 4. Approaches

- **A. The ledger in front (app → ledger → ai):** the ai service stays private and name matching lives in C#, but it adds a synchronous ledger-to-ai call and gives 4b's chat nowhere natural to live.
- **B. The app calls the ai service directly with the person's login (chosen):** a new `/ai/` route, token checks in the ai service, and the ai service reads the ledger *as that person*. This matches the parent design's rule ("authorization is enforced by the ledger, not by the prompt") and is the setup 4b and 4c need.
- Dropped: a Kafka round trip like receipts (too slow while someone waits for a card), and calling Gemini from the ledger (duplicates the provider and Ollama fallback the ai service already has).

## 5. Design

### 5.1 Request flow

1. The app sends `POST /ai/parse` with `{ text, groupId? }` and the person's access token. `groupId` is the group page they're on, if any.
2. The ai service checks the token (Keycloak issuer, signature via JWKS, audience `kitty-ai`) and a per-person rate limit (§5.6).
3. It reads, **with the same token**, `GET /me` and `GET /groups` from the ledger, and `GET /groups/{id}` for the group it settles on (members). The ledger decides what the person can see.
4. It sends the model **only the sentence**, today's date (Africa/Johannesburg) and the candidate group's base currency. It does not send group names or member names: the model returns the names as written, and the ai service matches them locally (§5.3). The model has no tools and its answer must fit the schema (§5.2) or the request fails with "couldn't understand that".
5. The ai service resolves the group, the people and the money, and returns a **draft** (§5.5). It writes nothing.
6. The app shows the confirmation card. **Save** calls the ledger's existing `POST /groups/{groupId}/expenses`; **Edit** opens the full form pre-filled; **Send** (reminders) calls the new ledger endpoint (§5.4).
7. *(My call.)* When the person picks a different group on the card, the app calls **`POST /ai/resolve`** with the model's answer (`parsed`, returned with every draft, §5.5) and the picked `groupId`. This repeats steps 2, 3 and 5 **without the model**: no second Gemini call, no change in what the sentence was taken to mean, and it doesn't count towards the parse limit (it has its own, more generous limit). The ai service keeps nothing between the two calls.

The web app calls the ai service from its server side (a server action, like its ledger calls) at an internal `AI_URL`; the Android app calls `https://{host}/ai/parse` directly.

### 5.2 What the model returns (schema-checked)

```
intent: "expense" | "reminder" | "unclear"
group: string | null            # the group as written ("family", "rent house"), or null
description: string | null      # short, e.g. "Dinner", "Petrol", "Groceries"
category: one of the app's categories | null
currency: ISO code | null       # "R" → ZAR; null means the group's currency
amount: decimal string | null   # the total, when stated
date: YYYY-MM-DD | null         # "yesterday" resolved against the date given; null means today
payer: string | null            # a name as written, or "me"
people: [ { name: string, amount: decimal string | null } ]   # "me" for the speaker
split: "equal" | "amounts" | null
reminder_amount: decimal string | null   # the amount mentioned in a reminder, if any
```

Money comes back as decimal strings and is converted to minor units with the currency's exponent (`currencies.py`), never through floats. With split "amounts" and no stated total, the total is the sum of the people's amounts; with both, they must agree or the draft is flagged.

### 5.3 Matching names

All of this runs in the ai service, deterministically, and is unit-tested:
- **Group:** the sentence's group phrase is matched against the person's group names (case-insensitive, whole word or prefix, ignoring words like "group" and "the"). No group phrase uses `groupId` from the page. With neither, and the person in exactly one group, that one; otherwise the card asks which group.
- **"me", "I", "my":** the speaker's member in that group.
- **People:** each name is matched against that group's members' display names: exact, then first name, then prefix, case-insensitive. No match → flagged "not in this group"; several matches → flagged with the candidates to pick from. Placeholders count as members.
- **No people named** for an expense means everyone in the group; **no payer named** means you, shown plainly on the card.

### 5.4 Reminders

New ledger endpoint `POST /groups/{groupId}/reminders` with `{ memberId }`, Idempotency-Key as usual:
- **The amount is the ledger's own.** It is what that member pays the caller in the group's current settle-up plan (the `transfers` in `GET /groups/{id}/balances`), per currency. If the plan has no payment from them to the caller: 409 `nothing_owed`.
- **One reminder per sender, per reminded person, per group, per day** (UTC date) *(my call)*. If Bob owes both Alice and Carol, each of them can remind him once a day, but neither can more often. This is recorded in a `Reminders` table with the unique key (group, from member, to member, date); a second reminder returns 429 `already_reminded`.
- **The reminded member must have an account,** or there's no one to tell: 409 `no_account` for a placeholder.
- It queues a `NotificationRequested` of a new kind **REMINDER**, for example title "Flat 4B", body "Zakhir reminded you: you owe them R 150,00", link to the group, with the caller's display name and `MoneyText`. Several currencies join with " and ", as the weekly summary does.

Notification settings gain a **Reminders** row (push on, email off by default), with the label "Someone reminds you what you owe". pulse treats REMINDER like the other kinds.

The card for a reminder says "Remind Bob that he owes you R 150,00 in Flat 4B?" using the balance it reads with the person's token. If the sentence named a different amount, the card says so ("You said R20,00; Kitty's balance says R150,00"). **Send** goes to the endpoint above. The balances or settle-up screen gets a **Remind** button next to each person who owes the viewer, calling the same endpoint.

### 5.5 The draft and the card

The ai service returns either:
- **expense:** `{ groupId, description, category, currency, amountMinor, occurredOn, payerMemberId, split: equal|amounts, participants: [{ memberId, amountMinor? }] }`;
- **reminder:** `{ groupId, memberId, owedMinorByCurrency, statedAmountMinor? }`;
- **unclear:** with whatever was understood;

plus:
- `issues: [{ field, kind: no_match|ambiguous|missing|mismatch, text, candidates? }]`;
- `members: [{ id, displayName }]`, the chosen group's members, so the card can offer them;
- `groups: [{ id, name }]`, the person's groups, so the card can offer a different one;
- `parsed`, the model's answer as checked (§5.2), for `/ai/resolve`.

*(My call)* What the card offers for each issue:
- **ambiguous name:** pick one of its candidates;
- **name with no match:** pick any member of the group, or **Leave out**. For an equal split, leaving someone out shares the amount among the rest. For a split by amounts, their amount comes off the total, which the card shows again before Save;
- **missing or wrong group:** pick a group (calls `/ai/resolve`);
- **total doesn't match the amounts:** the card shows both and only offers **Edit**.

Card, for example:

```
Dinner · R 220,00 · today
Paid by you · split by amounts
You R 50,00 · Joe R 100,00 · John R 70,00
Flat 4B                         [Edit] [Save]
```

- **Save** is disabled while an issue is open. Picking a candidate or a group fixes it on the card.
- **Edit** opens the existing expense form with the draft (shared `ExpenseFormState` in `packages/core`, via a new `draftToForm` function).
- Below the box, one line says the sentence is sent to Google's Gemini, as the scan button already does.
- On mobile the box is an ordinary text field, so the keyboard's microphone works.

### 5.6 Limits, failure and privacy

- **Per person:** 30 parses an hour, in memory in the ai service (it runs one replica on the server). Over that: 429 with "try again later". The free Gemini key is shared with receipt scans (15 a minute, 500 a day).
- **No model configured, or Gemini down/throttled:** the box says the sentence couldn't be read right now and offers the full form. The rest of Kitty is unaffected.
- **Sent to Gemini:** the sentence, today's date and a currency code. Not group names, member names, balances or ids.
- **The sentence is untrusted data:** the system prompt says so, the model has no tools, and the output is schema-checked. A sentence that tries to make the model do something else just yields "unclear".
- **Logs:** the sentence is not logged, only the intent and timings.

### 5.7 Wiring

- **Keycloak:** an audience mapper `kitty-ai` on `kitty-web` and `kitty-mobile`, beside the existing `kitty-ledger` one. The deployed realm needs the same mapper added once by hand (RUNBOOK), as with earlier client changes.
- **Caddy:** `handle_path /ai/*` → `ai:8000` (the path prefix is stripped).
- **ai settings:** `AI_LEDGER_URL` (internal), `AI_AUTH_ISSUER`, `AI_AUTH_AUDIENCE=kitty-ai`.
- **Aspire:** a fixed ai HTTP port, also added to the mobile `android:reverse` script.
- **Compose:** the ai service gets the ledger URL and issuer.

### 5.8 Tests and evals

- **ai (pytest):**
  - the token check (good, wrong audience, expired);
  - name matching (exact, first name, prefix, ambiguous, none, "me", placeholders);
  - money conversion (exponents, amounts vs total);
  - group choice;
  - draft building from fixed model outputs, using a fake model and a fake ledger;
  - the rate limit;
  - an endpoint test through FastAPI's test client.
- **Labelled set:** about 30 sentences (`services/ai/evals/nl/`), including the five in §2, with an on-demand script reporting intent, amount and participant accuracy against the real model. Not run in CI (4d).
- **Ledger:** reminder endpoint tests covering the amount from transfers, `nothing_owed`, once a day, placeholder, other-group access (404), and the notification text; plus settings tests for the new row.
- **pulse:** the REMINDER kind uses the reminder settings.
- **Web and mobile:** the card renders each intent, Save posts the draft, Edit pre-fills the form, issues block Save, and Remind and Send call the endpoint.

## 6. Left to the builder

- Exact prompt wording and the pydantic model for §5.2 (the fields are fixed above).
- The name-matching tie-breaks within the rules of §5.3.
- How the web app hands a draft to the form page without putting the sentence or amounts in a URL (logs). For example: client state, or a short-lived server-side store.
- Layout and styling of the box and card within the existing design system.
- Library choices for JWT/JWKS in Python (one small, maintained library; ask before adding others).
