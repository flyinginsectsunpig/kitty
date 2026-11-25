/**
 * Where the app finds Kitty. Development defaults are this PC's Aspire ports, which the emulator reaches as
 * localhost through `pnpm android:reverse` (the ledger only accepts tokens issued for localhost:8180).
 */
const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:5080";

export const config = {
  apiUrl,
  authIssuer: process.env.EXPO_PUBLIC_AUTH_ISSUER ?? "http://localhost:8180/realms/kitty",
  webUrl: process.env.EXPO_PUBLIC_WEB_URL ?? "http://localhost:3000",
  hubUrl: `${apiUrl}/hubs/table`,
  /** The ai service (plain-language entry): Caddy's /ai on the server, Aspire's fixed port locally. */
  aiUrl: process.env.EXPO_PUBLIC_AI_URL ?? "http://localhost:5085",
} as const;
