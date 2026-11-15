const BASE = "https://kitty.invalid";

/**
 * Only same-site paths are allowed as a post-sign-in destination (no open redirects).
 * Rejects control characters and backslashes outright (browsers strip tabs/newlines, turning
 * "/\t/evil" into "//evil"), then requires the parsed URL to stay on our origin.
 */
export function safeNext(next: string | undefined, fallback = "/groups"): string {
  if (!next || !next.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  try {
    const url = new URL(next, BASE);
    if (url.origin !== BASE) return fallback;
    // Normalization can produce "//host" from "/.//host"; re-check what we would actually redirect to.
    const out = url.pathname + url.search + url.hash;
    return out.startsWith("/") && !out.startsWith("//") && !out.startsWith("/\\") ? out : fallback;
  } catch {
    return fallback;
  }
}
