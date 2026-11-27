/**
 * Atomic fixed-window rate limiting on SQLite-backed Durable Objects.
 * Rate-limit keys are hashed and spread over 256 shards so an attacker
 * cannot create one new Durable Object for every unique IP or email.
 */
export class RateLimiter implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit_state (
        bucket_key TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        hits INTEGER NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let body: { keyHash?: unknown; limit?: number; windowMs?: number };
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const keyHash = body.keyHash;
    const limit = Number(body.limit);
    const windowMs = Number(body.windowMs);
    if (
      typeof keyHash !== "string" || !/^[a-f0-9]{64}$/.test(keyHash) ||
      !Number.isInteger(limit) || limit < 1 || limit > 10_000 ||
      !Number.isInteger(windowMs) || windowMs < 1_000 || windowMs > 3_600_000
    ) {
      return Response.json({ error: "Invalid rate-limit settings" }, { status: 400 });
    }

    const now = Date.now();
    const lastCleanupAt = await this.state.storage.get<number>("lastCleanupAt");
    if (!lastCleanupAt || now - lastCleanupAt > 24 * 60 * 60_000) {
      // Remove inactive keys once per day so the shard tables stay bounded.
      this.state.storage.sql.exec(
        "DELETE FROM rate_limit_state WHERE window_start < ?",
        now - 24 * 60 * 60_000,
      );
      await this.state.storage.put("lastCleanupAt", now);
    }

    const windowStart = Math.floor(now / windowMs) * windowMs;
    const rows = this.state.storage.sql.exec(
      `INSERT INTO rate_limit_state (bucket_key, window_start, hits)
       VALUES (?, ?, 1)
       ON CONFLICT(bucket_key) DO UPDATE SET
         hits = CASE
           WHEN rate_limit_state.window_start = excluded.window_start
           THEN rate_limit_state.hits + 1
           ELSE 1
         END,
         window_start = excluded.window_start
       RETURNING hits`,
      keyHash,
      windowStart,
    ).toArray();

    const hits = Number(rows[0]?.hits ?? 0);
    const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
    return Response.json({
      success: hits <= limit,
      remaining: Math.max(0, limit - hits),
      retryAfter,
    });
  }
}
