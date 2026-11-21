import { describe, expect, it } from "vitest";
import { isPrivateDirectChatJid } from "../session/message-routing";

describe("WhatsApp business assistant routing", () => {
  it("allows direct phone and LID chats", () => {
    expect(isPrivateDirectChatJid("5354590237@s.whatsapp.net")).toBe(true);
    expect(isPrivateDirectChatJid("123456789012345@lid")).toBe(true);
  });

  it("rejects groups even when the business number is mentioned", () => {
    expect(isPrivateDirectChatJid("120363000000000000@g.us")).toBe(false);
  });

  it("rejects channels, status, and broadcast messages", () => {
    expect(isPrivateDirectChatJid("123456789@newsletter")).toBe(false);
    expect(isPrivateDirectChatJid("status@broadcast")).toBe(false);
    expect(isPrivateDirectChatJid("123456789@broadcast")).toBe(false);
  });

  it("fails closed for missing or unknown JID types", () => {
    expect(isPrivateDirectChatJid(undefined)).toBe(false);
    expect(isPrivateDirectChatJid("")).toBe(false);
    expect(isPrivateDirectChatJid("123456789@unknown")).toBe(false);
  });
});
