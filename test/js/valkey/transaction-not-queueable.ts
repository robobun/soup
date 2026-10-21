/**
 * What a transaction (`redis.multi()`) does not queue. A schema file of the bindings generator exports only
 * what it generates, so the list is here: `test/internal/source-lints/redis-client-types.test.ts` holds
 * `RedisTransaction.NotQueueable` in redis.d.ts to it, and `valkey.test.ts` holds the runtime to it.
 */
export const notQueueableInTransaction = [
  "connected",
  "bufferedAmount",
  "onconnect",
  "onclose",
  "connect",
  "close",
  "duplicate",
  "subscribe",
  "unsubscribe",
  "psubscribe",
  "punsubscribe",
  "multi",
  "exec",
] as const;
