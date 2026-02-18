# wopr-plugin-line

`@wopr-network/wopr-plugin-line` — LINE channel plugin for WOPR using the official LINE Bot SDK.

## Commands

```bash
bun run build       # tsc
bun run dev         # tsc --watch
bun run check       # biome check + tsc --noEmit (run before committing)
bun run lint:fix    # biome check --fix src/
bun run format      # biome format --write src/
bun test            # vitest run
```

**Linter/formatter is Biome.** Never add ESLint/Prettier config.

## Architecture

```
src/
  index.ts   # Plugin entry — exports WOPRPlugin default, wires LINE webhook server, registers ChannelProvider
  types.ts   # Re-exports from @wopr-network/plugin-types
```

## Key Details

- **Framework**: `@line/bot-sdk` (official LINE Bot SDK for Node.js)
- **Module system**: ESM (`"type": "module"`)
- **Plugin contract**: Imports from `@wopr-network/plugin-types` — never from wopr core internals
- **Webhook-only**: LINE does not support long-polling; plugin runs an Express HTTP server
- **ChannelProvider**: Registered via `ctx.registerChannelProvider()` in `init()`, unregistered in `shutdown()`
- **Credentials**: `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_CHANNEL_SECRET` env vars or plugin config
- **Signature validation**: Enforced by SDK middleware (raw body required — no global body parser)

## Plugin Contract

```typescript
import type { WOPRPlugin, WOPRPluginContext, ChannelProvider } from "@wopr-network/plugin-types";
```

The default export must satisfy `WOPRPlugin`. The plugin receives `WOPRPluginContext` at `init()` time.

## Issue Tracking

All issues in **Linear** (team: WOPR). Issue descriptions start with `**Repo:** wopr-network/wopr-plugin-line`.
