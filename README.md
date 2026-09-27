# WhatsApp Agent Kit

A small, production-minded starting point for an AI agent that answers a business's WhatsApp: it replies with the business's own services, prices and hours, offers real appointment times, books them, and hands the conversation to a person when it should.

Built on the official **WhatsApp Cloud API** and **Claude** (`@anthropic-ai/sdk`). About 700 lines of TypeScript, one runtime dependency, and tests that run without the network.

It comes from building [Dilo](https://www.dilotodo.com/en), an AI agent that runs WhatsApp for small businesses in Latin America, at [Haricode](https://www.haricode.tech/). In Latin America, WhatsApp is where customers ask, book and buy. This kit contains the parts we'd want on day one, without the rest of our product.

## What you get

- **Webhook that behaves like Meta expects:** signature verification on the raw body (`X-Hub-Signature-256`), an immediate `200`, de-duplication of retried deliveries, and each customer's messages handled strictly in order.
- **An agent loop you can read in one sitting** (`src/agent.ts`): tool calls, pause/resume, refusals, and a step limit.
- **Three tools with strict schemas:** `check_availability`, `book_appointment`, `handoff_to_human`. Double bookings and times outside opening hours are rejected by the code, not left to the model.
- **Prompt caching that actually hits:** the system prompt and tools are byte-identical on every request (the current time travels with each message instead), so the business profile is cached across all customers.
- **Append-only conversation history:** better cache reuse, and the model's reasoning from earlier turns stays valid.
- **Answers in the customer's language**, whatever language the business writes in.
- **Refusal fallback on by default:** if the model declines a request, the API retries it on Anthropic's recommended fallback model (`fallbacks: "default"`). If the whole chain declines, a person takes over.
- **Media handled gracefully:** voice notes, images and documents get a polite answer instead of silence.

## Quick start

```bash
npm install
cp .env.example .env         # add ANTHROPIC_API_KEY at least
npm run chat                 # talk to the example business in your terminal
```

`examples/business.example.json` describes a fictional spa. Copy it and describe your own business: services with price and duration, opening hours, FAQ, policies, and when a person must take over.

## Connect WhatsApp

1. In [Meta for Developers](https://developers.facebook.com/), create an app with the WhatsApp product and note the phone number ID, an access token and the app secret.
2. Fill in the `WHATSAPP_*` variables in `.env` and run `npm start`.
3. Expose the port over HTTPS (for example with a tunnel) and set the webhook URL to `https://<your-host>/webhook`, with the same verify token. Subscribe to the `messages` field.
4. Write to your business number.

## Before production

The in-memory stores are for trying things out. Implement `ConversationStore` and `BookingStore` (`src/store.ts`) on your database, and keep the history append-only. Then:

- **Measure effort and model on your own conversations.** The default is `claude-opus-5` at `medium` effort. Chat is latency-sensitive, so build a small eval from real transcripts before you change either one.
- **Long threads:** WhatsApp conversations can run for months. Add server-side compaction or start a new thread after a period of silence.
- **The 24-hour window:** WhatsApp only lets a business send free-form messages within 24 hours of the customer's last message. Reminders outside that window need approved templates.
- **Notify your team on handoff** through the `onHandoff` callback: email, Slack, your CRM.

## Project layout

```
src/business.ts   business profile and the (cache-stable) system prompt
src/agent.ts      the agent loop
src/tools.ts      tool definitions and handlers
src/store.ts      conversation and booking stores, slot calculation
src/whatsapp.ts   signature check, payload parsing, Cloud API sender
src/server.ts     the webhook (Node http, no framework)
src/cli.ts        terminal chat for local testing
test/             vitest suite, no network needed
```

## License

MIT © Haricode
