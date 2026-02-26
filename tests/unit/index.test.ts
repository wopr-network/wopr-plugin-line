/**
 * Unit tests for WOPR LINE Plugin
 * Uses vitest with vi.mock() for dependency mocking.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks (must be declared before imports) ──────────────────────────────────

const mockReplyMessage = vi.fn().mockResolvedValue({});
const mockPushMessage = vi.fn().mockResolvedValue({});

vi.mock("@line/bot-sdk", () => {
  class HTTPFetchError extends Error {
    status: number;
    body: string;
    constructor(status: number, body: string) {
      super(`HTTP ${status}`);
      this.status = status;
      this.body = body;
    }
  }
  class SignatureValidationFailed extends Error {
    signature: string;
    constructor(message: string, signature: string) {
      super(message);
      this.signature = signature;
    }
  }
  class JSONParseError extends Error {
    constructor(message: string) {
      super(message);
    }
  }

  return {
    HTTPFetchError,
    SignatureValidationFailed,
    JSONParseError,
    middleware: vi.fn().mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
    messagingApi: {
      MessagingApiClient: vi.fn().mockImplementation(() => ({
        replyMessage: mockReplyMessage,
        pushMessage: mockPushMessage,
      })),
    },
    webhook: {},
  };
});

const mockAppPost = vi.fn();
const mockAppGet = vi.fn();
const mockAppUse = vi.fn();
const mockServerClose = vi.fn().mockImplementation((cb: (err?: Error) => void) => cb());
const mockListen = vi.fn().mockImplementation((_port: number, cb?: () => void) => {
  cb?.();
  return { close: mockServerClose };
});

vi.mock("express", () => {
  const factory = vi.fn().mockImplementation(() => ({
    post: mockAppPost,
    get: mockAppGet,
    use: mockAppUse,
    listen: mockListen,
  }));
  return { default: factory };
});

// ── Import plugin AFTER mocks ─────────────────────────────────────────────────

import plugin from "../../src/index.js";
import { handleEvent, isAllowed, sendReply } from "../../src/index.js";
import type { WOPRPluginContext } from "../../src/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildMockContext(cfg: Record<string, unknown> = {}): WOPRPluginContext {
  return {
    inject: vi.fn().mockResolvedValue("Hello from WOPR"),
    logMessage: vi.fn(),
    injectPeer: vi.fn().mockResolvedValue(""),
    getIdentity: vi.fn().mockReturnValue({ publicKey: "pk", shortId: "short", encryptPub: "ep" }),
    getAgentIdentity: vi.fn().mockResolvedValue({ name: "TestBot", emoji: "🤖" }),
    getUserProfile: vi.fn().mockResolvedValue({}),
    getSessions: vi.fn().mockReturnValue([]),
    getPeers: vi.fn().mockReturnValue([]),
    getConfig: vi.fn().mockReturnValue(cfg),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    getMainConfig: vi.fn().mockReturnValue({}),
    registerConfigSchema: vi.fn(),
    unregisterConfigSchema: vi.fn(),
    registerChannelProvider: vi.fn(),
    unregisterChannelProvider: vi.fn(),
    registerExtension: vi.fn(),
    getPluginDir: vi.fn().mockReturnValue("/tmp/test-plugin"),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as WOPRPluginContext;
}

function buildMessageEvent(
  messageType: string,
  messageProps: Record<string, unknown>,
  userId: string,
  sourceType: "user" | "group" | "room" = "user",
  replyToken = "reply-token-abc",
): Record<string, unknown> {
  const source: Record<string, string> = { type: sourceType, userId };
  if (sourceType === "group") source.groupId = "Cgroup123";
  if (sourceType === "room") source.roomId = "Croom123";
  return {
    type: "message",
    replyToken,
    source,
    message: { id: "msg1", type: messageType, ...messageProps },
    timestamp: Date.now(),
    mode: "active",
  };
}

beforeEach(() => {
  // Clear call history without wiping implementations
  mockReplyMessage.mockClear();
  mockPushMessage.mockClear();
  mockAppPost.mockClear();
  mockAppGet.mockClear();
  mockAppUse.mockClear();
  mockServerClose.mockClear();
  mockListen.mockClear();
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_CHANNEL_SECRET;
});

// ── §1: Plugin exports ────────────────────────────────────────────────────────

describe("Plugin exports", () => {
  it("has name 'wopr-plugin-line'", () => {
    expect(plugin.name).toBe("wopr-plugin-line");
  });

  it("has version '1.0.0'", () => {
    expect(plugin.version).toBe("1.0.0");
  });

  it("has init as function", () => {
    expect(typeof plugin.init).toBe("function");
  });

  it("has shutdown as function", () => {
    expect(typeof plugin.shutdown).toBe("function");
  });

  it("has manifest with channel capability", () => {
    expect(plugin.manifest).toBeDefined();
    expect(plugin.manifest?.capabilities).toContain("channel");
  });

  it("has configSchema in manifest", () => {
    expect(plugin.manifest?.configSchema).toBeDefined();
    expect(plugin.manifest?.configSchema?.fields.length).toBeGreaterThan(0);
  });

  it("marks credential fields as secret", () => {
    const fields = plugin.manifest?.configSchema?.fields ?? [];
    const tokenField = fields.find((f: { name: string }) => f.name === "channelAccessToken");
    const secretField = fields.find((f: { name: string }) => f.name === "channelSecret");
    expect(tokenField?.secret).toBe(true);
    expect(secretField?.secret).toBe(true);
  });

  it("sets setupFlow on credential fields", () => {
    const fields = plugin.manifest?.configSchema?.fields ?? [];
    const tokenField = fields.find((f: { name: string }) => f.name === "channelAccessToken");
    const secretField = fields.find((f: { name: string }) => f.name === "channelSecret");
    expect(tokenField?.setupFlow).toBe("paste");
    expect(secretField?.setupFlow).toBe("paste");
  });
});

// ── §2: init() ────────────────────────────────────────────────────────────────

describe("init()", () => {
  it("registers config schema", async () => {
    const ctx = buildMockContext({});
    await plugin.init!(ctx);
    expect(ctx.registerConfigSchema).toHaveBeenCalledWith("wopr-plugin-line", expect.objectContaining({ title: "LINE Integration" }));
  });

  it("registers channel provider even without credentials", async () => {
    const ctx = buildMockContext({});
    await plugin.init!(ctx);
    expect(ctx.registerChannelProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "line" }));
  });

  it("warns and returns without starting server when no credentials", async () => {
    const ctx = buildMockContext({});
    await plugin.init!(ctx);
    expect(mockListen).not.toHaveBeenCalled();
  });

  it("starts webhook server with valid credentials from config", async () => {
    const ctx = buildMockContext({ channelAccessToken: "test-token", channelSecret: "test-secret" });
    await plugin.init!(ctx);
    expect(mockListen).toHaveBeenCalled();
  });

  it("resolves credentials from environment variables", async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "env-token";
    process.env.LINE_CHANNEL_SECRET = "env-secret";
    const ctx = buildMockContext({});
    await plugin.init!(ctx);
    expect(mockListen).toHaveBeenCalled();
  });
});

// ── §3: shutdown() ────────────────────────────────────────────────────────────

describe("shutdown()", () => {
  it("calls unregisterChannelProvider", async () => {
    const ctx = buildMockContext({ channelAccessToken: "token", channelSecret: "secret" });
    await plugin.init!(ctx);
    await plugin.shutdown!();
    expect(ctx.unregisterChannelProvider).toHaveBeenCalledWith("line");
  });

  it("closes the webhook server", async () => {
    const ctx = buildMockContext({ channelAccessToken: "token", channelSecret: "secret" });
    await plugin.init!(ctx);
    await plugin.shutdown!();
    expect(mockServerClose).toHaveBeenCalled();
  });

  it("does not throw when called without prior init", async () => {
    await plugin.shutdown!();
  });

  it("unregisters config schema", async () => {
    const ctx = buildMockContext({ channelAccessToken: "token", channelSecret: "secret" });
    await plugin.init!(ctx);
    await plugin.shutdown!();
    expect((ctx as unknown as { unregisterConfigSchema: ReturnType<typeof vi.fn> }).unregisterConfigSchema).toHaveBeenCalledWith("wopr-plugin-line");
  });

  it("is idempotent — second shutdown does not throw", async () => {
    const ctx = buildMockContext({ channelAccessToken: "token", channelSecret: "secret" });
    await plugin.init!(ctx);
    await plugin.shutdown!();
    await plugin.shutdown!();
  });
});

// ── §4-6: isAllowed() — DM policies ──────────────────────────────────────────

describe("isAllowed() — DM policies", () => {
  it("open: returns true for any user", async () => {
    const ctx = buildMockContext({ channelAccessToken: "t", channelSecret: "s", dmPolicy: "open" });
    await plugin.init!(ctx);
    expect(isAllowed("Uanyone", false)).toBe(true);
  });

  it("disabled: returns false for all", async () => {
    const ctx = buildMockContext({ channelAccessToken: "t", channelSecret: "s", dmPolicy: "disabled" });
    await plugin.init!(ctx);
    expect(isAllowed("Uanyone", false)).toBe(false);
  });

  it("allowlist: returns true only for listed IDs", async () => {
    const ctx = buildMockContext({
      channelAccessToken: "t",
      channelSecret: "s",
      dmPolicy: "allowlist",
      allowFrom: ["Uallowed"],
    });
    await plugin.init!(ctx);
    expect(isAllowed("Uallowed", false)).toBe(true);
    expect(isAllowed("Uother", false)).toBe(false);
  });
});

// ── §7-9: isAllowed() — group policies ───────────────────────────────────────

describe("isAllowed() — group policies", () => {
  it("open: returns true for any user in group", async () => {
    const ctx = buildMockContext({ channelAccessToken: "t", channelSecret: "s", groupPolicy: "open" });
    await plugin.init!(ctx);
    expect(isAllowed("Uanyone", true)).toBe(true);
  });

  it("disabled: returns false for all in group", async () => {
    const ctx = buildMockContext({ channelAccessToken: "t", channelSecret: "s", groupPolicy: "disabled" });
    await plugin.init!(ctx);
    expect(isAllowed("Uanyone", true)).toBe(false);
  });

  it("allowlist: returns true only for listed IDs in group", async () => {
    const ctx = buildMockContext({
      channelAccessToken: "t",
      channelSecret: "s",
      groupPolicy: "allowlist",
      groupAllowFrom: ["Ugroupuser"],
    });
    await plugin.init!(ctx);
    expect(isAllowed("Ugroupuser", true)).toBe(true);
    expect(isAllowed("Uother", true)).toBe(false);
  });
});

// ── §10-15: handleEvent() ─────────────────────────────────────────────────────

describe("handleEvent()", () => {
  let mockCtx: WOPRPluginContext;

  beforeEach(async () => {
    mockReplyMessage.mockClear();
    mockPushMessage.mockClear();
    mockAppPost.mockClear();
    mockAppGet.mockClear();
    mockAppUse.mockClear();
    mockServerClose.mockClear();
    mockListen.mockClear();
    mockCtx = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
      dmPolicy: "open",
      groupPolicy: "open",
    });
    await plugin.init!(mockCtx);
  });

  it("text message: injects with session key and calls replyMessage", async () => {
    const event = buildMessageEvent("text", { text: "Hello bot" }, "Uuser123");
    await handleEvent(event as never);
    expect(mockCtx.inject).toHaveBeenCalledWith("line-Uuser123", "[Uuser123]: Hello bot", expect.any(Object));
    expect(mockReplyMessage).toHaveBeenCalled();
  });

  it("sticker message: injects [sticker: packageId/stickerId]", async () => {
    const event = buildMessageEvent("sticker", { packageId: "789", stickerId: "456" }, "Uuser123");
    await handleEvent(event as never);
    expect(mockCtx.inject).toHaveBeenCalledWith(expect.any(String), "[Uuser123]: [sticker: 789/456]", expect.any(Object));
  });

  it("image message: injects [image]", async () => {
    const event = buildMessageEvent("image", {}, "Uuser123");
    await handleEvent(event as never);
    expect(mockCtx.inject).toHaveBeenCalledWith(expect.any(String), "[Uuser123]: [image]", expect.any(Object));
  });

  it("location message: injects formatted coordinates", async () => {
    const event = buildMessageEvent(
      "location",
      { title: "Tokyo Tower", address: "4 Chome-2-8", latitude: 35.6586, longitude: 139.7454 },
      "Uuser123",
    );
    await handleEvent(event as never);
    const call = (mockCtx.inject as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toContain("[location:");
    expect(call[1]).toContain("35.6586");
    expect(call[1]).toContain("139.7454");
  });

  it("non-message event (follow): is ignored", async () => {
    const followEvent = { type: "follow", source: { type: "user", userId: "Uuser123" }, timestamp: Date.now(), mode: "active" };
    await handleEvent(followEvent as never);
    expect(mockCtx.inject).not.toHaveBeenCalled();
  });

  it("blocked user: does not inject or reply", async () => {
    const blockedCtx = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
      dmPolicy: "allowlist",
      allowFrom: ["Uallowed"],
    });
    await plugin.init!(blockedCtx);
    const event = buildMessageEvent("text", { text: "Hello" }, "Ublocked");
    await handleEvent(event as never);
    expect(blockedCtx.inject).not.toHaveBeenCalled();
  });
});

// ── §16-18: sendReply() ───────────────────────────────────────────────────────

describe("sendReply()", () => {
  beforeEach(async () => {
    mockReplyMessage.mockClear();
    mockPushMessage.mockClear();
    mockAppPost.mockClear();
    mockAppGet.mockClear();
    mockAppUse.mockClear();
    mockServerClose.mockClear();
    mockListen.mockClear();
    const ctx = buildMockContext({ channelAccessToken: "token", channelSecret: "secret" });
    await plugin.init!(ctx);
  });

  it("short message with reply token: calls replyMessage", async () => {
    await sendReply("Hello!", "reply-token-xyz", "Uuser123");
    expect(mockReplyMessage).toHaveBeenCalledWith({ replyToken: "reply-token-xyz", messages: [{ type: "text", text: "Hello!" }] });
    expect(mockPushMessage).not.toHaveBeenCalled();
  });

  it("long message: splits into chunks ≤ 5000 chars, max 5 messages", async () => {
    const longText = "This is a sentence. ".repeat(600);
    await sendReply(longText, "reply-token-xyz", "Uuser123");
    const callArg = mockReplyMessage.mock.calls[0][0] as { messages: Array<{ text: string }> };
    expect(callArg.messages.length).toBeLessThanOrEqual(5);
    for (const msg of callArg.messages) {
      expect(msg.text.length).toBeLessThanOrEqual(5000);
    }
  });

  it("no reply token: falls back to pushMessage", async () => {
    await sendReply("Hello!", undefined, "Uuser123");
    expect(mockPushMessage).toHaveBeenCalledWith({ to: "Uuser123", messages: [{ type: "text", text: "Hello!" }] });
    expect(mockReplyMessage).not.toHaveBeenCalled();
  });

  it("HTTPFetchError(400) on replyMessage: falls back to pushMessage", async () => {
    const { HTTPFetchError } = await import("@line/bot-sdk");
    mockReplyMessage.mockRejectedValueOnce(new HTTPFetchError(400, "Reply token expired"));
    await sendReply("Hello!", "expired-reply-token", "Uuser123");
    expect(mockReplyMessage).toHaveBeenCalledWith({ replyToken: "expired-reply-token", messages: [{ type: "text", text: "Hello!" }] });
    expect(mockPushMessage).toHaveBeenCalledWith({ to: "Uuser123", messages: [{ type: "text", text: "Hello!" }] });
  });
});

// ── §19: Signature validation error handler ───────────────────────────────────

describe("Signature validation error handler", () => {
  it("returns 401 for invalid signature", async () => {
    const ctx = buildMockContext({ channelAccessToken: "token", channelSecret: "secret" });
    await plugin.init!(ctx);

    // Find the 4-arg error handler registered via app.use()
    const useCall = mockAppUse.mock.calls.find((call: unknown[]) => typeof call[0] === "function" && (call[0] as (...args: unknown[]) => void).length === 4);
    expect(useCall).toBeDefined();
    const errorHandler = useCall![0] as (err: Error, req: unknown, res: { status: (n: number) => { send: (s: string) => void } }, next: () => void) => void;

    const { SignatureValidationFailed } = await import("@line/bot-sdk");
    const sigError = new SignatureValidationFailed("Invalid", "badsig");
    const mockRes = { status: vi.fn().mockReturnThis(), send: vi.fn() };
    const mockNext = vi.fn();

    errorHandler(sigError, {}, mockRes as never, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.send).toHaveBeenCalledWith("Invalid signature");
  });
});

// ── §20: Health endpoint ──────────────────────────────────────────────────────

describe("Health endpoint", () => {
  it("GET /health returns correct response", async () => {
    const ctx = buildMockContext({ channelAccessToken: "token", channelSecret: "secret" });
    await plugin.init!(ctx);

    const healthCall = mockAppGet.mock.calls.find((call: unknown[]) => call[0] === "/health");
    expect(healthCall).toBeDefined();
    const healthHandler = healthCall![1] as (_req: unknown, res: { json: (v: unknown) => void }) => void;

    const mockRes = { json: vi.fn() };
    healthHandler({}, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith({ status: "ok", plugin: "@wopr-network/wopr-plugin-line" });
  });
});
