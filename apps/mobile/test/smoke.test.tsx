import { isUuid } from "@kitty/core";
import { formatMoney } from "@kitty/money";
import { renderRouter } from "expo-router/testing-library";
import Index from "../src/app/index";
import { config } from "../src/config";

test("workspace packages resolve in the app", () => {
  expect(formatMoney(12345, "ZAR")).toMatch(/^R\s123,45$/);
  expect(isUuid("00000000-0000-4000-8000-000000000000")).toBe(true);
});

test("the hub lives under the ledger API", () => {
  expect(config.hubUrl).toBe(`${config.apiUrl}/hubs/table`);
});

test("opening the app goes to the groups list", async () => {
  const app = await renderRouter({ index: Index, "groups/index": () => null }, { initialUrl: "/" });
  expect(app.getPathname()).toBe("/groups");
});
