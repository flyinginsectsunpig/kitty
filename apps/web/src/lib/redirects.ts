/** Only same-site paths are allowed as a post-sign-in destination (no open redirects). */
export function safeNext(next: string | undefined, fallback = "/groups"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
