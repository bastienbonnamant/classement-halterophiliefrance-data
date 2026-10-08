// Polite HTTP helpers: identifies the bot, retries with backoff, keeps the
// load on scoresheet.ffhaltero.fr low (3 parallel requests, random pauses).
const USER_AGENT =
  "classement-halterophiliefrance-bot/1.0 (+https://github.com/bastienbonnamant/classement-halterophiliefrance-data)";

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 20_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

/** GET a page as text. Retries on 429/5xx (honouring Retry-After) and network errors. */
export async function politeFetch(url: string): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = res.headers.get("retry-after");
        const delay = retryAfter ? Number(retryAfter) * 1000 : BASE_DELAY_MS * 2 ** attempt;
        if (attempt < MAX_RETRIES) {
          await sleep(delay);
          continue;
        }
        throw new FetchError(`HTTP ${res.status} after ${MAX_RETRIES} retries`, url, res.status);
      }
      if (!res.ok) throw new FetchError(`HTTP ${res.status}`, url, res.status);

      return await res.text();
    } catch (err) {
      lastError = err;
      if (err instanceof FetchError) throw err;
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
    }
  }

  throw new FetchError(`Failed to fetch after ${MAX_RETRIES} retries: ${String(lastError)}`, url, null);
}

/**
 * Runs `fn` over `items` with low concurrency and a random pause between
 * requests. Aborts the whole batch if more than 20% of requests fail.
 */
export async function politeBatch<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<{ results: R[]; errors: { item: T; error: unknown }[] }> {
  const concurrency = 3;
  const results: R[] = [];
  const errors: { item: T; error: unknown }[] = [];
  let processed = 0;
  let cursor = 0;
  let aborted = false;

  async function worker() {
    while (cursor < items.length && !aborted) {
      const item = items[cursor++];
      try {
        results.push(await fn(item));
      } catch (error) {
        errors.push({ item, error });
      }
      processed++;

      if (processed >= 20 && errors.length / processed > 0.2) {
        aborted = true;
        break;
      }
      await sleep(300 + Math.random() * 500);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));

  if (aborted) {
    throw new Error(`Circuit breaker tripped: ${errors.length}/${processed} requests failed`);
  }
  return { results, errors };
}
