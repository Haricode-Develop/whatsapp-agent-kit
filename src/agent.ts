import type Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { buildSystemPrompt, type BusinessProfile } from "./business.js";
import type { BookingStore, ConversationStore } from "./store.js";
import { TOOLS, runTool } from "./tools.js";

export type CreateMessage = (params: MessageCreateParamsNonStreaming) => Promise<BetaMessage>;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentOptions {
  business: BusinessProfile;
  conversations: ConversationStore;
  bookings: BookingStore;
  /** Usually `(p) => client.beta.messages.create(p)`; injectable so tests run without the network. */
  createMessage: CreateMessage;
  model?: string;
  effort?: Effort;
  /** Upper bound on model round-trips per customer message (tool calls included). */
  maxSteps?: number;
  now?: () => Date;
  onHandoff?: (customerId: string, reason: string) => void | Promise<void>;
}

/** What the agent says when it can't continue (refusal, loop limit). Neutral on purpose: the language is unknown here. */
export const FALLBACK_REPLY = "Thanks for your message. Someone from our team will get back to you shortly.";

export function createMessageWithClient(client: Anthropic): CreateMessage {
  return (params) => client.beta.messages.create(params);
}

export class WhatsAppAgent {
  private readonly system: string;
  private readonly model: string;
  private readonly effort: Effort;
  private readonly maxSteps: number;
  private readonly now: () => Date;

  constructor(private readonly opts: AgentOptions) {
    this.system = buildSystemPrompt(opts.business);
    this.model = opts.model ?? "claude-opus-5";
    // Chat is latency-sensitive and mostly simple; raise it if your evals show headroom.
    this.effort = opts.effort ?? "medium";
    this.maxSteps = opts.maxSteps ?? 8;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Handle one inbound customer message and return the text to send back, or null when a
   * person already has the conversation (the agent stays quiet until released).
   */
  async reply(customerId: string, text: string): Promise<string | null> {
    const { conversations } = this.opts;
    if (await conversations.isWithHuman(customerId)) {
      await conversations.append(customerId, { role: "user", content: this.stamp(text) });
      return null;
    }

    const turn: BetaMessageParam[] = [{ role: "user", content: this.stamp(text) }];
    const replyParts: string[] = [];

    for (let step = 0; step < this.maxSteps; step++) {
      const history = await conversations.history(customerId);
      const response = await this.opts.createMessage(this.request([...history, ...turn]));

      if (response.stop_reason === "refusal") {
        // The whole fallback chain declined. Don't store the refused turn; a person takes over.
        await conversations.append(customerId, ...turn);
        await conversations.setWithHuman(customerId, true);
        await this.opts.onHandoff?.(customerId, "The model declined to answer this conversation.");
        return FALLBACK_REPLY;
      }

      // Keep the full content (thinking blocks included) so the next request replays it unchanged.
      turn.push({ role: "assistant", content: response.content });
      for (const block of response.content) if (block.type === "text" && block.text.trim()) replyParts.push(block.text.trim());

      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason !== "tool_use") break;

      const calls = response.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
      const results: BetaToolResultBlockParam[] = [];
      for (const call of calls) {
        const outcome = await runTool(call.name, call.input, { ...this.opts, customerId });
        results.push({ type: "tool_result", tool_use_id: call.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
      }
      // All results go back in a single user message.
      turn.push({ role: "user", content: results });

      if (step === this.maxSteps - 1) {
        replyParts.push(FALLBACK_REPLY);
      }
    }

    await conversations.append(customerId, ...turn);
    return replyParts.length ? replyParts.join("\n\n") : FALLBACK_REPLY;
  }

  private request(messages: BetaMessageParam[]): MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: 16000,
      // If the model declines, the API re-runs the request on Anthropic's recommended fallback.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: this.effort },
      // Tools + system are identical on every request: one breakpoint caches them for all customers.
      tools: TOOLS,
      system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
      // Automatic caching of the conversation so far, for customers who write several messages in a row.
      cache_control: { type: "ephemeral" },
      messages,
    };
  }

  /** The time travels with the message, not in the system prompt, so the cached prefix never changes. */
  private stamp(text: string): string {
    return `[received ${localStamp(this.now(), this.opts.business.timezone)} ${this.opts.business.timezone}]\n${text}`;
  }
}

/** "Sat 2026-09-27 10:31" in the given time zone. */
export function localStamp(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
