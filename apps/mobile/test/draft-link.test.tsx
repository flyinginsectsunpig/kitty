import type { PlainDraft } from "@kitty/core";
import { fireEvent, screen, waitFor } from "expo-router/testing-library";
import { Text } from "react-native";
import DraftLink from "../src/app/(app)/d/[id]";
import type { AiClient, AiResult } from "../src/ai";
import { fakeLedger, json } from "./support/fake-ledger";
import { G, groupRoutes, ME, SAM } from "./support/group";
import { renderApp } from "./support/render-app";

const ID = "abcDEF123_-xyz7890";
const routes = {
  "(app)/d/[id]": DraftLink,
  "(app)/groups/[id]/index": () => <Text>Group home</Text>,
};

const dinner: PlainDraft = {
  groupId: G,
  members: [
    { id: ME, displayName: "Zee" },
    { id: SAM, displayName: "Sam" },
  ],
  groups: [{ id: G, name: "Flat 4B" }],
  parsed: {},
  intent: "expense",
  issues: [],
  expense: {
    description: "Dinner",
    category: "food",
    currency: "ZAR",
    amountMinor: 45000,
    occurredOn: "2026-11-27",
    payerMemberId: ME,
    split: "equal",
    participants: [
      { memberId: ME, name: "me", amountMinor: null },
      { memberId: SAM, name: "Sam", amountMinor: null },
    ],
  },
};

function fakeAi(result: AiResult): AiClient & { opened: string[]; finished: string[] } {
  const opened: string[] = [];
  const finished: string[] = [];
  return {
    opened,
    finished,
    parse: async () => ({ error: "unexpected" }),
    resolve: async () => result,
    ask: async () => ({ error: "unexpected" }),
    draft: async (id) => (opened.push(id), result),
    finishDraft: async (id) => void finished.push(id),
  };
}

test("opens_the_card_from_the_link", async () => {
  const { client } = fakeLedger(groupRoutes({}));
  const ai = fakeAi({ draft: dinner });
  await renderApp(routes, client, `/d/${ID}`, ai);

  expect(await screen.findByText(/Dinner · R\s450,00/)).toBeTruthy();
  expect(screen.getByText(/Nothing is saved until you tap Save/)).toBeTruthy();
  expect(ai.opened).toEqual([ID]);
});

test("shows_expired_message_on_draft_gone", async () => {
  const { client } = fakeLedger(groupRoutes({}));
  await renderApp(routes, client, `/d/${ID}`, fakeAi({ error: "draft_gone" }));

  expect(await screen.findByText("This draft has expired or was already used. Ask again in your chat.")).toBeTruthy();
});

test("finishes_the_draft_after_save", async () => {
  const { client, calls } = fakeLedger(groupRoutes({ [`POST /groups/${G}/expenses`]: () => json(201, {}) }));
  const ai = fakeAi({ draft: dinner });
  const { app } = await renderApp(routes, client, `/d/${ID}`, ai);

  await fireEvent.press(await screen.findByText("Save"));

  await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === `/groups/${G}/expenses`)).toBe(true));
  await waitFor(() => expect(ai.finished).toEqual([ID]));
  await waitFor(() => expect(app.getPathname()).toBe(`/groups/${G}`));
});
