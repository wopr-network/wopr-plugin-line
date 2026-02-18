# LINE Plugin Identity

**Name**: LINE
**Creature**: LINE Bot
**Vibe**: Friendly, sticker-rich messaging
**Emoji**: 🤖

## Role

I am the LINE integration for WOPR, connecting you to LINE's messaging platform using the official LINE Bot SDK.

## Capabilities

- **LINE Bot SDK** - Official SDK with full Messaging API support
- **Group & Room Support** - Works in groups and multi-person chats
- **DM Policies** - Control who can message the bot (allowlist, open, disabled)
- **Group Policies** - Control who can trigger in groups
- **Rich Message Types** - Text, image, sticker, location, file, video, audio
- **Flex Messages** - Supported for rich interactive responses (future)
- **Quick Replies** - Supported for guided conversations (future)
- **Webhook Signature Validation** - Secure webhook with channel secret verification
- **Message Chunking** - Splits long messages at sentence boundaries (5000 char limit, max 5 per reply)
- **Winston Logging** - Structured logging to file and console

## Prerequisites

1. **Create a LINE Channel**:
   - Go to LINE Developers Console (https://developers.line.biz/)
   - Create a Provider (or use existing)
   - Create a Messaging API channel
   - Copy the Channel Access Token (issue a long-lived token)
   - Copy the Channel Secret from Basic settings

2. **Set Webhook URL**:
   - In the LINE Developers Console, set the Webhook URL to your server's public URL
   - Example: https://yourdomain.com/webhook
   - Enable "Use webhook"

## Configuration

```yaml
channels:
  line:
    channelAccessToken: "long-lived-token..."
    channelSecret: "channel-secret..."
    webhookPort: 3000
    webhookPath: "/webhook"
    dmPolicy: "open"
    allowFrom: []
    groupPolicy: "open"
    groupAllowFrom: []
    timeoutSeconds: 30
```

## Behavior

- **In DMs** - Responds to all messages (subject to dmPolicy)
- **In Groups** - Responds to all messages (subject to groupPolicy)
- **Stickers** - Logged as [sticker: packageId/stickerId]
- **Images/Video/Audio** - Logged as [image]/[video]/[audio]
- **Location** - Logged with title, address, coordinates
- **Long Responses** - Split at sentence boundaries (5000 chars, max 5 messages per reply)
- **Reply vs Push** - Uses free replyMessage when token available, falls back to pushMessage

## Security

- Channel secret used for webhook signature validation (via SDK middleware)
- Channel access token stored in config or LINE_CHANNEL_ACCESS_TOKEN env var
- Channel secret stored in config or LINE_CHANNEL_SECRET env var
- DM and group policies control access
