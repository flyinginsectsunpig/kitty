# Kitty

Kitty is a free, open-source app for splitting shared costs between friends,
roommates, couples and travel groups — unlimited expenses, no ads, live
itemized receipt splitting, and an AI that understands plain language.

See [the design](docs/superpowers/specs/2026-11-15-kitty-design.md).

## What it does

- **Groups and balances:** add people (even before they sign up), split expenses equally, by amount,
  percentage or shares, and see the fewest payments that settle everyone.
- **Split a bill at the table:** the host enters the bill, everyone scans a QR code and taps what they had —
  live, on their own phones, no account needed for guests. Shared plates and the tip are split fairly, and
  confirming turns it into one expense. VAT is never added on top (South African prices include it).
- **Scan the receipt:** photograph the bill and its items and tip fill in by themselves. The photo stays on
  Kitty's server; only the text, with card numbers, phone numbers and names removed, goes to an AI model.
- **Android app:** everything above on the phone, with the camera for receipts and invite and table links that
  open in the app ([apps/mobile](apps/mobile/README.md)). The web app works on any phone too.

## Local dev

Needs the .NET 10 SDK, Node 24 with corepack (`corepack pnpm install` once), Docker, and
[uv](https://docs.astral.sh/uv/) on your PATH (it sets up the Python ai service).

```bash
dotnet run --project aspire/Kitty.AppHost
```

Receipt scanning uses Gemini when you give it a key (otherwise scans fail fast and you type the items):

```bash
dotnet user-secrets set Parameters:gemini-api-key <key> --project aspire/Kitty.AppHost
```

The Android app runs on an emulator or a USB phone against the same stack: see [apps/mobile](apps/mobile/README.md).
