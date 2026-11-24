// Anti-ban guardrails for EVERY outgoing WhatsApp message from a session
// (agent replies, API sends, scheduled sends, keyword/AI auto-replies,
// broadcasts). Broadcasts already have their own layer (lists, ceilings,
// warm-up daily cap, per-contact cooldown, circuit breakers -- see
// claude/broadcast-anti-spam-design-2026-09-23.md); this covers the paths
// that had no limit at all.
//
// These don't make an unofficial client safe -- only the official WhatsApp
// Business Platform is -- they stop this app from producing the patterns
// WhatsApp flags most: bursts, lots of first messages to strangers, and
// bot-to-bot reply loops.
import { warmUpMultiplier } from "@workspace/db";

export type SendKind = "manual" | "api" | "broadcast" | "scheduled" | "auto";

export function parseSendKind(value: string | null | undefined): SendKind {
  return value === "api" || value === "broadcast" || value === "scheduled" || value === "auto" ? value : "manual";
}

/** Classic token bucket: `capacity` burst, then `refillPerSec` sustained. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    now = Date.now()
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  private refill(now: number) {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
  }

  /** Takes a token and returns 0, or returns how many ms until one is free. */
  take(now = Date.now()): number {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
  }
}

/** Test-friendly outbound pace: bursts of 10, then up to ~60 messages/minute. */
export const OUTBOUND_BURST = 10;
export const OUTBOUND_PER_SEC = 1;
/** A send that would wait longer than this is refused instead (429). */
export const MAX_QUEUE_WAIT_MS = 5_000;

/**
 * Generous test-mode auto-reply limits. No artificial per-message cooldown;
 * allow normal product follow-ups while retaining a high ceiling as a loop
 * breaker if another bot or an automated sender gets into a reply cycle.
 */
export class AutoReplyLimiter {
  private perContact = new Map<string, number[]>();
  private session: number[] = [];

  constructor(
    // Customers often ask several product questions in quick succession.
    // No cooldown during testing; hourly ceilings remain as loop protection.
    private readonly perContactMinGapMs = 0,
    private readonly perContactPerHour = 120,
    private readonly sessionPerHour = 1_000
  ) {}

  allow(jid: string, now = Date.now()): boolean {
    const hourAgo = now - 60 * 60_000;
    const history = (this.perContact.get(jid) ?? []).filter((t) => t > hourAgo);
    this.session = this.session.filter((t) => t > hourAgo);
    const last = history.at(-1);
    if (last !== undefined && now - last < this.perContactMinGapMs) return false;
    if (history.length >= this.perContactPerHour) return false;
    if (this.session.length >= this.sessionPerHour) return false;
    history.push(now);
    this.perContact.set(jid, history);
    this.session.push(now);
    if (this.perContact.size > 5_000) this.perContact.clear();
    return true;
  }
}

/**
 * Suppresses identical automatic replies to the same chat during a short
 * burst. Several rapid customer messages can otherwise race through separate
 * AI tasks and send the same final answer multiple times.
 */
export class AutoReplyContentDeduper {
  private recent = new Map<string, number>();

  constructor(private readonly windowMs = 45_000) {}

  allow(jid: string, text: string, now = Date.now()): boolean {
    const normalized = text.normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    // FNV-1a keeps storage in memory bounded without retaining customer text.
    let hash = 2166136261;
    for (let i = 0; i < normalized.length; i++) {
      hash ^= normalized.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const key = jid + ":" + (hash >>> 0).toString(36);
    const previous = this.recent.get(key);
    if (previous !== undefined && now - previous < this.windowMs) return false;
    this.recent.set(key, now);
    if (this.recent.size > 2_000) {
      for (const [entry, timestamp] of this.recent) {
        if (now - timestamp >= this.windowMs) this.recent.delete(entry);
      }
      if (this.recent.size > 2_000) this.recent.clear();
    }
    return true;
  }
}

/**
 * Daily cap on *new* chats: first messages to numbers that have never
 * written to this number. Scaled by the same warm-up tiers as broadcasts,
 * so a freshly linked number can't start messaging strangers at full rate.
 */
export const BASE_NEW_CHATS_PER_DAY = 50;
export function newChatDailyCap(sessionCreatedAt: Date | null | undefined, now = new Date()) {
  return Math.max(5, Math.round(BASE_NEW_CHATS_PER_DAY * warmUpMultiplier(sessionCreatedAt, now)));
}

export function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}
