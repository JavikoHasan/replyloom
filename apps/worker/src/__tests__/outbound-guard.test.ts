import { describe, expect, it } from "vitest";
import { AutoReplyContentDeduper, AutoReplyLimiter, TokenBucket, newChatDailyCap, parseSendKind } from "../session/outbound-guard";

describe("outbound guard", () => {
  it("token bucket allows a burst, then paces", () => {
    const t0 = 1_000_000;
    const b = new TokenBucket(8, 0.4, t0);
    for (let i = 0; i < 8; i++) expect(b.take(t0)).toBe(0);
    const wait = b.take(t0);
    expect(wait).toBeGreaterThan(2000); // ~2.5 s for the next token
    expect(b.take(t0 + wait)).toBe(0);
  });

  it("allows quick product follow-ups while retaining hourly anti-loop limits", () => {
    const l = new AutoReplyLimiter();
    const t0 = 5_000_000;
    expect(l.allow("customer@s.whatsapp.net", t0)).toBe(true);
    expect(l.allow("customer@s.whatsapp.net", t0 + 5_000)).toBe(true);
    expect(l.allow("customer@s.whatsapp.net", t0 + 10_000)).toBe(true);

    let allowed = 3;
    for (let i = 3; i < 120; i++) {
      if (l.allow("customer@s.whatsapp.net", t0 + i * 10_000)) allowed++;
    }
    expect(allowed).toBe(120); // high ceiling allows ordinary multi-question buying conversations
    expect(l.allow("customer@s.whatsapp.net", t0 + 120 * 10_000)).toBe(false); // hourly loop breaker
    expect(l.allow("another-customer@s.whatsapp.net", t0 + 5_000)).toBe(true); // other contacts unaffected
  });

  it("suppresses identical replies to the same chat during a burst, but allows different replies", () => {
    const deduper = new AutoReplyContentDeduper();
    const t0 = 8_000_000;
    const jid = "customer@s.whatsapp.net";
    const reply = "La entrega a domicilio es gratuita en Sagua la Grande.";
    expect(deduper.allow(jid, reply, t0)).toBe(true);
    expect(deduper.allow(jid, reply, t0 + 1_000)).toBe(false);
    expect(deduper.allow(jid, "LA ENTREGA  a domicilio es gratuita en Saguá la Grande.", t0 + 1_500)).toBe(false);
    expect(deduper.allow(jid, "El precio publicado es 190 USD.", t0 + 2_000)).toBe(true);
    expect(deduper.allow("other@s.whatsapp.net", reply, t0 + 2_000)).toBe(true);
    expect(deduper.allow(jid, reply, t0 + 3_000)).toBe(true);
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
