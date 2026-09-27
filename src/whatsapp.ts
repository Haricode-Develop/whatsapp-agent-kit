import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta signs every webhook with the app secret (X-Hub-Signature-256: sha256=<hex>).
 * Verify it against the RAW body bytes, before parsing JSON; anything else lets anyone
 * on the internet talk to your agent and spend your tokens.
 */
export function verifySignature(appSecret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(header.slice("sha256=".length), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export interface InboundMessage {
  id: string;
  /** Customer's WhatsApp number (wa_id), used as the conversation key. */
  from: string;
  customerName?: string;
  /** Text for the agent. Non-text messages become a short description so the agent can answer naturally. */
  text: string;
  type: string;
}

/** Extract customer messages from a WhatsApp Cloud API webhook payload. Status updates are ignored. */
export function parseInbound(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries as Array<{ changes?: Array<{ value?: any }> }>) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const names = new Map<string, string>(
        (value.contacts ?? []).map((c: any) => [String(c.wa_id), String(c.profile?.name ?? "")]),
      );
      for (const m of value.messages ?? []) {
        const text = describe(m);
        if (!text) continue;
        out.push({ id: String(m.id), from: String(m.from), customerName: names.get(String(m.from)) || undefined, text, type: String(m.type) });
      }
    }
  }
  return out;
}

function describe(m: any): string | null {
  switch (m?.type) {
    case "text":
      return m.text?.body ?? null;
    case "button":
      return m.button?.text ?? null;
    case "interactive":
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
    case "image":
    case "video":
    case "document":
      return `[The customer sent a ${m.type}${m[m.type]?.caption ? ` with the caption: "${m[m.type].caption}"` : ""}. You can't open attachments; ask them to describe what they need in a message.]`;
    case "audio":
      return "[The customer sent a voice note. You can't listen to audio yet; kindly ask them to write their question.]";
    case "location":
      return `[The customer shared a location: ${m.location?.name ?? ""} ${m.location?.address ?? ""}]`.replace(/\s+\]/, "]");
    default:
      return null; // reactions, stickers, system messages: nothing to answer
  }
}

export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<void>;
}

/** Sends through the official WhatsApp Cloud API (graph.facebook.com). */
export class CloudApiSender implements WhatsAppSender {
  constructor(
    private readonly accessToken: string,
    private readonly phoneNumberId: string,
    private readonly graphVersion = "v21.0",
  ) {}

  async sendText(to: string, body: string): Promise<void> {
    // WhatsApp caps a text message at 4096 characters.
    for (const chunk of splitMessage(body, 4000)) {
      const res = await fetch(`https://graph.facebook.com/${this.graphVersion}/${this.phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: chunk, preview_url: false } }),
      });
      if (!res.ok) throw new Error(`WhatsApp send failed (${res.status}): ${await res.text()}`);
    }
  }
}

export function splitMessage(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = Math.max(rest.lastIndexOf("\n", max), rest.lastIndexOf(" ", max));
    const at = cut > max / 2 ? cut : max;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
