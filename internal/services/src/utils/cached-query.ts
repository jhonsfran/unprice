import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import { retry } from "./retry"

type QueryResult<V> = {
  val?: V
  err?: unknown
}

type SwrCache<K, V> = {
  swr: (key: K, loader: (key: K) => Promise<V>) => Promise<QueryResult<V>>
}

type CachedQueryOptions<K, V> = {
  skipCache?: boolean
  cache: SwrCache<K, V>
  cacheKey: K
  load: () => Promise<V>
  wrapLoadError: (error: Error) => FetchError
  onRetry?: (attempt: number, error: Error) => void
  attempts?: number
}

export async function cachedQuery<K, V>(
  opts: CachedQueryOptions<K, V>
): Promise<Result<V, FetchError>> {
  const attempts = opts.attempts ?? 3

  const result: QueryResult<V> = opts.skipCache
    ? await wrapResult(opts.load(), opts.wrapLoadError)
    : await retry(
        attempts,
        async () => opts.cache.swr(opts.cacheKey, async () => opts.load()),
        opts.onRetry
      )

  if (result.err) {
    const error = result.err as { message?: string }
    return Err(
      new FetchError({
        message: error.message ?? "cached query failed",
        retry: false,
      })
    )
  }

  return Ok(result.val as V)
}
