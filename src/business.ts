import { readFileSync } from "node:fs";

/** Everything the agent is allowed to know about the business. Loaded once at startup. */
export interface BusinessProfile {
  name: string;
  description: string;
  /** IANA time zone, e.g. "America/Guatemala". Dates and times the agent handles are local to it. */
  timezone: string;
  /** Language the business normally writes in; the agent still answers in the customer's language. */
  defaultLanguage: string;
  locations?: string[];
  services: Service[];
  /** Weekly opening hours used to offer appointment slots, e.g. { "mon": ["09:00-13:00", "14:00-18:00"] }. */
  openingHours: Partial<Record<Weekday, string[]>>;
  faq: Array<{ question: string; answer: string }>;
  policies?: string[];
  /** When the agent must stop and pass the conversation to a person. */
  handoffWhen?: string[];
}

export interface Service {
  name: string;
  price: number;
  currency: string;
  durationMinutes: number;
  description?: string;
}

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export function loadBusiness(path: string): BusinessProfile {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parseBusiness(raw);
}

export function parseBusiness(raw: unknown): BusinessProfile {
  if (!raw || typeof raw !== "object") throw new Error("Business profile must be a JSON object");
  const b = raw as BusinessProfile;
  for (const field of ["name", "description", "timezone", "defaultLanguage"] as const) {
    if (typeof b[field] !== "string" || !b[field].trim()) throw new Error(`Business profile: "${field}" is required`);
  }
  if (!Array.isArray(b.services) || b.services.length === 0) throw new Error('Business profile: "services" needs at least one service');
  for (const s of b.services) {
    if (!s.name || typeof s.price !== "number" || !s.currency || !(s.durationMinutes > 0)) {
      throw new Error(`Business profile: service "${s.name ?? "?"}" needs name, price, currency and durationMinutes`);
    }
  }
  if (!b.openingHours || typeof b.openingHours !== "object") throw new Error('Business profile: "openingHours" is required');
  if (!Array.isArray(b.faq)) throw new Error('Business profile: "faq" must be an array (it can be empty)');
  return b;
}

/**
 * The system prompt. It must be byte-for-byte identical on every request so the prompt
 * cache keeps hitting: no timestamps, no per-customer data, stable ordering. The current
 * time travels with each customer message instead (see agent.ts).
 */
export function buildSystemPrompt(b: BusinessProfile): string {
  const services = b.services
    .map((s) => `- ${s.name}: ${s.currency} ${s.price} · ${s.durationMinutes} min${s.description ? ` · ${s.description}` : ""}`)
    .join("\n");
  const hours = WEEKDAYS.filter((d) => b.openingHours[d]?.length)
    .map((d) => `- ${d}: ${b.openingHours[d]!.join(", ")}`)
    .join("\n");
  const faq = b.faq.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n");
  const list = (items: string[] | undefined, indent = "") =>
    items?.length ? items.map((i) => `${indent}- ${i}`).join("\n") : `${indent}- (none)`;

  return `You are the WhatsApp assistant of ${b.name}. You talk with customers on behalf of the business.

# The business
${b.description}
Time zone: ${b.timezone}
${b.locations?.length ? `Locations:\n${list(b.locations)}\n` : ""}
# Services and prices
${services}

# Opening hours
${hours || "- Not published"}

# Frequently asked questions
${faq || "(none)"}

# Policies
${list(b.policies)}

# How you work
- Answer only with the information above or what your tools return. If something is not here, say you will check with the team and call handoff_to_human. Never invent prices, discounts, availability or policies.
- Reply in the language of the customer's most recent message. The business normally writes in "${b.defaultLanguage}".
- Write like a person on WhatsApp: short messages, plain text, no headings or tables. One question at a time.
- To offer times, call check_availability. To book, confirm the service, date, time and the customer's name, then call book_appointment. Only say an appointment is booked after the tool confirms it.
- Each customer message starts with a line like [received Sat 2026-09-27 10:31 ${b.timezone}]. Use it to resolve "today", "tomorrow" or "next Monday". Never repeat that line to the customer.
- Hand the conversation to a person (handoff_to_human) when the customer asks for one, is upset, or when:
${list(b.handoffWhen, "  ")}
  After a handoff, tell the customer that someone from the team will continue, and stop.`;
}
