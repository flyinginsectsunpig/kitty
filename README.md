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

## Local dev

```bash
dotnet run --project aspire/Kitty.AppHost
```
