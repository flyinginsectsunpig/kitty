import type { AiClient } from "../../src/ai";

/** For fake ai clients in tests that don't open assistants' drafts. */
export const noDrafts: Pick<AiClient, "draft" | "finishDraft"> = {
  draft: async () => ({ error: "draft_gone" }),
  finishDraft: async () => undefined,
};
