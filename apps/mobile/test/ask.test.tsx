import type { AskResult, PlainDraft } from "@kitty/core";
import { fireEvent, screen, waitFor } from "expo-router/testing-library";
import { Text } from "react-native";
import GroupLayout from "../src/app/(app)/groups/[id]/_layout";
import GroupsIndex from "../src/app/(app)/groups/index";
import type { AiClient, AiResult } from "../src/ai";
import { fakeLedger, json } from "./support/fake-ledger";
import { G, groupRoutes, ME, SAM } from "./support/group";
import { renderApp } from "./support/render-app";

const routes = {
  "(app)/groups/index": GroupsIndex,
  "(app)/groups/[id]/_layout": GroupLayout,
  "(app)/groups/[id]/index": () => <Text>Group home</Text>,
};

const groupsList = {
  "GET /groups": () =>
    json(200, [{ id: G, name: "Flat 4B", baseCurrency: "ZAR", memberCount: 2, myNet: [], createdAt: "2026-01-05T10:00:00Z" }]),
};

const base = {
  groupId: G,
  issues: [],
  members: [
    { id: ME, displayName: "Zee" },
    { id: SAM, displayName: "Sam" },
  ],
  groups: [{ id: G, name: "Flat 4B" }],
  parsed: {},
};
const question: PlainDraft = { ...base, intent: "question" };
const petrol: PlainDraft = {
  ...base,
  intent: "expense",
  expense: {
    description: "Petrol",
    category: "transport",
    currency: "ZAR",
    amountMinor: 60000,
    occurredOn: "2026-11-25",
    payerMemberId: ME,
    split: "equal",
    participants: [
      { memberId: ME, name: "me", amountMinor: null },
      { memberId: SAM, name: "Sam", amountMinor: null },
    ],
  },
};

type Sent = { role: "person" | "kitty"; text: string }[];

/** Plays back parse and ask results in order; records what it was sent. */
function fakeAi(parses: AiResult[], asks: AskResult[]) {
  const parsed: string[] = [];
  const asked: Sent[] = [];
  const client: AiClient = {
    parse: async (text) => (parsed.push(text), parses.shift() ?? { error: "unexpected" }),
    resolve: async () => ({ error: "unexpected" }),
    ask: async (messages) => (asked.push(messages), asks.shift() ?? { error: "unexpected" }),
  };
  return { client, parsed, asked };
}

async function type(sentence: string) {
  await fireEvent.changeText(await screen.findByLabelText("Add an expense or a reminder in a sentence"), sentence);
  await fireEvent.press(screen.getByText("Go"));
}

async function open(ai: AiClient) {
  const { client } = fakeLedger(groupRoutes(groupsList));
  return renderApp(routes, client, "/groups", ai);
}

test("a question gets an answer", async () => {
  const ai = fakeAi([{ draft: question }], [{ answer: "You owe R 245,00 in total.\n- Flat 4B: Joe R 120,00" }]);
  await open(ai.client);

  await type("how much do I owe in total?");

  expect(await screen.findByText(/You owe R 245,00 in total\./)).toBeTruthy();
  expect(screen.getByText("how much do I owe in total?")).toBeTruthy();
  expect(ai.asked).toEqual([[{ role: "person", text: "how much do I owe in total?" }]]);
});

test("a follow-up sends the earlier messages", async () => {
  const ai = fakeAi([{ draft: question }], [{ answer: "You owe Joe R 25,00 for the Uber." }, { answer: "On 18 Nov." }]);
  await open(ai.client);

  await type("how much do I owe Joe?");
  await screen.findByText("You owe Joe R 25,00 for the Uber.");
  await type("when was that?");

  expect(await screen.findByText("On 18 Nov.")).toBeTruthy();
  expect(ai.parsed).toEqual(["how much do I owe Joe?"]);
  expect(ai.asked[1]).toEqual([
    { role: "person", text: "how much do I owe Joe?" },
    { role: "kitty", text: "You owe Joe R 25,00 for the Uber." },
    { role: "person", text: "when was that?" },
  ]);
});

test("an entry answer shows the 4a card", async () => {
  const ai = fakeAi([{ draft: question }, { draft: petrol }], [{ answer: "You owe Sam R 50,00." }, { entry: true }]);
  await open(ai.client);

  await type("do I owe Sam?");
  await screen.findByText("You owe Sam R 50,00.");
  await type("petrol R600 with Sam");

  expect(await screen.findByText(/Petrol · R\s600,00/)).toBeTruthy();
  expect(ai.parsed).toEqual(["do I owe Sam?", "petrol R600 with Sam"]);
  expect(screen.getByText("Save")).toBeTruthy();
});

test("a question that comes back from ask a second time is unclear", async () => {
  const ai = fakeAi([{ draft: question }, { draft: question }], [{ answer: "R 50,00." }, { entry: true }]);
  await open(ai.client);

  await type("do I owe Sam?");
  await screen.findByText("R 50,00.");
  await type("hmm");

  expect(await screen.findByText(/Kitty couldn't tell what to do with that/)).toBeTruthy();
  expect(ai.asked).toHaveLength(2);
});

test("rate limited shows the 4a message", async () => {
  const ai = fakeAi([{ draft: question }], [{ error: "ai_rate_limited" }]);
  await open(ai.client);

  await type("how much do I owe?");

  expect(await screen.findByText(/That's a lot of sentences for one hour/)).toBeTruthy();
});

test("New conversation clears it", async () => {
  const ai = fakeAi([{ draft: question }, { draft: question }], [{ answer: "R 120,00." }, { answer: "R 30,00." }]);
  await open(ai.client);

  await type("how much do I owe?");
  await screen.findByText("R 120,00.");
  await fireEvent.press(screen.getByText("New conversation"));

  await waitFor(() => expect(screen.queryByText("R 120,00.")).toBeNull());
  await type("and Sam?");
  await screen.findByText("R 30,00.");
  expect(ai.parsed).toEqual(["how much do I owe?", "and Sam?"]); // a fresh conversation starts at /parse again
  expect(ai.asked[1]).toEqual([{ role: "person", text: "and Sam?" }]);
});

test("the notice says questions send what Kitty looks up", async () => {
  await open(fakeAi([], []).client);
  expect(
    await screen.findByText(
      "What you type is sent to an AI model: Google's Gemini, unless this Kitty server runs its own. For questions, so are the details Kitty looks up to answer them: amounts, descriptions and names from your groups.",
    ),
  ).toBeTruthy();
});
