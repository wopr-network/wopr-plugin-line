# wopr-plugin-line

LINE channel plugin for [WOPR](https://github.com/wopr-network/wopr) using the official LINE Bot SDK.

## Features

- LINE Bot SDK integration (webhook-only, no polling)
- Supports text, image, sticker, location, file, video, and audio messages
- DM and group message policies (open, allowlist, disabled)
- Webhook signature validation via channel secret
- Message chunking for long responses (5000 char limit, max 5 per reply)
- Fallback from replyMessage to pushMessage on expired tokens
- Winston structured logging

## Installation

```bash
wopr plugin install wopr-plugin-line
```

## Configuration

Set credentials via environment variables:

```bash
export LINE_CHANNEL_ACCESS_TOKEN="your-channel-access-token"
export LINE_CHANNEL_SECRET="your-channel-secret"
```

Or configure via `wopr configure --plugin line`.

## Setup

1. Go to [LINE Developers Console](https://developers.line.biz/)
2. Create a Messaging API channel
3. Issue a long-lived channel access token
4. Copy the channel secret
5. Set your webhook URL in the console: `https://yourdomain.com/webhook`
6. Enable "Use webhook"
7. Start WOPR: `wopr daemon start`

## License

MIT
