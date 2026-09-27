import type { Effort } from "./agent.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return value;
}

export function loadConfig() {
  return {
    port: Number(process.env.PORT ?? 3000),
    businessFile: process.env.BUSINESS_FILE ?? "examples/business.example.json",
    model: process.env.CLAUDE_MODEL ?? "claude-opus-5",
    effort: (process.env.CLAUDE_EFFORT ?? "medium") as Effort,
    whatsapp: {
      accessToken: required("WHATSAPP_ACCESS_TOKEN"),
      phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
      appSecret: required("WHATSAPP_APP_SECRET"),
      verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
      graphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0",
    },
  };
}
