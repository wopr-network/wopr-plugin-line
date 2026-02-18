/**
 * WOPR LINE Plugin - LINE Bot SDK-based LINE Messaging API integration
 */

import http from "node:http";
import path from "node:path";
import express from "express";
import winston from "winston";
import {
  middleware,
  messagingApi,
  webhook,
  HTTPFetchError,
  SignatureValidationFailed,
  JSONParseError,
} from "@line/bot-sdk";
import type {
  WOPRPlugin,
  WOPRPluginContext,
  ConfigSchema,
  AgentIdentity,
  ChannelInfo,
  LogMessageOptions,
} from "./types.js";

// LINE config interface
interface LINEConfig {
  channelAccessToken?: string;
  channelSecret?: string;
  webhookPort?: number;
  webhookPath?: string;
  dmPolicy?: "allowlist" | "open" | "disabled";
  allowFrom?: string[];
  groupPolicy?: "allowlist" | "open" | "disabled";
  groupAllowFrom?: string[];
  timeoutSeconds?: number;
}

// Module-level state
let ctx: WOPRPluginContext | null = null;
let config: LINEConfig = {};
let agentIdentity: AgentIdentity = { name: "WOPR", emoji: "🤖" };
let lineClient: messagingApi.MessagingApiClient | null = null;
let server: http.Server | null = null;
let isShuttingDown = false;
let logger: winston.Logger;

// Initialize winston logger
function initLogger(): winston.Logger {
  const WOPR_HOME = process.env.WOPR_HOME || path.join(process.env.HOME || "~", ".wopr");
  return winston.createLogger({
    level: "debug",
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    defaultMeta: { service: "wopr-plugin-line" },
    transports: [
      new winston.transports.File({
        filename: path.join(WOPR_HOME, "logs", "line-plugin-error.log"),
        level: "error",
      }),
      new winston.transports.File({
        filename: path.join(WOPR_HOME, "logs", "line-plugin.log"),
        level: "debug",
      }),
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        ),
        level: "warn",
      }),
    ],
  });
}

// Config schema
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
    {
      name: "timeoutSeconds",
      type: "number",
      label: "API Timeout (seconds)",
      placeholder: "30",
      default: 30,
      description: "Timeout for LINE API calls",
    },
  ],
};

// Refresh identity
async function refreshIdentity(): Promise<void> {
  if (!ctx) return;
  try {
    const identity = await ctx.getAgentIdentity();
    if (identity) {
      agentIdentity = { ...agentIdentity, ...identity };
      logger.info("Identity refreshed:", agentIdentity.name);
    }
  } catch (e) {
    logger.warn("Failed to refresh identity:", String(e));
  }
}

// Resolve credentials
function resolveCredentials(): { channelAccessToken: string; channelSecret: string } {
  const channelAccessToken =
    config.channelAccessToken || process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const channelSecret =
    config.channelSecret || process.env.LINE_CHANNEL_SECRET;

  if (!channelAccessToken) {
    throw new Error(
      "LINE channel access token required. Set channels.line.channelAccessToken or LINE_CHANNEL_ACCESS_TOKEN env var."
    );
  }
  if (!channelSecret) {
    throw new Error(
      "LINE channel secret required. Set channels.line.channelSecret or LINE_CHANNEL_SECRET env var."
    );
  }

  return { channelAccessToken, channelSecret };
}

// Check if sender is allowed
function isAllowed(userId: string, isGroup: boolean): boolean {
  if (isGroup) {
    const policy = config.groupPolicy || "open";
    if (policy === "open") return true;
    if (policy === "disabled") return false;
    const allowed = config.groupAllowFrom || config.allowFrom || [];
    return allowed.includes("*") || allowed.includes(userId);
  } else {
    const policy = config.dmPolicy || "open";
    if (policy === "open") return true;
    if (policy === "disabled") return false;
    const allowed = config.allowFrom || [];
    return allowed.includes("*") || allowed.includes(userId);
  }
}

// Handle a LINE webhook event
async function handleEvent(event: webhook.Event): Promise<void> {
  // Only handle message events
  if (event.type !== "message") {
    logger.debug(`Ignoring event type: ${event.type}`);
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
    logger.debug("No userId in event source, skipping");
    return;
  }

  const isGroup = source.type === "group" || source.type === "room";

  // Check permissions
  if (!isAllowed(userId, isGroup)) {
    logger.info(`Message from ${userId} blocked by policy`);
    return;
  }

  // Extract text content based on message type
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
      text = `[location: ${loc.title || ""} ${loc.address || ""} (${loc.latitude}, ${loc.longitude})]`;
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

  // Build channel info
  const channelId = isGroup
    ? `group:${
        source.type === "group"
          ? (source as webhook.GroupSource).groupId
          : (source as webhook.RoomSource).roomId
      }`
    : `dm:${userId}`;

  const channelInfo: ChannelInfo = {
    type: "line",
    id: channelId,
    name: isGroup ? `LINE ${source.type}` : "LINE DM",
  };

  const sessionKey = `line-${
    isGroup
      ? source.type === "group"
        ? (source as webhook.GroupSource).groupId
        : (source as webhook.RoomSource).roomId
      : userId
  }`;

  // Log incoming message
  if (ctx) {
    const logOptions: LogMessageOptions = {
      from: userId,
      channel: channelInfo,
    };
    ctx.logMessage(sessionKey, text, logOptions);
  }

  // Inject to WOPR and reply
  await injectAndReply(text, userId, sessionKey, channelInfo, messageEvent.replyToken);
}

// Inject message to WOPR and send reply
async function injectAndReply(
  text: string,
  userId: string,
  sessionKey: string,
  channelInfo: ChannelInfo,
  replyToken?: string
): Promise<void> {
  if (!ctx || !lineClient) return;

  const prefix = `[${userId}]: `;
  const messageWithPrefix = prefix + text;

  const response = await ctx.inject(sessionKey, messageWithPrefix, {
    from: userId,
    channel: channelInfo,
  });

  // Send response back via LINE
  await sendReply(response, replyToken, userId);
}

// Send reply via LINE API
async function sendReply(
  text: string,
  replyToken: string | undefined,
  userId: string
): Promise<void> {
  if (!lineClient) {
    throw new Error("LINE client not initialized");
  }

  const maxLength = 5000; // LINE text message limit
  const maxMessages = 5; // LINE max messages per reply

  // Split long messages at sentence boundaries
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

  // Limit to max messages
  const messagesToSend = chunks.slice(0, maxMessages);

  const messages: messagingApi.TextMessage[] = messagesToSend.map((chunk) => ({
    type: "text",
    text: chunk,
  }));

  try {
    if (replyToken) {
      try {
        await lineClient.replyMessage({
          replyToken,
          messages,
        });
        return;
      } catch (err) {
        // Reply token may have expired — fall through to pushMessage
        if (err instanceof HTTPFetchError && err.status === 400) {
          logger.warn("Reply token expired, falling back to pushMessage");
        } else {
          throw err;
        }
      }
    }
    // Fallback to push message (no reply token or expired token)
    await lineClient.pushMessage({
      to: userId,
      messages,
    });
  } catch (err) {
    if (err instanceof HTTPFetchError) {
      logger.error(`LINE API error: ${err.status} ${err.body}`);
    } else {
      logger.error("Failed to send LINE message:", err);
    }
    throw err;
  }
}

// Start webhook server
async function startWebhookServer(): Promise<void> {
  const { channelAccessToken, channelSecret } = resolveCredentials();

  // Create LINE client
  lineClient = new messagingApi.MessagingApiClient({ channelAccessToken });

  // Create Express app
  const app = express();

  const webhookPath = config.webhookPath || "/webhook";

  // LINE middleware validates signature and parses body
  // IMPORTANT: Do NOT add global body parser before LINE middleware — it needs raw body
  app.post(
    webhookPath,
    middleware({ channelSecret }),
    (req: express.Request, res: express.Response) => {
      // Respond immediately to LINE platform (must respond within seconds)
      res.status(200).json({ status: "ok" });

      // Process events asynchronously
      const events: webhook.Event[] = (req.body as { events: webhook.Event[] }).events || [];
      for (const event of events) {
        handleEvent(event).catch((err) => {
          logger.error("Error handling LINE event:", err);
        });
      }
    }
  );

  // Error handling middleware for signature validation failures
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (err instanceof SignatureValidationFailed) {
        logger.warn("Signature validation failed:", (err as any).signature);
        res.status(401).send("Invalid signature");
        return;
      }
      if (err instanceof JSONParseError) {
        logger.warn("JSON parse error");
        res.status(400).send("Invalid JSON");
        return;
      }
      next(err);
    }
  );

  // Health check endpoint
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", plugin: "wopr-plugin-line" });
  });

  // Start server
  const port = config.webhookPort || 3000;
  server = app.listen(port, () => {
    logger.info(
      `LINE webhook server listening on port ${port} at path ${webhookPath}`
    );
  });
}

// Plugin definition
const plugin: WOPRPlugin = {
  name: "line",
  version: "1.0.0",
  description: "LINE Bot integration using LINE Bot SDK",

  async init(context: WOPRPluginContext): Promise<void> {
    ctx = context;
    config = (context.getConfig() || {}) as LINEConfig;

    logger = initLogger();

    ctx.registerConfigSchema("line", configSchema);

    await refreshIdentity();

    // Validate credentials
    try {
      resolveCredentials();
    } catch (err) {
      logger.warn(
        "No LINE credentials configured. Run 'wopr configure --plugin line' to set up."
      );
      return;
    }

    // Start webhook server
    try {
      await startWebhookServer();
    } catch (err) {
      logger.error("Failed to start LINE webhook server:", err);
    }
  },

  async shutdown(): Promise<void> {
    isShuttingDown = true;

    if (server) {
      logger.info("Stopping LINE webhook server...");
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

// Export for testing
export { isAllowed, handleEvent, sendReply, injectAndReply, resolveCredentials };
