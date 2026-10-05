/** A bounded request with no automatic replay of writes after an uncertain result. */
export async function request(input: RequestInfo | URL, init: RequestInit = {}) {
  const timeout = AbortSignal.timeout(30_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    const response = await globalThis.fetch(input, { ...init, signal, cache: "no-store" });
    if (response.status === 401 && typeof window !== "undefined") {
      window.location.assign("/");
      throw new Error("Your session expired. Sign in again to continue.");
    }
    return response;
  } catch (error) {
    if (timeout.aborted) {
      // Named so callers can tell "the server never answered" from a rejection, and say so aloud.
      throw Object.assign(new Error("The server did not respond in time. Refresh the queue to check whether the action completed before trying again."), { name: "TimeoutError" });
    }
    throw error;
  }
}
