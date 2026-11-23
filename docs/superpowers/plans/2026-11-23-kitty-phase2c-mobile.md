# Kitty Phase 2c — Mobile App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Expo app (Android first) with web parity for signed-in users, plus camera receipt capture and links that open in the app.

**Architecture:**
- The web app's framework-free logic moves to `packages/core` (`@kitty/core`), shared by web and mobile.
- `apps/mobile` is Expo Router screens on top of `@kitty/api-client`, `@kitty/money` and `@kitty/core`. It talks to the ledger directly with a Keycloak token obtained on the phone (Authorization Code + PKCE, public client `kitty-mobile`).
- Live tables use the existing SignalR hub.

**Tech Stack:**
- Expo SDK 58 (React Native 0.88.1, React 19.3.0), Expo Router, TypeScript 5.9.3
- `expo-auth-session` + `expo-secure-store`
- `@microsoft/signalr` 10.0.11
- jest-expo + React Native Testing Library
- vitest for `@kitty/core`
- GitHub Actions Gradle build for the APK

**Spec:** `docs/superpowers/specs/2026-11-23-kitty-phase2c-mobile-design.md`

## Global Constraints

- New dependencies (exact pins; owner approves this list with the plan):
  - **Runtime:**
    - `expo@58.0.26`, `expo-router@58.0.32`, `react@19.3.0`, `react-native@0.88.1`
    - `expo-auth-session@58.0.19`, `expo-secure-store@58.0.3`, `expo-web-browser@58.1.0`, `expo-crypto@58.0.8`
    - `expo-linking@58.0.17`, `expo-constants@58.0.16`, `expo-status-bar@58.0.5`
    - `expo-image-picker@58.0.10`, `expo-image-manipulator@58.0.16`
    - `expo-network@58.0.5`, `expo-clipboard@58.0.4`, `expo-dev-client@58.0.21`
    - `react-native-safe-area-context@5.11.1`, `react-native-screens@4.30.1`
    - `react-native-svg@15.16.0`, `react-native-qrcode-svg@6.3.54`
    - `@microsoft/signalr@10.0.11` (same as web)
  - **Dev:** `jest@30.5.2`, `jest-expo@58.0.15`, `@testing-library/react-native@14.1.0`, `test-renderer@1.3.1`, `@types/jest@30.0.0`, `@types/react@19.3.0`
  - Anything else needs the owner's OK first.
- Tokens are stored only via `expo-secure-store`. Never in AsyncStorage, logs, error messages or URLs.
- Every mutation carries an Idempotency-Key. A form keeps one key until it succeeds, so double taps and retries replay instead of duplicating.
- Every screen action goes through core's `settle()`. A thrown fetch becomes the `"network"` error, and no button stays busy.
- Money comes only from `@kitty/money` (`formatMoney`, `parseMoney`, split previews). No float arithmetic on amounts.
- Copy reuses core's `errorMessage` / `scanStatusMessage` text verbatim.
- Web behaviour unchanged: web's existing tests pass with import-path edits only.
- Conventional commits, one logical change each. No attribution lines.
- Mobile Keycloak redirect URI is exactly `kitty://auth/callback`; the scheme is `kitty`; the Android package is `za.kitty.app`.
- Local dev ports (fixed):
  - Keycloak `8180` (already fixed)
  - ledger `5080`
  - Azurite blob `10000`
  - web `3000`

## Review Focus

1. **An app reopened after hours, with an expired access token.** The first request must refresh first, not fail; timers don't run in the background. *Test:* Task 4 `getAccessToken refreshes when the token expires within 60 s`.
2. **Save tapped twice, or retried after a network error.** It must create one expense, not two. *Test:* Task 7 `retrying a failed save reuses the same Idempotency-Key`.
3. **Network drops during a table action.** An error shows and the buttons come back. *Test:* Task 11 `a thrown lock request shows the network error and re-enables Lock`.
4. **A link to a group or table the user can't see, or a malformed id** (`kitty://t/not-a-uuid`). It must show "We couldn't find that.", not crash. *Test:* Task 10 `malformed table link shows not found`.
5. **The user cancels or backs out of the Keycloak browser.** The app stays on sign-in with no error and no half-stored tokens. *Test:* Task 4 `cancelled sign-in stores nothing and shows no error`.

---

### Task 1: Expo workspace skeleton that bundles

**Files:**
- Create:
  - `apps/mobile/package.json`, `app.config.ts`, `tsconfig.json`, `babel.config.js`, `metro.config.js`, `jest.config.js`
  - `apps/mobile/src/app/_layout.tsx`, `apps/mobile/src/app/index.tsx`
  - `apps/mobile/src/config.ts`
- Test: `apps/mobile/test/smoke.test.tsx`
- Modify: `pnpm-lock.yaml`, `.gitignore` (`apps/mobile/android`, `apps/mobile/ios`, `.expo`)

**Interfaces:**
- Produces:
  - `config: { apiUrl: string; authIssuer: string; webUrl: string; hubUrl: string }` from `src/config.ts`.
  - Values come from `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_AUTH_ISSUER`, `EXPO_PUBLIC_WEB_URL`.
  - Dev defaults: `http://localhost:5080`, `http://localhost:8180/realms/kitty`, `http://localhost:3000`.
  - `hubUrl` = `${apiUrl}/hubs/table`.
- Package scripts: `start` (`expo start --dev-client`), `android` (`expo run:android`), `test` (`jest`), `typecheck` (`tsc --noEmit`), `export` (`expo export --platform android --output-dir dist`), `android:reverse`.

Steps:
- [ ] **Step 1: Write the failing test.** `smoke.test.tsx` renders `index.tsx` and asserts text `formatMoney(12345, "ZAR")` from `@kitty/money` is on screen. This proves workspace packages resolve under jest.
- [ ] **Step 2: Run it and see it fail.** Run `pnpm --filter mobile test`. Expected: FAIL (no app yet).
- [ ] **Step 3: Scaffold the app.**
  - `app.config.ts`: name "Kitty", slug `kitty`, scheme `kitty`, `android.package` `za.kitty.app`, plugins `expo-router`, `expo-secure-store`, `expo-image-picker` (camera permission text "Kitty uses the camera to read receipts."), `newArchEnabled` default.
  - Metro: use `expo/metro-config` defaults (SDK 58 handles pnpm workspaces); add `watchFolders` only if the bundle fails.
  - `android:reverse`: `adb reverse tcp:8180 tcp:8180 && adb reverse tcp:5080 tcp:5080 && adb reverse tcp:10000 tcp:10000 && adb reverse tcp:3000 tcp:3000`.
- [ ] **Step 4: Run the tests.** `pnpm --filter mobile test` passes. `pnpm -r typecheck` passes.
- [ ] **Step 5: Prove one React in the bundle.**
  - Run `pnpm --filter mobile export`. Expected: it exits 0.
  - Run `pnpm --filter mobile why react`. Expected: only `react@19.3.0`.
  - Task 15's emulator run is the final check: a second React shows up there as "Invalid hook call".
  - Run `pnpm --filter web build`. It still passes; web keeps React 19.3.1.
- [ ] **Step 6: Commit.** `chore(mobile): Expo SDK 58 app skeleton in the workspace`

### Task 2: `@kitty/core` — move shared logic out of web

**Files:**
- Create: `packages/core/package.json`, `tsconfig.json`, `src/index.ts`.
- Move (`git mv`), from `apps/web/src/lib/*` to `packages/core/src/*`:
  - `table-state.ts`, `live-connection.ts`, `expense-form.ts`, `receipt-upload.ts`, `errors.ts`, `settle.ts`, `ids.ts`
  - their tests, from `apps/web/test/*` to `packages/core/test/*`: `table-state`, `live-connection`, `expense-form`, `receipt-upload`
- Modify: every web import of those (listed by `grep -rn '@/lib/\(table-state\|live-connection\|expense-form\|receipt-upload\|errors\|settle\|ids\)'`), to `@kitty/core`. Also `apps/web/package.json` (`"@kitty/core": "workspace:*"`) and `apps/web/test/table-client.test.ts` (imports `isUuid`).

**Interfaces:**
- Produces: `@kitty/core` exporting, unchanged:
  - from table-state: `TableSession`, `Closed`, `TableState`, `TableEvent`, `initialTableState`, `needsRefresh`, `tableReducer`, `retryDelayMs`, `myShare`, `tipToMinor`
  - from live-connection: `LiveHub`, `LiveDeps`, `keepLive`
  - from expense-form: `CATEGORIES`, `ParticipantInput`, `ExpenseFormState`, `parsePercentToBasisPoints`, `toExpenseWriteDto`
  - from receipt-upload: `PHOTO_TYPES`, `MAX_PHOTO_BYTES`, `SLOW_SCAN_MS`, `ScanView`, `uploadReceipt`, `scanStatusMessage`, `rowsAction`
  - from errors, settle and ids: `errorMessage`, `settle`, `isUuid`

Steps:
- [ ] **Step 1:** `git mv` the files, create the package (vitest 5.1.0 and typescript 5.9.3, the same as api-client), and update the imports. Make no logic edits.
- [ ] **Step 2: Run the tests.** `pnpm -r typecheck && pnpm -r test && pnpm --filter web build`. Expected: all pass, with the same test count as before the move (web 100 = core's moved tests + web's remaining tests).
- [ ] **Step 3: Commit.** `refactor(core): move web's framework-free logic into @kitty/core`

### Task 3: `uploadReceipt` takes a platform-neutral photo

**Files:** Modify `packages/core/src/receipt-upload.ts`, `packages/core/test/receipt-upload.test.ts`, `apps/web/src/components/table/ReceiptScan.tsx`.

**Interfaces:**
- Produces:
  - `type PhotoInput = { type: string; size: number; body: BodyInit }`
  - `uploadReceipt(photo: PhotoInput, start, confirm, put?)` (start, confirm and put keep their current types)
  - Web passes `{ type: file.type, size: file.size, body: file }`.

Steps:
- [ ] **Step 1: Write the failing test.** `uploadReceipt PUTs the photo body with its content type`: given `{ type: "image/jpeg", size: 3, body: blob }`, the fake `put` receives `body === blob` and header `Content-Type: image/jpeg`. Change the existing tests to build `PhotoInput`.
- [ ] **Step 2: Run it and see it fail.** `pnpm --filter @kitty/core test`. Expected: FAIL (type or argument mismatch).
- [ ] **Step 3: Implement.** Change the parameter and update `ReceiptScan.tsx`.
- [ ] **Step 4: Run the tests.** `pnpm -r typecheck && pnpm -r test`. Expected: PASS.
- [ ] **Step 5: Commit.** `refactor(core): uploadReceipt takes a photo body instead of a DOM File`

### Task 4: Keycloak mobile client and sign-in on the phone

**Files:**
- Modify:
  - `infra/keycloak/kitty-realm.json`: add client `kitty-mobile`.
  - `aspire/Kitty.AppHost/AppHost.cs`: ledger `WithHttpEndpoint(port: 5080, …)` and Azurite blob port `10000`.
- Create:
  - `apps/mobile/src/auth/tokens.ts`, `apps/mobile/src/auth/AuthProvider.tsx`
  - `apps/mobile/src/app/sign-in.tsx`
  - `apps/mobile/src/ledger.ts`
- Test: `apps/mobile/test/auth/tokens.test.ts`, `apps/mobile/test/auth/sign-in.test.tsx`

**Interfaces:**
- **Realm client `kitty-mobile`:**
  - `publicClient: true`, `standardFlowEnabled: true`, `directAccessGrantsEnabled: false`
  - `attributes.pkce.code.challenge.method: "S256"`
  - `redirectUris: ["kitty://auth/callback"]`, `webOrigins: []`
  - post-logout redirect `kitty://auth/callback`
  - the same `oidc-audience-mapper` (`kitty-ledger`) as `kitty-web`
- **`tokens.ts`** (pure, injectable):
  ```ts
  type Tokens = { accessToken: string; refreshToken: string; expiresAt: number /* epoch s */; idToken?: string };
  type TokenDeps = { store: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void>; remove(k: string): Promise<void> };
                     refresh: (refreshToken: string) => Promise<Tokens>; now: () => number };
  createTokenKeeper(deps: TokenDeps): {
    load(): Promise<Tokens | null>;
    save(t: Tokens): Promise<void>;
    getAccessToken(): Promise<string>;   // refreshes when expiresAt - now < 60; throws SignedOut when refresh fails or nothing stored
    clear(): Promise<void>;
  }
  class SignedOut extends Error {}
  ```
  Concurrent `getAccessToken` calls share one in-flight refresh.
- **`AuthProvider`:** context `{ status: "loading" | "signedOut" | "signedIn"; signIn(): Promise<void>; signOut(): Promise<void>; getAccessToken(): Promise<string>; notice: string | null }`.
  - It uses `expo-auth-session` discovery from `config.authIssuer`, with `usePKCE: true` and redirect `makeRedirectUri({ scheme: "kitty", path: "auth/callback" })`.
  - `SignedOut` from any request sets `status: "signedOut"` and `notice: "You've been signed out. Sign in again."`.
  - `signOut` calls the end-session endpoint with `id_token_hint`, then `clear()`.
- **`ledger.ts`:** `useLedger(): LedgerClient`, which is `createLedgerClient(config.apiUrl, getAccessToken)`, memoised.

Steps:
- [ ] **Step 1: Write the failing tests** (`tokens.test.ts`):
  - `getAccessToken returns the stored token while it has more than 60 s left`
  - `getAccessToken refreshes when the token expires within 60 s`: asserts the new tokens are saved to the store.
  - `two concurrent calls refresh once`
  - `a failed refresh clears the store and throws SignedOut`
  - `nothing stored throws SignedOut`
- [ ] **Step 2: Run them and see them fail.** `pnpm --filter mobile test tokens`. Expected: FAIL.
- [ ] **Step 3: Implement** `tokens.ts`. The store is `expo-secure-store` in the app and an in-memory map in tests.
- [ ] **Step 4: Write the failing tests** (`sign-in.test.tsx`, with the auth-session request mocked):
  - `cancelled sign-in stores nothing and shows no error`: the prompt returns `{ type: "cancel" }`.
  - `successful sign-in stores tokens and routes to /groups`.
  - `the signed-out notice is shown after a forced sign-out`.
- [ ] **Step 5: Implement** `AuthProvider`, `sign-in.tsx` and `_layout.tsx` gating (signed out redirects to `/sign-in`). Run `pnpm --filter mobile test`. Expected: PASS.
- [ ] **Step 6: Verify the realm.** Start Aspire, then:
  - `curl -s -o /dev/null -w "%{http_code}" "http://localhost:8180/realms/kitty/protocol/openid-connect/auth?client_id=kitty-mobile&response_type=code&redirect_uri=kitty%3A%2F%2Fauth%2Fcallback&code_challenge=abc&code_challenge_method=S256&scope=openid"` → `200` (the login page).
  - The same request with `redirect_uri=kitty%3A%2F%2Fevil` → `400`.
  - Check `curl -s http://localhost:5080/health` → 200 on the fixed port.
- [ ] **Step 7: Commit, in two commits.** `feat(keycloak): public kitty-mobile client with PKCE`; then `feat(mobile): sign in with Keycloak, tokens in the secure store`.

### Task 5: Shared screen plumbing, plus the groups list and creating a group

**Files:**
- Create:
  - `apps/mobile/src/components/ErrorBanner.tsx`, `Screen.tsx`, `Button.tsx`, `TextField.tsx`
  - `apps/mobile/src/theme.ts`
  - `apps/mobile/src/hooks/useAction.ts`
  - `apps/mobile/src/app/groups/index.tsx`, `apps/mobile/src/app/groups/new.tsx`
- Test: `apps/mobile/test/groups.test.tsx`, `apps/mobile/test/useAction.test.tsx`

**Interfaces:**
- **`theme.ts`:** colours, spacing and type sizes copied from `apps/web/src/app/globals.css` and the Tailwind classes web uses.
- **`useAction`:**
  ```ts
  useAction<T>(fn: (idempotencyKey: string) => Promise<{ data?: T; error?: unknown; response: Response }>):
    { run(): Promise<T | null>; busy: boolean; error: string | null /* errorMessage text */; reset(): void }
  ```
  - It wraps `fn` in `settle` semantics: a throw becomes `errorMessage("network")`.
  - It keeps one `idempotencyKey` (from `expo-crypto` `randomUUID`) until a success, then makes a new one.
  - A ledger problem body's `code` is mapped through `errorMessage`.
- **`ErrorBanner`:** `{ message: string | null }`.

Steps:
- [ ] **Step 1: Write the failing tests:**
  - `useAction`:
    - `a thrown request yields the network message and busy=false`
    - `retrying after an error reuses the key`
    - `the key changes after a success`
  - `groups.test.tsx` (fake ledger):
    - `lists groups with each balance formatted in the group currency`
    - `empty list shows "No groups yet"`
    - `creating a group posts name+currency and opens it`
- [ ] **Step 2: Run them and see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Groups list (`GET /groups`, pull to refresh). New group (name, currency picker from `@kitty/money` currencies, default ZAR). Sign out is in the header menu.
- [ ] **Step 4: Run the tests and typecheck.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(mobile): groups list and new group`

### Task 6: Group home, balances and activity

**Files:**
- Create:
  - `apps/mobile/src/app/groups/[id]/_layout.tsx` (tabs: Expenses, Balances, Activity, Members)
  - `apps/mobile/src/app/groups/[id]/index.tsx`, `balances.tsx`, `activity.tsx`
- Test: `apps/mobile/test/group-home.test.tsx`

**Interfaces:**
- **Consumes:** `useLedger`, `useAction`, `ErrorBanner`.
- **Expenses:** `GET /groups/{groupId}/expenses` with the page cursor from `ExpensePageDto`. Infinite scroll uses `onEndReached`.
- **Balances:** `GET /groups/{groupId}/balances`.
- **Activity:** `GET /groups/{groupId}/activity`.

Steps:
- [ ] **Step 1: Write the failing tests:**
  - `expenses list loads the next page at the end`
  - `balances show who owes whom with formatMoney`
  - `a 404 group shows "We couldn't find that."`
  - `activity lists entries newest first as returned`
- [ ] **Step 2: Run, implement, re-run.** Expected: FAIL before the implementation, PASS after.
- [ ] **Step 3: Commit.** `feat(mobile): group home with expenses, balances and activity`

### Task 7: Add, edit and delete expenses

**Files:**
- Create:
  - `apps/mobile/src/components/ExpenseForm.tsx`
  - `apps/mobile/src/app/groups/[id]/expenses/new.tsx`, `apps/mobile/src/app/groups/[id]/expenses/[expenseId].tsx`
- Test: `apps/mobile/test/expense-form.test.tsx`

**Interfaces:**
- **Consumes:** `ExpenseFormState`, `toExpenseWriteDto`, `CATEGORIES`, `parsePercentToBasisPoints` from core; `formatMoney`, `parseMoney`, `previewSplit`, `supportedCurrencies` and `SplitMethod` from `@kitty/money` (the same ones web's `ExpenseForm.tsx` imports); `useAction`.
- **Form fields and split methods:** the same as web's `ExpenseForm.tsx` (equal, exact, percent, shares and the other non-itemized methods web offers).
- **Requests:**
  - Create: `POST /groups/{groupId}/expenses`, with a client-generated `id` set once per form.
  - Edit: `PUT /groups/{groupId}/expenses/{expenseId}`, with version for a conflict check.
  - Delete: `DELETE /groups/{groupId}/expenses/{expenseId}`, after a confirm dialog.

Steps:
- [ ] **Step 1: Write the failing tests:**
  - `retrying a failed save reuses the same Idempotency-Key`: first `put` throws, second succeeds; both requests carry the same key and the same expense id.
  - `an exact split that doesn't add up shows the split_sum_mismatch message before sending`
  - `editing sends the version and shows version_conflict text on 409`
  - `delete asks for confirmation and returns to the group`
- [ ] **Step 2: Run, implement, re-run.** Expected: FAIL before the implementation, PASS after.
- [ ] **Step 3: Commit.** `feat(mobile): add, edit and delete expenses`

### Task 8: Settle up

**Files:**
- Create: `apps/mobile/src/app/groups/[id]/settle.tsx`
- Test: `apps/mobile/test/settle.test.tsx`

**Interfaces:**
- Behaviour mirrors web's `groups/[id]/settle/page.tsx`: suggested transfers from balances, showing the payee's payment details.
- Recording calls `POST /groups/{groupId}/settlements`; undoing calls `DELETE …/settlements/{settlementId}`.

Steps:
- [ ] **Step 1: Write the failing tests:**
  - `suggested transfer shows amount and the payee's payment details`
  - `marking paid records a settlement and refreshes balances`
- [ ] **Step 2: Run, implement, re-run.** Expected: FAIL before the implementation, PASS after.
- [ ] **Step 3: Commit.** `feat(mobile): settle up`

### Task 9: Members, invites and my details

**Files:**
- Create:
  - `apps/mobile/src/app/groups/[id]/members.tsx`
  - `apps/mobile/src/app/invite/[token].tsx`
- Test: `apps/mobile/test/members.test.tsx`, `apps/mobile/test/invite.test.tsx`

**Interfaces:**
- **Members screen** (as web's `members/page.tsx`):
  - members list
  - add placeholder (`POST /groups/{groupId}/members`)
  - create invite (`POST /groups/{groupId}/invites`), then share `${config.webUrl}/invite/${token}` with React Native's `Share.share` (no new dependency) and offer copy (`expo-clipboard`)
  - edit my name and payment details (`PATCH /me`)
- **Invite screen:** preview (`GET /invites/{token}`); accept, optionally claiming a placeholder (`POST /invites/{token}/accept`); then open the group. Reached by the `kitty://invite/<token>` and `https://…/invite/<token>` links (Expo Router maps the path).

Steps:
- [ ] **Step 1: Write the failing tests:**
  - `invite creates a link and opens the share sheet with it`
  - `adding a placeholder shows them in the list`
  - `invite preview lists claimable placeholders`
  - `accepting an expired invite shows invite_expired text`
- [ ] **Step 2: Run, implement, re-run.** Expected: FAIL before the implementation, PASS after.
- [ ] **Step 3: Commit.** `feat(mobile): members, invites and my details`

### Task 10: Table mode, the claiming side, live

**Files:**
- Create:
  - `apps/mobile/src/hooks/useTableSession.ts`
  - `apps/mobile/src/app/groups/[id]/table/new.tsx`
  - `apps/mobile/src/app/groups/[id]/table/[sessionId].tsx`
  - `apps/mobile/src/app/t/[sessionId].tsx` (redirects to the group route using `?g=`)
  - `apps/mobile/src/components/table/ItemList.tsx`, `apps/mobile/src/components/table/ClaimTable.tsx`
- Test: `apps/mobile/test/table-claim.test.tsx`, `apps/mobile/test/useTableSession.test.tsx`

**Interfaces:**
- **Consumes:** `keepLive`, `LiveHub`, `tableReducer`, `initialTableState`, `needsRefresh`, `retryDelayMs`, `myShare` from core.
- **`useTableSession(initial: TableSession, groupId: string)`** returns the same shape as web's hook.
  - It fetches the bill with `GET /groups/{g}/table-sessions/{s}` and the listen token with `GET …/listen-token` via `useLedger`. A 404 means `null`.
  - Its hub is `HubConnectionBuilder().withUrl(config.hubUrl, { accessTokenFactory })`.
  - It resyncs on `AppState` → `active` and on `expo-network` reconnects.
- **Claim:** `PUT|DELETE …/items/{itemId}/claim`, through `useAction`.
- **New table:** `POST /groups/{groupId}/table-sessions` (fields as in web's `table/new/page.tsx`).

Steps:
- [ ] **Step 1: Write the failing tests:**
  - `a hub change event triggers one re-fetch`
  - `returning to the foreground re-fetches`
  - `a confirmed bill ends the live connection and shows the final share`
  - `tapping an item claims it and shows my share`
  - `malformed table link shows not found`: route param `not-a-uuid`; no request is sent.
- [ ] **Step 2: Run, implement, re-run.** Expected: FAIL before the implementation, PASS after.
- [ ] **Step 3: Commit.** `feat(mobile): live table mode for members`

### Task 11: Table mode, the host side

**Files:**
- Create: `apps/mobile/src/components/table/HostTable.tsx`, `apps/mobile/src/components/table/JoinQr.tsx`
- Modify: `apps/mobile/src/app/groups/[id]/table/[sessionId].tsx` (the host sees `HostTable`)
- Test: `apps/mobile/test/table-host.test.tsx`

**Interfaces:**
- Behaviour mirrors web's `HostTable.tsx`:
  - items editing (`PUT …/items`) with core's `rowsAction`
  - tip and charges (`PUT …/charges`, `tipToMinor`)
  - lock, unlock and cancel (`POST …/lock|unlock|cancel`)
  - guest mapping (`POST …/guests/{guestId}/map`)
  - confirm (`POST …/confirm`)
- **`JoinQr`:** `react-native-qrcode-svg` showing `${config.webUrl}/t/${sessionId}?g=${groupId}` (the same link as web's `tableLink`), with a Share button.

Steps:
- [ ] **Step 1: Write the failing tests:**
  - `a thrown lock request shows the network error and re-enables Lock`
  - `unedited item rows follow a bill a scan just filled`
  - `Confirm and split is disabled while nobody has claimed anything, or a guest who claimed is unmatched`. This is web's rule: `preview.length === 0 || unmatchedGuests.length > 0`, with the same hint texts.
  - `QR encodes the web table link with the group id`
- [ ] **Step 2: Run, implement, re-run.** Expected: FAIL before the implementation, PASS after.
- [ ] **Step 3: Commit.** `feat(mobile): host a table`

### Task 12: Receipt scanning with the camera

**Files:**
- Create: `apps/mobile/src/components/table/ReceiptScan.tsx`, `apps/mobile/src/lib/photo.ts`
- Test: `apps/mobile/test/receipt-scan.test.tsx`, `apps/mobile/test/photo.test.ts`

**Interfaces:**
- **`preparePhoto(uri: string): Promise<PhotoInput>`** (in `photo.ts`):
  - `expo-image-manipulator` resizes to a longest side of 2000 px and outputs JPEG at compress `0.8`.
  - It then `fetch(result.uri)` → `blob` and returns `{ type: "image/jpeg", size: blob.size, body: blob }`.
- **`ReceiptScan`:**
  - Buttons "Take photo" (`launchCameraAsync`) and "Choose photo" (`launchImageLibraryAsync`).
  - The upload goes through `uploadReceipt(photo, start, confirm)`:
    - `start` calls `POST …/scans` with `{ id: randomUUID(), contentType }` and returns `{ scanId, uploadUrl }`.
    - `confirm` calls `POST …/scans/{scanId}/uploaded`.
  - Status comes from `scanStatusMessage`. "Use them" calls `POST …/scans/{scanId}/apply`.
  - A denied camera permission shows "Allow camera access in Settings, or choose a photo instead."

Steps:
- [ ] **Step 1: Write the failing tests:**
  - `preparePhoto always yields image/jpeg under MAX_PHOTO_BYTES`
  - `a cancelled picker sends nothing`
  - `denied camera permission shows the settings hint and keeps Choose photo`
  - `parsed scan with a suggestion offers Use them and applies it`
- [ ] **Step 2: Run, implement, re-run.** Expected: FAIL before the implementation, PASS after.
- [ ] **Step 3: Commit.** `feat(mobile): scan a receipt with the camera`

### Task 13: Android App Links

**Files:**
- Create: `apps/web/src/app/.well-known/assetlinks.json/route.ts`
- Test: `apps/web/test/assetlinks.test.ts`
- Modify:
  - `apps/mobile/app.config.ts`: `android.intentFilters` for `https://${host}/invite/*` and `/t/*`, with `autoVerify: true`, host taken from `EXPO_PUBLIC_WEB_URL`.
  - `deploy/compose/docker-compose.yml` and `.env.example`: `ANDROID_CERT_SHA256=` (optional).

**Interfaces:**
- **`GET /.well-known/assetlinks.json`:** without `ANDROID_CERT_SHA256` it returns 404. With it, it returns `[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"za.kitty.app","sha256_cert_fingerprints":["<value>"]}}]` with `Content-Type: application/json`.

Steps:
- [ ] **Step 1: Write the failing tests:**
  - `404 without ANDROID_CERT_SHA256`
  - `returns the statement for za.kitty.app with the fingerprint`
- [ ] **Step 2: Run, implement, re-run.** `pnpm --filter web test`. Expected: FAIL before the implementation, PASS after.
- [ ] **Step 3: Check Caddy.** Confirm the Caddyfile catch-all already proxies `/.well-known/*` to web, and that nothing earlier matches it. Note it in the commit body.
- [ ] **Step 4: Commit.** `feat(web): Android App Links statement, switched on by ANDROID_CERT_SHA256`

### Task 14: CI and the APK build

**Files:**
- Modify: `.github/workflows/web.yml`: add `pnpm --filter mobile export` after the tests. Mobile typecheck and tests already run via `pnpm -r`.
- Create: `.github/workflows/android.yml`

**Interfaces:**
- **`android.yml`:**
  - Triggers: `workflow_dispatch` and tags `mobile-v*`.
  - Steps:
    1. Set up JDK 17 (`actions/setup-java`, temurin) and Node 24 / pnpm, as in web.yml.
    2. `pnpm install --frozen-lockfile`.
    3. `pnpm --filter mobile exec expo prebuild --platform android --no-install`.
    4. Decode `ANDROID_KEYSTORE_BASE64` to `android/app/release.keystore`.
    5. Run `./gradlew assembleRelease` with `-Pandroid.injected.signing.*` from the secrets `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
    6. Upload `app-release.apk` as an artifact; on a tag, also attach it to the GitHub Release.
  - `EXPO_PUBLIC_*` come from repo variables (not secrets); `EXPO_PUBLIC_WEB_URL=https://kitty-split.duckdns.org`.
  - Actions are pinned by commit SHA, like the existing workflows.
- **Keystore:** generated once locally with `keytool` (JDK 17, `-keyalg RSA -keysize 2048 -validity 10000 -alias kitty`).
  - **Ask the owner before generating it**, because it is a signing identity.
  - The owner runs `gh secret set` for the four secrets themselves.
  - The keystore file is kept outside the repo; the owner keeps a backup, since losing it means users must reinstall.
  - The SHA-256 fingerprint goes in `ANDROID_CERT_SHA256` (Task 13).

Steps:
- [ ] **Step 1:** Add the export step. Push and check that the web workflow passes on the PR.
- [ ] **Step 2:** Write `android.yml`. Ask the owner, generate the keystore, and hand the owner the four `gh secret set` commands.
- [ ] **Step 3: Run the build.** `gh workflow run android.yml --ref feat/phase2c-mobile`. Expected: success, with an `app-release.apk` artifact. Install it on the emulator (`adb install`) and check that it starts.
- [ ] **Step 4: Commit, in two commits.** `ci(mobile): bundle check on every PR`; then `ci(mobile): signed release APK from GitHub Actions`.

### Task 15: Run it for real, and the docs

**Files:**
- Modify: `README.md` (mobile section), `deploy/compose/RUNBOOK.md` (APK download, `ANDROID_CERT_SHA256`)
- Create: `apps/mobile/README.md`. It covers:
  - prerequisites: the Android SDK, JDK 17 via Android Studio's JBR, and `adb` on the PATH
  - `pnpm --filter mobile android:reverse`
  - `pnpm --filter mobile android`

Steps:
- [ ] **Step 1: Start the stack.** Start Aspire, boot the emulator, run `android:reverse`, then `pnpm --filter mobile android` (the dev build).
- [ ] **Step 2: Run the spec's §5.6 end-to-end list on the emulator.** Use a second user on web at `localhost:3000` for the invite and the live table. For the scan, push `services/ai` test fixture photos with `adb push` and use "Choose photo". Note each step's result for the PR.
- [ ] **Step 3: Write the docs.**
- [ ] **Step 4: Commit.** `docs(mobile): run the app locally and install the APK`
- [ ] **Step 5: Open the PR** for `feat/phase2c-mobile`, with the end-to-end results in the body.
