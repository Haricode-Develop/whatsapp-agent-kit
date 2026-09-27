# Contributing

Thanks for helping. This kit stays small on purpose: a readable starting point, not a framework.

- Open an issue before a large change so we can agree on the shape first.
- Keep runtime dependencies at one (`@anthropic-ai/sdk`).
- `npm test` and `npm run typecheck` must pass. Tests never call the network.
- Keep the system prompt and the tool list byte-stable between requests (see the caching note in `src/business.ts`).

Issues labelled **good first issue** are a good place to start.
