/**
 * WOPR LINE Plugin
 *
 * LINE Messaging API integration via @line/bot-sdk.
 * Webhook-only (LINE does not support long-polling).
 * Registers a ChannelProvider so other WOPR systems can send LINE messages.
 */

import http from "node:http";
import express from "express";
import {
  HTTPFetchError,
  JSONParseError,
  SignatureValidationFailed,
  messagingApi,
  middleware,
  webhook,
} from "@line/bot-sdk";
import type { ChannelProvider, ConfigSchema, WOPRPlugin, WOPRPluginContext } from "./types.js";

// ============================================================================
// Config interface
// ============================================================================

interface LINEConfig {
  channelAccessToken?: string;
  channelSecret?: string;
  webhookPort?: number;
  webhookPath?: string;
  dmPolicy?: "allowlist" | "open" | "disabled";
  allowFrom?: string[];
  groupPolicy?: "allowlist" | "open" | "disabled";
  groupAllowFrom?: string[];
}

// ============================================================================
// Module-level state
// ============================================================================

let ctx: WOPRPluginContext | null = null;
let config: LINEConfig = {};
let lineClient: messagingApi.MessagingApiClient | null = null;
let server: http.Server | null = null;

// ============================================================================
// Config schema
// ============================================================================

const configSchema: ConfigSchema = {
  title: "LINE Integration",
  description: "Configure LINE Bot integration using LINE Bot SDK",
  fields: [
    {
      name: "channelAccessToken",
      type: "password",
      label: "Channel Access Token",
      placeholder: "Long-lived channel access token",
      required: true,
      description: "Get from LINE Developers Console > Messaging API",
    },
    {
      name: "channelSecret",
      type: "password",
      label: "Channel Secret",
      placeholder: "Channel secret for signature validation",
      required: true,
      description: "Get from LINE Developers Console > Basic settings",
    },
    {
      name: "webhookPort",
      type: "number",
      label: "Webhook Port",
      placeholder: "3000",
      default: 3000,
      description: "Port for the webhook HTTP server",
    },
    {
      name: "webhookPath",
      type: "text",
      label: "Webhook Path",
      placeholder: "/webhook",
      default: "/webhook",
      description: "URL path for the webhook endpoint",
    },
    {
      name: "dmPolicy",
      type: "select",
      label: "DM Policy",
      placeholder: "open",
      default: "open",
      description: "How to handle direct (1-on-1) messages",
    },
    {
      name: "allowFrom",
      type: "array",
      label: "Allowed User IDs",
      placeholder: "U1234567890abcdef...",
      description: "LINE user IDs allowed to DM (for allowlist policy)",
    },
    {
      name: "groupPolicy",
      type: "select",
      label: "Group Policy",
      placeholder: "open",
      default: "open",
      description: "How to handle group/room messages",
    },
    {
      name: "groupAllowFrom",
      type: "array",
      label: "Allowed Group Senders",
      placeholder: "U1234567890abcdef...",
      description: "User IDs allowed to trigger in groups (for allowlist policy)",
    },
  ],
};

// ============================================================================
// Credential resolution
// ============================================================================

function resolveCredentials(): { channelAccessToken: string; channelSecret: string } {
  const channelAccessToken = config.channelAccessToken ?? process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const channelSecret = config.channelSecret ?? process.env.LINE_CHANNEL_SECRET;

  if (!channelAccessToken) {
    throw new Error(
      "LINE channel access token required. Set channels.line.channelAccessToken or LINE_CHANNEL_ACCESS_TOKEN env var.",
    );
  }
  if (!channelSecret) {
    throw new Error(
      "LINE channel secret required. Set channels.line.channelSecret or LINE_CHANNEL_SECRET env var.",
    );
  }

  return { channelAccessToken, channelSecret };
}

// ============================================================================
// Access control
// ============================================================================

export function isAllowed(userId: string, isGroup: boolean): boolean {
  if (isGroup) {
    const policy = config.groupPolicy ?? "open";
    if (policy === "open") return true;
    if (policy === "disabled") return false;
    const allowed = config.groupAllowFrom ?? config.allowFrom ?? [];
    return allowed.includes("*") || allowed.includes(userId);
  } else {
    const policy = config.dmPolicy ?? "open";
    if (policy === "open") return true;
    if (policy === "disabled") return false;
    const allowed = config.allowFrom ?? [];
    return allowed.includes("*") || allowed.includes(userId);
  }
}

// ============================================================================
// Message sending
// ============================================================================

export async function sendReply(text: string, replyToken: string | undefined, userId: string): Promise<void> {
  if (!lineClient) {
    throw new Error("LINE client not initialized");
  }

  const maxLength = 5000;
  const maxMessages = 5;

  const chunks: string[] = [];
  if (text.length <= maxLength) {
    chunks.push(text);
  } else {
    let current = "";
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      if (current.length + sentence.length + 1 <= maxLength) {
        current += (current ? " " : "") + sentence;
      } else {
        if (current) chunks.push(current);
        current = sentence;
      }
    }
    if (current) chunks.push(current);
  }

  const messages: messagingApi.TextMessage[] = chunks.slice(0, maxMessages).map((chunk) => ({
    type: "text",
    text: chunk,
  }));

  try {
    if (replyToken) {
      try {
        await lineClient.replyMessage({ replyToken, messages });
        return;
      } catch (err) {
        // Reply token expired — fall through to pushMessage
        if (err instanceof HTTPFetchError && err.status === 400) {
          ctx?.log.warn("Reply token expired, falling back to pushMessage");
        } else {
          throw err;
        }
      }
    }
    await lineClient.pushMessage({ to: userId, messages });
  } catch (err) {
    if (err instanceof HTTPFetchError) {
      ctx?.log.error(`LINE API error: ${err.status} ${err.body}`);
    } else {
      ctx?.log.error("Failed to send LINE message", err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

// ============================================================================
// Event handling
// ============================================================================

export async function handleEvent(event: webhook.Event): Promise<void> {
  if (event.type !== "message") {
    ctx?.log.info(`Ignoring LINE event type: ${event.type}`);
    return;
  }

  const messageEvent = event as webhook.MessageEvent;
  const source = messageEvent.source;
  if (!source) return;

  const userId =
    source.type === "user"
      ? (source as webhook.UserSource).userId
      : source.type === "group"
        ? (source as webhook.GroupSource).userId
        : source.type === "room"
          ? (source as webhook.RoomSource).userId
          : undefined;

  if (!userId) {
    ctx?.log.info("No userId in LINE event source, skipping");
    return;
  }

  const isGroup = source.type === "group" || source.type === "room";

  if (!isAllowed(userId, isGroup)) {
    ctx?.log.info(`LINE message from ${userId} blocked by policy`);
    return;
  }

  const message = messageEvent.message;
  let text = "";

  switch (message.type) {
    case "text":
      text = (message as webhook.TextMessageContent).text;
      break;
    case "image":
      text = "[image]";
      break;
    case "video":
      text = "[video]";
      break;
    case "audio":
      text = "[audio]";
      break;
    case "location": {
      const loc = message as webhook.LocationMessageContent;
      text = `[location: ${loc.title ?? ""} ${loc.address ?? ""} (${loc.latitude}, ${loc.longitude})]`;
      break;
    }
    case "sticker": {
      const sticker = message as webhook.StickerMessageContent;
      text = `[sticker: ${sticker.packageId}/${sticker.stickerId}]`;
      break;
    }
    case "file": {
      const file = message as webhook.FileMessageContent;
      text = `[file: ${file.fileName}]`;
      break;
    }
    default:
      text = `[${(message as webhook.MessageContentBase).type}]`;
      break;
  }

  if (!text) return;

  const groupId =
    source.type === "group"
      ? (source as webhook.GroupSource).groupId
      : source.type === "room"
        ? (source as webhook.RoomSource).roomId
        : undefined;

  const channelId = isGroup ? `group:${groupId}` : `dm:${userId}`;
  const sessionKey = `line-${isGroup ? groupId : userId}`;
  const channelRef = { type: "line", id: channelId, name: isGroup ? `LINE ${source.type}` : "LINE DM" };

  if (ctx) {
    ctx.logMessage(sessionKey, text, { from: userId, channel: channelRef });

    const response = await ctx.inject(sessionKey, `[${userId}]: ${text}`, {
      from: userId,
      channel: channelRef,
    });

    await sendReply(response, messageEvent.replyToken, userId);
  }
}

// ============================================================================
// Channel Provider
// ============================================================================

import type { ChannelCommand, ChannelMessageParser } from "./types.js";

const registeredCommands: Map<string, ChannelCommand> = new Map();
const registeredParsers: Map<string, ChannelMessageParser> = new Map();

const lineChannelProvider: ChannelProvider = {
  id: "line",

  registerCommand(cmd: ChannelCommand): void {
    registeredCommands.set(cmd.name, cmd);
  },

  unregisterCommand(name: string): void {
    registeredCommands.delete(name);
  },

  getCommands(): ChannelCommand[] {
    return Array.from(registeredCommands.values());
  },

  addMessageParser(parser: ChannelMessageParser): void {
    registeredParsers.set(parser.id, parser);
  },

  removeMessageParser(id: string): void {
    registeredParsers.delete(id);
  },

  getMessageParsers(): ChannelMessageParser[] {
    return Array.from(registeredParsers.values());
  },

  getBotUsername(): string {
    return "line-bot";
  },

  async send(channelId: string, content: string): Promise<void> {
    if (!lineClient) throw new Error("LINE client not initialized");

    // channelId format: "dm:Uxxxxx" or "group:Cxxxxx"
    const colonIdx = channelId.indexOf(":");
    const targetId = colonIdx >= 0 ? channelId.slice(colonIdx + 1) : channelId;

    const maxLength = 5000;
    const maxMessages = 5;
    const chunks: string[] = [];

    if (content.length <= maxLength) {
      chunks.push(content);
    } else {
      let current = "";
      const sentences = content.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        if (current.length + sentence.length + 1 <= maxLength) {
          current += (current ? " " : "") + sentence;
        } else {
          if (current) chunks.push(current);
          current = sentence;
        }
      }
      if (current) chunks.push(current);
    }

    const messages: messagingApi.TextMessage[] = chunks.slice(0, maxMessages).map((chunk) => ({
      type: "text",
      text: chunk,
    }));

    await lineClient.pushMessage({ to: targetId, messages });
    ctx?.log.info(`LINE channel provider sent to ${channelId}`);
  },
};

// ============================================================================
// Webhook server
// ============================================================================

async function startWebhookServer(): Promise<void> {
  const { channelAccessToken, channelSecret } = resolveCredentials();

  lineClient = new messagingApi.MessagingApiClient({ channelAccessToken });

  const app = express();
  const webhookPath = config.webhookPath ?? "/webhook";

  // IMPORTANT: Do NOT add global body parsers before LINE middleware —
  // it needs the raw body to validate the webhook signature.
  app.post(webhookPath, middleware({ channelSecret }), (req: express.Request, res: express.Response) => {
    res.status(200).json({ status: "ok" });
    const events: webhook.Event[] = (req.body as { events: webhook.Event[] }).events ?? [];
    for (const event of events) {
      handleEvent(event).catch((err) => {
        ctx?.log.error("Error handling LINE event", err instanceof Error ? err.message : String(err));
      });
    }
  });

  // Error handler for signature validation failures
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (err instanceof SignatureValidationFailed) {
        ctx?.log.warn("LINE signature validation failed");
        res.status(401).send("Invalid signature");
        return;
      }
      if (err instanceof JSONParseError) {
        ctx?.log.warn("LINE JSON parse error");
        res.status(400).send("Invalid JSON");
        return;
      }
      next(err);
    },
  );

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", plugin: "@wopr-network/wopr-plugin-line" });
  });

  const port = config.webhookPort ?? 3000;
  server = app.listen(port, () => {
    ctx?.log.info(`LINE webhook server listening on port ${port} at ${webhookPath}`);
  });
}

// ============================================================================
// Plugin definition
// ============================================================================

const plugin: WOPRPlugin = {
  name: "wopr-plugin-line",
  version: "1.0.0",
  description: "LINE Bot integration using LINE Bot SDK",

  manifest: {
    name: "@wopr-network/wopr-plugin-line",
    version: "1.0.0",
    description: "LINE Bot integration using LINE Bot SDK",
    capabilities: ["channel"],
    requires: {
      env: ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"],
      network: {
        outbound: true,
        inbound: true,
        hosts: ["api.line.me"],
      },
    },
    provides: {
      capabilities: [
        {
          type: "channel",
          id: "line",
          displayName: "LINE",
          tier: "byok",
        },
      ],
    },
    icon: "💬",
    category: "communication",
    tags: ["line", "messaging", "channel", "japan"],
    lifecycle: {
      shutdownBehavior: "drain",
      shutdownTimeoutMs: 30_000,
    },
  },

  async init(context: WOPRPluginContext) {
    ctx = context;
    config = (context.getConfig<LINEConfig>()) ?? {};

    ctx.registerConfigSchema("wopr-plugin-line", configSchema);

    // Register channel provider (always, even without credentials)
    if (ctx.registerChannelProvider) {
      ctx.registerChannelProvider(lineChannelProvider);
      ctx.log.info("Registered LINE channel provider");
    }

    // Check credentials
    try {
      resolveCredentials();
    } catch (_err) {
      ctx.log.warn("No LINE credentials configured. Run 'wopr configure --plugin line' to set up.");
      return;
    }

    // Start webhook server
    try {
      await startWebhookServer();
    } catch (err) {
      ctx.log.error("Failed to start LINE webhook server", err instanceof Error ? err.message : String(err));
    }
  },

  async shutdown() {
    if (ctx?.unregisterChannelProvider) {
      ctx.unregisterChannelProvider("line");
    }

    if (server) {
      ctx?.log.info("Stopping LINE webhook server...");
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      server = null;
    }

    lineClient = null;
    ctx = null;
  },
};

export default plugin;
