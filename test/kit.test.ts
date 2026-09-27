import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BetaMessage, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { FALLBACK_REPLY, WhatsAppAgent, localStamp } from "../src/agent.js";
import { buildSystemPrompt, loadBusiness } from "../src/business.js";
import { InMemoryBookingStore, InMemoryConversationStore, candidateSlots } from "../src/store.js";
import { runTool } from "../src/tools.js";
import { parseInbound, splitMessage, verifySignature } from "../src/whatsapp.js";
import { createWebhookHandler } from "../src/server.js";

const business = loadBusiness("examples/business.example.json");
// Monday 2026-09-28, 10:00 in Guatemala (UTC-6).
const MONDAY = new Date("2026-09-28T16:00:00Z");

describe("webhook signature", () => {
  const body = Buffer.from('{"entry":[]}');
  const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("accepts Meta's signature and rejects anything else", () => {
    expect(verifySignature("s3cret", body, sign("s3cret"))).toBe(true);
    expect(verifySignature("s3cret", body, sign("other"))).toBe(false);
    expect(verifySignature("s3cret", body, undefined)).toBe(false);
    expect(verifySignature("s3cret", body, "sha256=zz")).toBe(false);
  });
});

describe("inbound parsing", () => {
  it("reads text, describes media and ignores status updates", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "50255550000", profile: { name: "Ana" } }],
                messages: [
                  { id: "m1", from: "50255550000", type: "text", text: { body: "Hola" } },
                  { id: "m2", from: "50255550000", type: "audio", audio: {} },
                  { id: "m3", from: "50255550000", type: "reaction", reaction: {} },
                ],
                statuses: [{ id: "s1", status: "delivered" }],
              },
            },
          ],
        },
      ],
    };
    const messages = parseInbound(payload);
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(messages[0]).toMatchObject({ from: "50255550000", customerName: "Ana", text: "Hola" });
    expect(messages[1]!.text).toContain("voice note");
  });

  it("splits long replies under the WhatsApp limit", () => {
    const chunks = splitMessage("word ".repeat(2000), 4000);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length <= 4000)).toBe(true);
  });
});

describe("system prompt", () => {
  it("is deterministic so the prompt cache keeps hitting", () => {
    expect(buildSystemPrompt(business)).toBe(buildSystemPrompt(loadBusiness("examples/business.example.json")));
    expect(buildSystemPrompt(business)).toContain("Relaxing massage: GTQ 350");
  });

  it("stamps each message with the business-local time", () => {
    expect(localStamp(MONDAY, "America/Guatemala")).toBe("Mon 2026-09-28 10:00");
  });
});

describe("booking tools", () => {
  const ctx = () => ({ business, bookings: new InMemoryBookingStore(), conversations: new InMemoryConversationStore(), customerId: "c1" });

  it("offers slots inside opening hours only", () => {
    expect(candidateSlots(business, "2026-09-28", 60)).toEqual(["09:00", "10:00", "11:00", "12:00", "14:00", "15:00", "16:00", "17:00"]);
    expect(candidateSlots(business, "2026-09-27", 60)).toEqual([]); // Sunday: closed
  });

  it("books once and refuses a double booking or an invalid time", async () => {
    const c = ctx();
    const input = { date: "2026-09-28", time: "10:00", service: "classic facial", customer_name: "Ana" };
    expect((await runTool("book_appointment", input, c)).isError).toBeUndefined();
    expect((await runTool("book_appointment", input, c)).isError).toBe(true);
    expect((await runTool("book_appointment", { ...input, time: "13:00" }, c)).isError).toBe(true);
    const free = await runTool("check_availability", { date: "2026-09-28", service: "Classic facial" }, c);
    expect(free.content).not.toContain("10:00");
    expect(free.content).toContain("11:00");
  });
});

// A scripted stand-in for client.beta.messages.create.
function scripted(responses: Array<Partial<BetaMessage>>) {
  const calls: MessageCreateParamsNonStreaming[] = [];
  const createMessage = async (params: MessageCreateParamsNonStreaming) => {
    calls.push(structuredClone(params));
    const next = responses.shift();
    if (!next) throw new Error("No scripted response left");
    return { id: "msg", type: "message", role: "assistant", model: params.model, usage: {}, ...next } as BetaMessage;
  };
  return { createMessage, calls };
}

describe("agent loop", () => {
  it("runs tools, returns the final text and stores the turn append-only", async () => {
    const conversations = new InMemoryConversationStore();
    const bookings = new InMemoryBookingStore();
    const { createMessage, calls } = scripted([
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "check_availability", input: { date: "2026-09-29", service: "Relaxing massage" } }] as BetaMessage["content"],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Tomorrow I have 09:00 or 10:00. Which one works?", citations: null }] as BetaMessage["content"] },
    ]);
    const agent = new WhatsAppAgent({ business, conversations, bookings, createMessage, now: () => MONDAY });

    const reply = await agent.reply("c1", "Do you have a massage tomorrow?");
    expect(reply).toBe("Tomorrow I have 09:00 or 10:00. Which one works?");

    // Same cached prefix on both calls, and the defaults this kit promises.
    expect(calls[0]).toMatchObject({ model: "claude-opus-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    expect(calls[1]!.system).toEqual(calls[0]!.system);
    expect(calls[1]!.tools).toEqual(calls[0]!.tools);
    const toolResult = (calls[1]!.messages.at(-1)!.content as Array<{ type: string; content: string }>)[0]!;
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.content).toContain("09:00");

    const history = await conversations.history("c1");
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(String(history[0]!.content)).toMatch(/^\[received Mon 2026-09-28 10:00 America\/Guatemala\]\nDo you have/);
  });

  it("goes quiet after a handoff until a person releases the conversation", async () => {
    const conversations = new InMemoryConversationStore();
    const handoffs: string[] = [];
    const { createMessage, calls } = scripted([
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "handoff_to_human", input: { reason: "Asks about pregnancy" } }] as BetaMessage["content"],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Someone from the team will continue with you.", citations: null }] as BetaMessage["content"] },
    ]);
    const agent = new WhatsAppAgent({ business, conversations, bookings: new InMemoryBookingStore(), createMessage, onHandoff: (_c, r) => void handoffs.push(r) });

    expect(await agent.reply("c1", "I'm pregnant, can I get a massage?")).toContain("team");
    expect(handoffs).toEqual(["Asks about pregnancy"]);
    expect(await agent.reply("c1", "hello?")).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("hands off with a neutral reply when the model declines", async () => {
    const conversations = new InMemoryConversationStore();
    const { createMessage } = scripted([{ stop_reason: "refusal", content: [] }]);
    const agent = new WhatsAppAgent({ business, conversations, bookings: new InMemoryBookingStore(), createMessage });
    expect(await agent.reply("c1", "…")).toBe(FALLBACK_REPLY);
    expect(await conversations.isWithHuman("c1")).toBe(true);
  });
});

describe("webhook handler", () => {
  it("answers each message once, in order per customer", async () => {
    const replies: string[] = [];
    const agent = { reply: async (_from: string, text: string) => `echo ${text}` };
    const sender = { sendText: async (_to: string, body: string) => void replies.push(body) };
    const { enqueue } = createWebhookHandler({ agent, sender, appSecret: "x", verifyToken: "y", log: () => {} });
    const msg = (id: string, text: string) => ({ id, from: "502", text, type: "text" });
    await Promise.all([enqueue(msg("a", "1")), enqueue(msg("b", "2")), enqueue(msg("a", "1"))]);
    expect(replies).toEqual(["echo 1", "echo 2"]);
  });
});
