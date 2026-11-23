const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids arriving in URLs are checked before they are put into a request to the ledger. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
