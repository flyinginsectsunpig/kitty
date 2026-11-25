# Kitty app (Expo)

The Android app (the code is cross-platform; iOS isn't built or tested yet). It does what the web app does for
signed-in people, plus taking the receipt photo with the camera and opening Kitty links in the app. Guests
without an account keep using the web page a table's QR code opens.

It talks to the ledger directly with a Keycloak token obtained on the phone (Authorization Code + PKCE, public
client `kitty-mobile`). Tokens live only in the OS keystore (`expo-secure-store`). Shared logic (table state,
live reconnects, expense form rules, receipt upload, error text) comes from `@kitty/core`, the same code web uses.

## Run it locally (Android emulator or a USB phone)

You need:

- the Android SDK, with `platform-tools` (adb) and `emulator` on your PATH, and an emulator image (Android
  Studio's Device Manager makes one);
- JDK 17 (for example `winget install EclipseAdoptium.Temurin.17.JDK`, or Android Studio's bundled JBR), with
  `JAVA_HOME` pointing at it;
- the Aspire stack running (`dotnet run --project aspire/Kitty.AppHost` from the repo root).

Then, from the repo root:

```bash
pnpm --filter mobile android:reverse   # emulator/USB phone reaches Keycloak, ledger, blob storage and web as localhost
pnpm --filter mobile android           # builds the development app, installs it and starts Metro
```

`android:reverse` matters: the ledger only accepts tokens issued for `http://localhost:8180/realms/kitty`, so the
phone has to reach Keycloak as `localhost` too. Run it again after restarting the emulator. A phone on Wi-Fi
(not USB) can't do this; use the deployed site instead.

Sign-up verification emails land in Mailpit (its UI is in the Aspire dashboard). The first build downloads the
Android NDK and CMake (about 1.5 GB) and takes a while; later builds are quick.

**Windows:** pnpm's package paths run past 260 characters, and the default CMake 3.22's ninja can't read them (the
build loops on "manifest 'build.ninja' still dirty after 100 tries"). Install a newer CMake and point the generated
project at it, once per machine (`android/` isn't committed, so redo the second line after `expo prebuild --clean`):

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat" --install "cmake/3.31.6"
Add-Content apps\mobile\android\local.properties "cmake.dir=$($env:LOCALAPPDATA -replace '\\','\\' -replace ':','\:')\\Android\\Sdk\\cmake\\3.31.6"
```

Windows long paths must also be on (`LongPathsEnabled` = 1, the default on recent Windows 11 installs).

Configuration (all optional for local dev):

| Variable | Default |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | `http://localhost:5080` |
| `EXPO_PUBLIC_AUTH_ISSUER` | `http://localhost:8180/realms/kitty` |
| `EXPO_PUBLIC_WEB_URL` (invite and QR links) | `http://localhost:3000` |

## Tests

```bash
pnpm --filter mobile test        # jest-expo + React Native Testing Library, against a fake ledger
pnpm --filter mobile typecheck
pnpm --filter mobile export      # proves the JavaScript bundle builds (CI runs this)
```

## Push notifications

Push needs the Firebase app's `google-services.json` (RUNBOOK.md, "Notifications", step 1). Without it the app
builds and runs with push off.

- **Locally:** put the file at `apps/mobile/google-services.json` (git ignores it) and build with
  `GOOGLE_SERVICES_JSON=./google-services.json pnpm --filter mobile android`. For pulse under Aspire to send, give
  it the service-account key: `dotnet user-secrets set Parameters:fcm-credentials-path <path> --project aspire/Kitty.AppHost`.
- **Release APK:** `base64 -w0 google-services.json | gh secret set GOOGLE_SERVICES_JSON_BASE64`. The workflow
  writes it before building; without the secret it warns and builds with push off.

## Release APK

`.github/workflows/android.yml` builds a signed release APK with Gradle on GitHub's runners (no Expo account). Run
it from the Actions tab, or push a `mobile-v*` tag to attach the APK to that tag's GitHub Release. It points the app
at `https://kitty-split.duckdns.org` unless the repository variables `EXPO_PUBLIC_WEB_URL`, `EXPO_PUBLIC_API_URL`
and `EXPO_PUBLIC_AUTH_ISSUER` say otherwise.

Signing needs four repository secrets, made once from a keystore you keep (losing it means everyone has to uninstall
and reinstall to update):

```bash
keytool -genkeypair -v -keystore kitty-release.keystore -alias kitty -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 kitty-release.keystore | gh secret set ANDROID_KEYSTORE_BASE64
gh secret set ANDROID_KEYSTORE_PASSWORD
gh secret set ANDROID_KEY_ALIAS --body kitty
gh secret set ANDROID_KEY_PASSWORD
keytool -list -v -keystore kitty-release.keystore -alias kitty | grep SHA256   # → ANDROID_CERT_SHA256 on the server
```

Keep the keystore out of the repository. Setting `ANDROID_CERT_SHA256` on the server makes invite and table links
open in the installed app (Android App Links).
