export function createRetryableInitializer<T>(initialize: () => Promise<T>) {
  let inFlight: Promise<T> | null = null;

  return () => {
    if (inFlight) return inFlight;

    const attempt = Promise.resolve().then(initialize);
    const guarded = attempt.catch((error) => {
      if (inFlight === guarded) inFlight = null;
      throw error;
    });
    inFlight = guarded;
    return guarded;
  };
}
