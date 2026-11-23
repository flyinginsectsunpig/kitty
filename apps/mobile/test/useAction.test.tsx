import { act, renderHook } from "@testing-library/react-native";
import { useAction } from "../src/hooks/useAction";
import { json } from "./support/fake-ledger";

const ok = (data: unknown) => ({ data, error: undefined, response: json(200, data) });
const problem = (code: string, status = 400) => ({ data: undefined, error: { code }, response: json(status, { code }) });

test("a thrown request yields the network message and busy=false", async () => {
  const { result } = await renderHook(() => useAction(async () => Promise.reject(new TypeError("Network request failed"))));
  let value: unknown = "unset";
  await act(async () => {
    value = await result.current.run();
  });
  expect(value).toEqual({ ok: false });
  expect(result.current.error).toBe("Couldn't reach Kitty. Check your connection and try again.");
  expect(result.current.busy).toBe(false);
});

test("a ledger problem shows its message", async () => {
  const { result } = await renderHook(() => useAction(async () => problem("split_sum_mismatch")));
  await act(async () => void (await result.current.run()));
  expect(result.current.error).toBe("The split must add up to the total.");
});

test("retrying after an error reuses the key", async () => {
  const keys: string[] = [];
  let fail = true;
  const { result } = await renderHook(() =>
    useAction(async (key) => {
      keys.push(key);
      if (fail) throw new TypeError("offline");
      return ok({ id: 1 });
    }),
  );
  await act(async () => void (await result.current.run()));
  fail = false;
  let value: unknown;
  await act(async () => {
    value = await result.current.run();
  });
  expect(value).toEqual({ ok: true, data: { id: 1 } });
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(result.current.error).toBeNull();
});

test("the key changes after a success", async () => {
  const keys: string[] = [];
  const { result } = await renderHook(() =>
    useAction(async (key) => {
      keys.push(key);
      return ok({});
    }),
  );
  await act(async () => void (await result.current.run()));
  await act(async () => void (await result.current.run()));
  expect(keys[0]).not.toBe(keys[1]);
});

test("a success without a body is still a success", async () => {
  const { result } = await renderHook(() => useAction(async () => ({ data: undefined, error: undefined, response: json(204) })));
  let value: unknown;
  await act(async () => {
    value = await result.current.run();
  });
  expect(value).toEqual({ ok: true, data: undefined });
});
