import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { BusinessProfile } from "./business.js";
import { candidateSlots, type BookingStore, type ConversationStore } from "./store.js";

// The tool list is part of the cached prompt prefix: keep it static and in this order.
export const TOOLS: BetaTool[] = [
  {
    name: "check_availability",
    description:
      "List the free start times for a service on a given date. Call it before offering times to a customer. Dates are in the business time zone.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format, business-local." },
        service: { type: "string", description: "Exact service name as listed in the business profile." },
      },
      required: ["date", "service"],
      additionalProperties: false,
    },
  },
  {
    name: "book_appointment",
    description:
      "Book a confirmed appointment. Only call it after the customer has agreed to the service, date and time and has given their name.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format, business-local." },
        time: { type: "string", description: "Start time in HH:MM (24h), one of the times check_availability returned." },
        service: { type: "string", description: "Exact service name as listed in the business profile." },
        customer_name: { type: "string", description: "The name the customer gave." },
      },
      required: ["date", "time", "service", "customer_name"],
      additionalProperties: false,
    },
  },
  {
    name: "handoff_to_human",
    description:
      "Pass the conversation to a person on the team. After calling it, tell the customer someone will continue, and stop answering.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "One sentence for the team: why a person is needed." },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
];

export interface ToolContext {
  business: BusinessProfile;
  bookings: BookingStore;
  conversations: ConversationStore;
  customerId: string;
  /** Called when the agent hands off, so the team can be notified (email, Slack, a CRM…). */
  onHandoff?: (customerId: string, reason: string) => void | Promise<void>;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const args = (input ?? {}) as Record<string, string>;
  const findService = (serviceName: string) =>
    ctx.business.services.find((s) => s.name.toLowerCase() === String(serviceName).trim().toLowerCase());

  switch (name) {
    case "check_availability": {
      if (!DATE.test(args.date ?? "")) return { content: "date must be YYYY-MM-DD", isError: true };
      const service = findService(args.service ?? "");
      if (!service) return { content: `Unknown service. Valid services: ${ctx.business.services.map((s) => s.name).join(", ")}`, isError: true };
      const free: string[] = [];
      for (const time of candidateSlots(ctx.business, args.date!, service.durationMinutes)) {
        if (!(await ctx.bookings.isTaken(args.date!, time))) free.push(time);
      }
      return { content: free.length ? `Free times on ${args.date} for ${service.name}: ${free.join(", ")}` : `No free times on ${args.date} for ${service.name}. The business is closed or fully booked that day.` };
    }
    case "book_appointment": {
      if (!DATE.test(args.date ?? "") || !TIME.test(args.time ?? "")) return { content: "date must be YYYY-MM-DD and time HH:MM", isError: true };
      const service = findService(args.service ?? "");
      if (!service) return { content: "Unknown service", isError: true };
      if (!candidateSlots(ctx.business, args.date!, service.durationMinutes).includes(args.time!)) {
        return { content: `${args.time} is not a valid start time for ${service.name} on ${args.date}. Call check_availability first.`, isError: true };
      }
      if (await ctx.bookings.isTaken(args.date!, args.time!)) return { content: "That time was just taken. Offer another one.", isError: true };
      await ctx.bookings.add({ date: args.date!, time: args.time!, service: service.name, customerId: ctx.customerId, customerName: String(args.customer_name ?? "").trim() });
      return { content: `Booked: ${service.name} on ${args.date} at ${args.time} for ${args.customer_name}.` };
    }
    case "handoff_to_human": {
      await ctx.conversations.setWithHuman(ctx.customerId, true);
      await ctx.onHandoff?.(ctx.customerId, String(args.reason ?? ""));
      return { content: "Handed off. A person will continue this conversation." };
    }
    default:
      return { content: `Unknown tool ${name}`, isError: true };
  }
}
