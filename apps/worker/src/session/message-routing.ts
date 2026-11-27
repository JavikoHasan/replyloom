/**
 * WhatsApp business-assistant routing boundary.
 * Only known one-to-one JID types are eligible. Groups, status/broadcast,
 * channels/newsletters, and unknown address types are rejected.
 */
export function isPrivateDirectChatJid(remoteJid: unknown): boolean {
  if (typeof remoteJid !== "string" || !remoteJid.trim()) return false;
  const jid = remoteJid.trim().toLowerCase();
  if (jid === "status@broadcast") return false;
  if (jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) return false;
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
}
