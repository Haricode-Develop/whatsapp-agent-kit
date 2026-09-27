import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { WEEKDAYS, type BusinessProfile } from "./business.js";

/**
 * Conversation history per customer. The history is append-only on purpose: the API
 * caches the conversation prefix and newer models bind their thinking blocks to it, so
 * rewriting an earlier turn costs money and reasoning. Swap the in-memory versions for
 * Redis or Postgres in production; the interfaces are all the agent depends on.
 */
export interface ConversationStore {
  history(customerId: string): Promise<BetaMessageParam[]>;
  append(customerId: string, ...messages: BetaMessageParam[]): Promise<void>;
  isWithHuman(customerId: string): Promise<boolean>;
  setWithHuman(customerId: string, withHuman: boolean): Promise<void>;
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly threads = new Map<string, BetaMessageParam[]>();
  private readonly withHuman = new Set<string>();

  async history(customerId: string) {
    return [...(this.threads.get(customerId) ?? [])];
  }
  async append(customerId: string, ...messages: BetaMessageParam[]) {
    const thread = this.threads.get(customerId) ?? [];
    thread.push(...messages);
    this.threads.set(customerId, thread);
  }
  async isWithHuman(customerId: string) {
    return this.withHuman.has(customerId);
  }
  async setWithHuman(customerId: string, value: boolean) {
    if (value) this.withHuman.add(customerId);
    else this.withHuman.delete(customerId);
  }
}

export interface Booking {
  date: string; // YYYY-MM-DD, business-local
  time: string; // HH:MM, business-local
  service: string;
  customerId: string;
  customerName: string;
}

export interface BookingStore {
  isTaken(date: string, time: string): Promise<boolean>;
  add(booking: Booking): Promise<void>;
  list(): Promise<Booking[]>;
}

export class InMemoryBookingStore implements BookingStore {
  private readonly bookings: Booking[] = [];
  async isTaken(date: string, time: string) {
    return this.bookings.some((b) => b.date === date && b.time === time);
  }
  async add(booking: Booking) {
    this.bookings.push(booking);
  }
  async list() {
    return [...this.bookings];
  }
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const toHHMM = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Start times on a date where a service of the given length fits inside the opening hours. One booking per slot. */
export function candidateSlots(business: BusinessProfile, date: string, durationMinutes: number): string[] {
  const day = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(day.getTime())) return [];
  const weekday = WEEKDAYS[day.getUTCDay()]!;
  const ranges = business.openingHours[weekday] ?? [];
  const slots: string[] = [];
  for (const range of ranges) {
    const [open, close] = range.split("-").map((t) => toMinutes(t.trim()));
    if (open === undefined || close === undefined) continue;
    for (let start = open; start + durationMinutes <= close; start += durationMinutes) slots.push(toHHMM(start));
  }
  return slots;
}
