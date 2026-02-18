# wopr-plugin-line

LINE channel plugin for WOPR using the LINE Bot SDK.

## Commands

```bash
npm run build     # tsc
npm test          # jest
npm run lint      # eslint
```

## Architecture

```
src/
  index.ts   # Plugin entry — exports WOPRPlugin default, wires LINE webhook server
  types.ts   # Plugin-local types
```

## Key Details

- **Framework**: @line/bot-sdk (official LINE Bot SDK for Node.js)
- Implements `WOPRPlugin` contract from plugin-local types (same as wopr-plugin-telegram)
- Webhook-only (LINE does not support long-polling)
- Credentials configured via plugin config schema (channelAccessToken + channelSecret)
- Signature validation via SDK middleware

## Plugin Contract

Imports only from local types. Never import from `@wopr-network/wopr` core.

## Issue Tracking

All issues in **Linear** (team: WOPR). Issue descriptions start with `**Repo:** wopr-network/wopr-plugin-line`.
