import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { WhatsAppAgent, createMessageWithClient } from "./agent.js";
import { loadBusiness } from "./business.js";
import { loadConfig } from "./config.js";
import { InMemoryBookingStore, InMemoryConversationStore } from "./store.js";
import { CloudApiSender, parseInbound, verifySignature, type InboundMessage, type WhatsAppSender } from "./whatsapp.js";

export interface WebhookDeps {
  agent: Pick<WhatsAppAgent, "reply">;
  sender: WhatsAppSender;
  appSecret: string;
  verifyToken: string;
  log?: (message: string, error?: unknown) => void;
}

/**
 * The webhook. Meta retries any delivery that isn't answered with 200 within a few
 * seconds, so the handler acknowledges first and works afterwards, drops duplicates by
 * message id, and runs one customer's messages strictly in order.
 */
export function createWebhookHandler(deps: WebhookDeps) {
  const log = deps.log ?? ((m, e) => (e ? console.error(m, e) : console.log(m)));
  const seen = new Set<string>();
  const queues = new Map<string, Promise<void>>();

  const handleMessage = async (message: InboundMessage) => {
    const reply = await deps.agent.reply(message.from, message.text);
    if (reply) await deps.sender.sendText(message.from, reply);
  };

  const enqueue = (message: InboundMessage) => {
    if (seen.has(message.id)) return;
    seen.add(message.id);
    if (seen.size > 10_000) seen.delete(seen.values().next().value!);
    const previous = queues.get(message.from) ?? Promise.resolve();
    const next = previous
      .then(() => handleMessage(message))
      .catch((error) => log(`Failed to answer message ${message.id}`, error));
    queues.set(message.from, next);
    void next.finally(() => {
      if (queues.get(message.from) === next) queues.delete(message.from);
    });
    return next;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/webhook") return end(res, 404, "Not found");

    if (req.method === "GET") {
      const ok = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === deps.verifyToken;
      return ok ? end(res, 200, url.searchParams.get("hub.challenge") ?? "") : end(res, 403, "Forbidden");
    }
    if (req.method !== "POST") return end(res, 405, "Method not allowed");

    const raw = await readBody(req);
    if (!verifySignature(deps.appSecret, raw, header(req, "x-hub-signature-256"))) return end(res, 401, "Bad signature");

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return end(res, 400, "Bad JSON");
    }
    end(res, 200, "OK");
    for (const message of parseInbound(payload)) void enqueue(message);
  };

  return { handler, enqueue };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function end(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(body);
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("Body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const isEntryPoint = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntryPoint) {
  const config = loadConfig();
  const business = loadBusiness(config.businessFile);
  const agent = new WhatsAppAgent({
    business,
    conversations: new InMemoryConversationStore(),
    bookings: new InMemoryBookingStore(),
    createMessage: createMessageWithClient(new Anthropic()),
    model: config.model,
    effort: config.effort,
    onHandoff: (customerId, reason) => console.log(`[handoff] ${customerId}: ${reason}`),
  });
  const sender = new CloudApiSender(config.whatsapp.accessToken, config.whatsapp.phoneNumberId, config.whatsapp.graphVersion);
  const { handler } = createWebhookHandler({ agent, sender, appSecret: config.whatsapp.appSecret, verifyToken: config.whatsapp.verifyToken });
  createServer((req, res) => {
    handler(req, res).catch((error) => {
      console.error("Webhook error", error);
      if (!res.headersSent) end(res, 500, "Error");
    });
  }).listen(config.port, () => console.log(`${business.name} agent listening on :${config.port}/webhook (model ${config.model})`));
}
