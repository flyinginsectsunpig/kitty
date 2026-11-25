import type { PlainDraft } from "@kitty/core";

// A draft on its way from the card to the expense form (Edit). Held in memory, never in a route param, so the
// sentence and amounts stay out of navigation state and logs.
let pending: PlainDraft | null = null;

export function handOverDraft(draft: PlainDraft): void {
  pending = draft;
}

/** The handed-over draft for this group, once. */
export function takeDraft(groupId: string): PlainDraft | null {
  const draft = pending?.groupId === groupId ? pending : null;
  pending = null;
  return draft;
}
