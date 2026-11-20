type Result<T> = { session: T | null; error: string | null };

/**
 * Runs a screen action and always comes back with a result. A server action or fetch that throws (the phone
 * lost signal, the server restarted) becomes the "network" error, so a screen waiting on it never stays busy.
 */
export async function settle<T>(action: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await action();
  } catch {
    return { session: null, error: "network" };
  }
}
