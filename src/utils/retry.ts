/**
 * Retry a function with exponential backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number; onRetry?: (err: Error, attempt: number) => void } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, onRetry } = opts;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const error = err instanceof Error ? err : new Error(String(err));
      onRetry?.(error, attempt + 1);
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Unreachable");
}
