# Kitty Phase 2c: Mobile App (Expo), Design

Status: draft for owner approval. Builds on the [overall design](2026-11-15-kitty-design.md), §5.1 "mobile" and §9 phase 2.

## 1. Intent

Kitty is mobile-first: the people using it are in South Africa, splitting costs on their phones, often at a table. Today
the only client is the Next.js web app. 2c adds a native app (Android first, iOS-capable code) that does **everything
the web app does**. The owner chose full parity over a smaller first slice. The phone adds what a browser does badly:
taking the receipt photo with the camera, and opening Kitty links (invites, tables) straight in the app.

It is also a portfolio piece. It shows React Native/Expo, native OAuth (PKCE) and a monorepo that shares real logic
between web and mobile.

## 2. Goals, non-goals, anti-goals

**Goals**
- Feature parity with the web app for signed-in users:
  - groups: the list, create
  - group home: expenses, balances
  - add, edit and delete expenses with every split type
  - settle up
  - activity
  - members: invite link, placeholders, claiming a placeholder
  - accepting an invite
  - table mode, both as host (items, charges, lock, confirm, cancel, the QR code for others to join) and as a member
    claiming items
  - receipt scanning from the camera or the photo library
  - sign out
- Live table updates over the existing SignalR hub, with the same never-go-stale behaviour as web.
- One copy of the tricky client logic (table state, live reconnects, expense form rules, receipt upload, error text),
  shared by web and mobile in a new `packages/core`.
- Runs locally against the Aspire stack on the Android emulator (or a USB phone).

**Non-goals (later phases or never)**
- Push notifications (phase 3). Offline add-expense queue (phase 6). Ask Kitty / NL entry (phase 4).
- Joining a table as a *guest* in the app. Guests don't have accounts; they keep using the web page the QR code
  opens. App users who scan the QR are signed in, so they join as members.
- App Store publishing (US$99/yr, see overall design §2). iOS builds aren't tested in 2c: there's no Mac, and device
  builds need an Apple account. The code stays cross-platform.
- A new visual design. Mobile follows the web app's existing look (colours, type scale, spacing) in native components.
- Any ledger API change beyond what the mobile client strictly needs (listed in §6).

**Anti-goals (failure even if it works)**
- A balance or split on the phone that differs from web for the same data: same API, same `@kitty/money`, same
  `packages/core` rules.
- Tokens anywhere except the OS secure store (no AsyncStorage, no logs, no crash reports).
- A table screen that silently stops updating, or a button that stays busy after the network drops (the 2b `settle()`
  rule applies).
- Web behaviour changing because of the refactor: web's 100 tests stay green unchanged, apart from import paths.

## 3. Constraints

- Free only. No paid Expo/EAS plan, and no Apple account.
- New dependencies are listed with exact versions in the plan for the owner to approve (global rule). The latest
  stable Expo SDK at build time, pinned exactly.
- pnpm workspace monorepo (pnpm 12, Node 24). The web app is on React 19.3.1. Expo pins its own React and React Native
  versions, so the workspace must not end up with two Reacts in one bundle. The plan's first task proves the
  workspace builds and bundles before any screens are written.
- Windows dev machine. The Android SDK and an emulator are installed, but `adb` is not on the PATH. The PATH has
  JDK 8, while Android builds need JDK 17+ (Android Studio's bundled JBR works).
- The ledger validates the token issuer exactly (`Auth:Authority`). Locally that is `http://localhost:8180/realms/kitty`,
  so the emulator must reach Keycloak as `localhost` too. `adb reverse` does that.
- TDD (red-green) for logic and screens, conventional commits, and atomic commits.

## 4. Approaches considered

1. **Move shared logic into `packages/core`, with Expo Router screens on top (chosen by owner).**
   - What moves: the framework-free web modules (`table-state`, `live-connection`, `expense-form`, `receipt-upload`,
     `errors`, `settle`, `ids`), with their vitest tests.
   - Cost: one refactor in web with no change in behaviour.
   - Gain: every rule exists once.
2. **The mobile app copies the logic it needs.** Web isn't touched, but two copies drift: a direct risk to the
   "balance differs" anti-goal. Rejected.
3. **One React Native Web codebase replacing Next.js.** Throws away a working web app and its server-side sign-in.
   Rejected.

## 5. Design

### 5.1 Packages

- `packages/core` (new, `@kitty/core`): pure TypeScript with no React and no DOM. It holds the modules above, moved
  from `apps/web/src/lib` with their tests.
  - `receipt-upload` stops taking a DOM `File`. It takes `{ type, size, body }`, where `body` is whatever the
    platform's `fetch` can PUT (a `File` on web, a `Blob` read from the photo URI on mobile).
  - Web keeps thin re-exports or updated imports. The React hooks (`useTableSession`) stay per app, because web
    listens to `document` visibility and mobile to `AppState`.
- `packages/api-client` and `packages/money`: unchanged and used as they are.
- `apps/mobile` (new): Expo, TypeScript, Expo Router (file-based routes that mirror web's: `groups`,
  `groups/[id]/…`, `invite/[token]`, `groups/[id]/table/[sessionId]`).

### 5.2 Sign-in

- **Keycloak client:** a new public client, `kitty-mobile`. Standard flow with PKCE (S256) required, no client
  secret, and the same `kitty-ledger` audience mapper as `kitty-web`. Redirect URI `kitty://auth/callback` only.
  Added to `infra/keycloak/kitty-realm.json`, so Aspire and compose both get it.
- **In the app:** `expo-auth-session` opens the system browser on Keycloak's login, so Google sign-in, email/password,
  email verification and passkeys all work exactly as on web.
  - Access and refresh tokens are kept in `expo-secure-store`.
  - The access token is refreshed shortly before it expires. A failed refresh signs out and returns to the sign-in
    screen with a short message.
  - Sign out calls Keycloak's end-session endpoint and clears the store.
- The ledger client is `createLedgerClient(apiUrl, getToken)` from `@kitty/api-client`. That is the same call web makes
  on the server, here made on the phone.

### 5.3 Links into the app

- The `kitty://` scheme handles `kitty://invite/<token>` and `kitty://t/<sessionId>`.
- Android App Links make the existing `https://<host>/invite/…` and `https://<host>/t/…` links open in the app when it
  is installed:
  - The web app serves `/.well-known/assetlinks.json`, built from an env var holding the APK signing certificate's
    fingerprint.
  - Without that env var it serves nothing, and links simply open the web page as today.
- The host's table screen shows the same QR code (the https link) as web.

### 5.4 Table mode and scanning

- **Data:** reads go straight to the ledger: the session, and the listen-token for the hub. Web goes through its own
  Route Handlers only because its tokens live on the server.
- **Live updates:** `keepLive` from core, with the `@microsoft/signalr` client, re-fetches on hub events, on reconnect,
  and when `AppState` returns to active or the network comes back (`@react-native-community/netinfo` or Expo's
  equivalent).
- **Scanning:** "Scan receipt" uses `expo-image-picker`: camera, or library as a fallback.
  - Before upload, the photo is resized and compressed (`expo-image-manipulator`, longest side ≈ 2000 px, JPEG ≈ 0.8),
    so it stays well under 10 MB and uploads quickly on mobile data.
  - The upload flow and the status lines come from core's `uploadReceipt` and `scanStatusMessage`.

### 5.5 Local development

- **Fixed ports in Aspire:** the ledger HTTP endpoint and the Azurite blob port get fixed host ports, so the app's
  config is stable. Today both are random.
- **Port forwarding:** a `pnpm --filter mobile android:reverse` script runs `adb reverse` for Keycloak (8180), the
  ledger and blob ports. The emulator or a USB phone then reaches them as `localhost`, so the token issuer matches.
- **Config:**
  - `EXPO_PUBLIC_API_URL`
  - `EXPO_PUBLIC_AUTH_ISSUER`
  - `EXPO_PUBLIC_WEB_URL` (for invite and QR links)
  - an `app.config.ts` with dev defaults pointing at localhost
- **Builds:** a development build (`expo run:android`, which needs JDK 17) rather than Expo Go, so the real `kitty://`
  redirect is used from day one.

### 5.6 Testing and CI

- **Core:** the moved vitest tests, plus new tests for anything changed (such as `receipt-upload` taking a body
  instead of a `File`).
- **Mobile:** jest-expo with React Native Testing Library for screens and hooks, against a fake ledger client.
  Written red-green.
- **CI:** a mobile job (path-filtered) runs typecheck, jest, and `expo export --platform android` to prove the bundle
  builds without a native toolchain. The existing web job still runs and must stay green.
- **Manual end-to-end on the emulator against Aspire**, recorded in the PR:
  1. Sign up (verify in Mailpit), then create a group.
  2. Add, edit and delete expenses with each split.
  3. Check balances, settle up, activity.
  4. Invite a second user (web) and claim a placeholder.
  5. Run a table with the second user on web, both screens updating live.
  6. Scan a receipt (the emulator camera or a pushed photo).

### 5.7 Distribution

**Decided (owner): a GitHub Actions Gradle build, not EAS Build**, so no Expo account is needed.
- The workflow runs `expo prebuild` and then `gradlew assembleRelease`.
- It signs the APK with a keystore kept as a repo secret, and publishes the APK as a workflow artifact and on
  GitHub Releases for `mobile-v*` tags.

## 6. Ledger, Keycloak and web changes (all that 2c touches outside `apps/mobile`)

- **Keycloak realm:** the `kitty-mobile` client (§5.2).
- **Aspire:** fixed ledger and blob ports (§5.5). No change to compose apart from what the realm import brings.
- **Web:**
  - imports move to `@kitty/core`;
  - `/.well-known/assetlinks.json` (§5.3);
  - Caddy: let `/.well-known/assetlinks.json` reach web (it already does via the catch-all; to be verified).
- **Ledger:** none expected. If the builder finds something web reaches only through its server, for example a
  route-handler-only shape, it is added to the ledger API with tests, and named in the PR.

## 7. Calls made by the designer (owner may override)

- Guests stay on web (§2).
- No new visual design; mirror web's look.
- Resize photos on the phone before upload.
- Dev build, not Expo Go.
- `@microsoft/signalr` for the hub, which is already used by web.
- jest-expo and RNTL for mobile tests; vitest stays for core.
- Android App Links are switched on by an env var, so nothing breaks before an APK exists.

## 8. Left to the builder

- Screen layout details within web's look, component structure, and the navigation stack and tab shape.
- Exact library versions (the latest stable, pinned, listed in the plan for approval).
- Whether `useTableSession` shares a small React-free core with web beyond `keepLive`.

## 9. Done when

- Every goal in §2 works on the Android emulator against Aspire, shown by the manual end-to-end steps in §5.6.
- All test suites are green in CI (.NET, ai, web, core, money, api-client, mobile), and the bundle exports.
- `RUNBOOK`/README describe running the app locally.
- A signed APK builds in GitHub Actions and installs on the emulator.
