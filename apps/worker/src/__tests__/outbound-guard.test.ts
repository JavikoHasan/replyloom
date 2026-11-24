import { describe, expect, it } from "vitest";
import { AutoReplyLimiter, TokenBucket, newChatDailyCap, parseSendKind } from "../session/outbound-guard";

describe("outbound guard", () => {
  it("token bucket allows a burst, then paces", () => {
    const t0 = 1_000_000;
    const b = new TokenBucket(8, 0.4, t0);
    for (let i = 0; i < 8; i++) expect(b.take(t0)).toBe(0);
    const wait = b.take(t0);
    expect(wait).toBeGreaterThan(2000); // ~2.5 s for the next token
    expect(b.take(t0 + wait)).toBe(0);
  });

  it("allows normal product follow-ups while retaining anti-loop limits", () => {
    const l = new AutoReplyLimiter();
    const t0 = 5_000_000;
    expect(l.allow("customer@s.whatsapp.net", t0)).toBe(true);
    expect(l.allow("customer@s.whatsapp.net", t0 + 5_000)).toBe(false); // brief anti-loop cooldown
    expect(l.allow("customer@s.whatsapp.net", t0 + 10_000)).toBe(true); // follow-up after 10 seconds

    let allowed = 2;
    for (let i = 2; i <= 25; i++) {
      if (l.allow("customer@s.whatsapp.net", t0 + i * 10_000)) allowed++;
    }
    expect(allowed).toBe(20); // max 20 per hour per contact
    expect(l.allow("another-customer@s.whatsapp.net", t0 + 5_000)).toBe(true); // other contacts unaffected
  });

  it("new-chat cap follows warm-up tiers", () => {
    const now = new Date("2026-09-26T00:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    expect(newChatDailyCap(new Date(now.getTime() - 1 * day), now)).toBe(5); // 10% of 50
    expect(newChatDailyCap(new Date(now.getTime() - 60 * day), now)).toBe(50);
    expect(newChatDailyCap(null, now)).toBe(5);
  });

  it("send kind can't be spoofed into something unknown", () => {
    expect(parseSendKind("broadcast")).toBe("broadcast");
    expect(parseSendKind("admin")).toBe("manual");
    expect(parseSendKind(null)).toBe("manual");
  });
});
