// Talk to the agent from the terminal, without WhatsApp. Needs only Anthropic credentials.
//   npm run chat                       (uses examples/business.example.json)
//   BUSINESS_FILE=my-business.json npm run chat
import { createInterface } from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";
import { WhatsAppAgent, createMessageWithClient, type Effort } from "./agent.js";
import { loadBusiness } from "./business.js";
import { InMemoryBookingStore, InMemoryConversationStore } from "./store.js";

const business = loadBusiness(process.env.BUSINESS_FILE ?? "examples/business.example.json");
const bookings = new InMemoryBookingStore();
const agent = new WhatsAppAgent({
  business,
  conversations: new InMemoryConversationStore(),
  bookings,
  createMessage: createMessageWithClient(new Anthropic()),
  model: process.env.CLAUDE_MODEL ?? "claude-opus-5",
  effort: (process.env.CLAUDE_EFFORT ?? "medium") as Effort,
  onHandoff: (_id, reason) => console.log(`\n[handed off to a person: ${reason}]`),
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log(`Chatting with the ${business.name} agent. Type your message, or "exit".\n`);
for (;;) {
  const text = (await rl.question("you › ")).trim();
  if (!text) continue;
  if (text === "exit") break;
  const reply = await agent.reply("terminal", text);
  console.log(`\n${business.name} › ${reply ?? "(a person has this conversation now)"}\n`);
}
const booked = await bookings.list();
if (booked.length) console.log("Bookings made:", booked);
rl.close();
