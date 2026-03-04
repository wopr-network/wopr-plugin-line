/**
 * WOPR LINE Plugin
 *
 * LINE Messaging API integration via @line/bot-sdk.
 * Webhook-only (LINE does not support long-polling).
 * Registers a ChannelProvider so other WOPR systems can send LINE messages.
 */

import type http from "node:http";
import {
  HTTPFetchError,
  JSONParseError,
  messagingApi,
  middleware,
  SignatureValidationFailed,
  type webhook,
} from "@line/bot-sdk";
import express from "express";
import type {
  ChannelNotificationCallbacks,
  ChannelNotificationPayload,
  ChannelProvider,
  ConfigSchema,
  WOPRPlugin,
  WOPRPluginContext,
} from "./types.js";

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
let isShuttingDown = false;
const cleanups: Array<() => void> = [];
interface PendingNotificationEntry {
  callbacks: ChannelNotificationCallbacks;
  createdAt: number;
  expectedUserId: string;
}
const pendingNotifications: Map<string, PendingNotificationEntry> = new Map();
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

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
      secret: true,
      setupFlow: "paste",
    },
    {
      name: "channelSecret",
      type: "password",
      label: "Channel Secret",
      placeholder: "Channel secret for signature validation",
      required: true,
      description: "Get from LINE Developers Console > Basic settings",
      secret: true,
      setupFlow: "paste",
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
    throw new Error("LINE channel secret required. Set channels.line.channelSecret or LINE_CHANNEL_SECRET env var.");
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
// Message chunking
// ============================================================================

export function chunkMessage(text: string): string[] {
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

  return chunks.slice(0, maxMessages);
}

// ============================================================================
// Notification helpers
// ============================================================================

export function getPendingNotification(notifId: string): ChannelNotificationCallbacks | undefined {
  return pendingNotifications.get(notifId)?.callbacks;
}

export function clearPendingNotifications(): void {
  pendingNotifications.clear();
}

export function buildFriendRequestFlexMessage(fromName: string, notifId: string): messagingApi.FlexMessage {
  const displayName = fromName || "Someone";
  return {
    type: "flex",
    altText: `Friend Request from ${displayName}`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "Friend Request", weight: "bold", size: "lg" },
          { type: "text", text: `${displayName} sent you a friend request.`, wrap: true, margin: "md" },
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "md",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#1DB446",
            action: {
              type: "postback",
              label: "Accept",
              data: `notif_accept:${notifId}`,
              displayText: "Accept",
            },
          },
          {
            type: "button",
            style: "secondary",
            action: {
              type: "postback",
              label: "Deny",
              data: `notif_deny:${notifId}`,
              displayText: "Deny",
            },
          },
        ],
      },
    } as messagingApi.FlexBubble,
  };
}

// ============================================================================
// Message sending
// ============================================================================

export async function sendReply(text: string, replyToken: string | undefined, userId: string): Promise<void> {
  if (!lineClient) {
    throw new Error("LINE client not initialized");
  }

  const messages: messagingApi.TextMessage[] = chunkMessage(text).map((chunk) => ({
    type: "text",
    text: chunk,
  }));

  try {
    if (replyToken) {
      try {
        await lineClient.replyMessage({ replyToken, messages });
        return;
      } catch (err: unknown) {
        // Reply token expired — fall through to pushMessage
        if (err instanceof HTTPFetchError && err.status === 400) {
          ctx?.log.warn("Reply token expired, falling back to pushMessage");
        } else {
          throw err;
        }
      }
    }
    await lineClient.pushMessage({ to: userId, messages });
  } catch (err: unknown) {
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

async function handlePostbackEvent(event: webhook.PostbackEvent): Promise<void> {
  if (isShuttingDown) return;

  const data = event.postback.data;
  const isAccept = data.startsWith("notif_accept:");
  const isDeny = data.startsWith("notif_deny:");

  if (!isAccept && !isDeny) return;

  const notifId = isAccept ? data.slice("notif_accept:".length) : data.slice("notif_deny:".length);

  const entry = pendingNotifications.get(notifId);
  pendingNotifications.delete(notifId);

  const source = event.source;
  const userId = source?.type === "user" ? (source as webhook.UserSource).userId : undefined; // Group/room sources don't reliably carry userId for reply context
  const isGroup = source?.type === "group" || source?.type === "room";

  if (userId && !isAllowed(userId, isGroup)) {
    ctx?.log.info(`Postback from ${userId} blocked by policy`);
    return;
  }

  if (!entry) {
    ctx?.log.warn(`Notification ${notifId} not found (expired or already handled)`);
    if (event.replyToken && userId) {
      await sendReply("This notification has expired.", event.replyToken, userId);
    }
    return;
  }

  // Recipient validation: only the intended user may accept/deny
  if (entry.expectedUserId && userId && userId !== entry.expectedUserId) {
    ctx?.log.warn(`Notification ${notifId} postback from unexpected user ${userId} (expected ${entry.expectedUserId})`);
    return;
  }

  const { callbacks } = entry;

  if (isAccept) {
    ctx?.log.info(`Notification ${notifId} accepted`);
    if (callbacks.onAccept) {
      try {
        await callbacks.onAccept();
        if (event.replyToken && userId) {
          await sendReply("Friend request accepted.", event.replyToken, userId);
        }
      } catch (err: unknown) {
        ctx?.log.error("onAccept callback failed", err instanceof Error ? err.message : String(err));
        if (event.replyToken && userId) {
          await sendReply("An error occurred processing your response.", event.replyToken, userId);
        }
      }
    } else if (event.replyToken && userId) {
      await sendReply("Friend request accepted.", event.replyToken, userId);
    }
  } else {
    ctx?.log.info(`Notification ${notifId} denied`);
    if (callbacks.onDeny) {
      try {
        await callbacks.onDeny();
        if (event.replyToken && userId) {
          await sendReply("Friend request denied.", event.replyToken, userId);
        }
      } catch (err: unknown) {
        ctx?.log.error("onDeny callback failed", err instanceof Error ? err.message : String(err));
        if (event.replyToken && userId) {
          await sendReply("An error occurred processing your response.", event.replyToken, userId);
        }
      }
    } else if (event.replyToken && userId) {
      await sendReply("Friend request denied.", event.replyToken, userId);
    }
  }
}

export async function handleEvent(event: webhook.Event): Promise<void> {
  if (isShuttingDown) return;

  if (event.type === "postback") {
    await handlePostbackEvent(event as webhook.PostbackEvent);
    return;
  }

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

    const messages: messagingApi.TextMessage[] = chunkMessage(content).map((chunk) => ({
      type: "text",
      text: chunk,
    }));

    await lineClient.pushMessage({ to: targetId, messages });
    ctx?.log.info(`LINE channel provider sent to ${channelId}`);
  },

  async sendNotification(
    channelId: string,
    payload: ChannelNotificationPayload,
    callbacks: ChannelNotificationCallbacks,
  ): Promise<void> {
    if (payload.type !== "friend-request") {
      ctx?.log.warn(`Unsupported notification type: ${payload.type}`);
      return;
    }

    if (!lineClient) throw new Error("LINE client not initialized");

    const colonIdx = channelId.indexOf(":");
    const targetId = colonIdx >= 0 ? channelId.slice(colonIdx + 1) : channelId;

    const notifId = `notif_${crypto.randomUUID().slice(0, 8)}`;

    const flexMessage = buildFriendRequestFlexMessage(payload.from ?? "", notifId);

    await lineClient.pushMessage({ to: targetId, messages: [flexMessage] });

    pendingNotifications.set(notifId, { callbacks, createdAt: Date.now(), expectedUserId: targetId });
    ctx?.log.info(`Notification sent for friend request from ${payload.from ?? "unknown"} (notifId=${notifId})`);
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
      handleEvent(event).catch((err: unknown) => {
        ctx?.log.error("Error handling LINE event", err instanceof Error ? err.message : String(err));
      });
    }
  });

  // Error handler for signature validation failures
  app.use((err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
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
  });

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
    configSchema,
  },

  async init(context: WOPRPluginContext) {
    isShuttingDown = false;
    ctx = context;
    config = context.getConfig<LINEConfig>() ?? {};

    ctx.registerConfigSchema("wopr-plugin-line", configSchema);

    // Start TTL cleanup for pending notifications (5-minute expiry)
    cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of pendingNotifications) {
        if (now - entry.createdAt > 5 * 60 * 1000) pendingNotifications.delete(id);
      }
    }, 60_000);

    // Register channel provider (always, even without credentials)
    if (ctx.registerChannelProvider) {
      ctx.registerChannelProvider(lineChannelProvider);
      ctx.log.info("Registered LINE channel provider");
    }

    // Check credentials
    try {
      resolveCredentials();
    } catch (_err: unknown) {
      ctx.log.warn("No LINE credentials configured. Run 'wopr configure --plugin line' to set up.");
      return;
    }

    // Start webhook server
    try {
      await startWebhookServer();
    } catch (err: unknown) {
      ctx.log.error("Failed to start LINE webhook server", err instanceof Error ? err.message : String(err));
    }
  },

  async shutdown() {
    isShuttingDown = true;

    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }

    if (ctx?.unregisterConfigSchema) {
      ctx.unregisterConfigSchema("wopr-plugin-line");
    }

    if (ctx?.unregisterChannelProvider) {
      ctx.unregisterChannelProvider("line");
    }

    for (const cleanup of cleanups) {
      cleanup();
    }
    cleanups.length = 0;

    registeredCommands.clear();
    registeredParsers.clear();
    pendingNotifications.clear();

    if (server) {
      ctx?.log.info("Stopping LINE webhook server...");
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      server = null;
    }

    lineClient = null;
    config = {};
    ctx = null;
  },
};

export default plugin;
