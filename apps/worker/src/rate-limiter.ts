/**
 * Atomic fixed-window rate limiting on SQLite-backed Durable Objects.
 * A separate object is addressed per hashed rate-limit key, avoiding a
 * single global hot object while staying within the Workers Free plan.
 */
export class RateLimiter implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        window_start INTEGER NOT NULL,
        hits INTEGER NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let body: { limit?: number; windowMs?: number };
    try {
      body = await request.json() as { limit?: number; windowMs?: number };
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const limit = Number(body.limit);
    const windowMs = Number(body.windowMs);
    if (
      !Number.isInteger(limit) || limit < 1 || limit > 10_000 ||
      !Number.isInteger(windowMs) || windowMs < 1_000 || windowMs > 3_600_000
    ) {
      return Response.json({ error: "Invalid rate-limit settings" }, { status: 400 });
    }

    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const rows = this.state.storage.sql.exec(
      `INSERT INTO rate_limit_state (id, window_start, hits)
       VALUES (1, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         hits = CASE
           WHEN rate_limit_state.window_start = excluded.window_start
           THEN rate_limit_state.hits + 1
           ELSE 1
         END,
         window_start = excluded.window_start
       RETURNING hits`,
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
