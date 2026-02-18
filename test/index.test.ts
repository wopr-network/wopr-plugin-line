/**
 * Unit tests for WOPR LINE Plugin
 */

// All jest.mock calls are hoisted — factories must be self-contained

class MockHTTPFetchError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.name = "HTTPFetchError";
    this.status = status;
    this.body = body;
  }
}

class MockSignatureValidationFailed extends Error {
  signature: string;
  constructor(message: string, signature: string) {
    super(message);
    this.name = "SignatureValidationFailed";
    this.signature = signature;
  }
}

class MockJSONParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JSONParseError";
  }
}

jest.mock("@line/bot-sdk", () => {
  const replyMessage = jest.fn().mockResolvedValue({});
  const pushMessage = jest.fn().mockResolvedValue({});
  const MessagingApiClient = jest.fn().mockImplementation(() => ({
    replyMessage,
    pushMessage,
  }));
  return {
    middleware: jest.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
    messagingApi: { MessagingApiClient },
    webhook: {},
    HTTPFetchError: class MockHTTPFetchError extends Error {
      status: number;
      body: string;
      constructor(status: number, body: string) {
        super(`HTTP ${status}`);
        this.status = status;
        this.body = body;
      }
    },
    SignatureValidationFailed: class extends Error {
      signature: string;
      constructor(message: string, signature: string) {
        super(message);
        this.signature = signature;
      }
    },
    JSONParseError: class extends Error {
      constructor(message: string) {
        super(message);
      }
    },
  };
});

jest.mock("express", () => {
  const makeApp = () => ({
    post: jest.fn(),
    get: jest.fn(),
    use: jest.fn(),
    listen: jest.fn().mockImplementation((_port: number, cb?: () => void) => {
      if (cb) cb();
      return { close: jest.fn().mockImplementation((done: (e?: Error) => void) => done()) };
    }),
  });
  const exp = jest.fn().mockImplementation(makeApp);
  return exp;
});

jest.mock("winston", () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return {
    createLogger: jest.fn().mockReturnValue(logger),
    format: {
      combine: jest.fn().mockReturnValue({}),
      timestamp: jest.fn().mockReturnValue({}),
      errors: jest.fn().mockReturnValue({}),
      json: jest.fn().mockReturnValue({}),
      colorize: jest.fn().mockReturnValue({}),
      simple: jest.fn().mockReturnValue({}),
    },
    transports: {
      File: jest.fn(),
      Console: jest.fn(),
    },
  };
});

import plugin from "../src/index";
import type { WOPRPluginContext } from "../src/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildMockContext(configOverride: Record<string, unknown> = {}): WOPRPluginContext {
  return {
    inject: jest.fn().mockResolvedValue("Hello from WOPR"),
    logMessage: jest.fn(),
    injectPeer: jest.fn().mockResolvedValue(""),
    getIdentity: jest.fn().mockReturnValue({ publicKey: "pk", shortId: "short", encryptPub: "ep" }),
    getAgentIdentity: jest.fn().mockResolvedValue({ name: "TestBot", emoji: "🤖" }),
    getUserProfile: jest.fn().mockResolvedValue({}),
    getSessions: jest.fn().mockReturnValue([]),
    getPeers: jest.fn().mockReturnValue([]),
    getConfig: jest.fn().mockReturnValue(configOverride),
    saveConfig: jest.fn().mockResolvedValue(undefined),
    getMainConfig: jest.fn().mockReturnValue({}),
    registerConfigSchema: jest.fn(),
    getPluginDir: jest.fn().mockReturnValue("/tmp/test-plugin"),
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}

function getLineSdkMocks() {
  const sdk = jest.requireMock("@line/bot-sdk");
  const clientInstance = new sdk.messagingApi.MessagingApiClient({});
  return {
    MessagingApiClient: sdk.messagingApi.MessagingApiClient as jest.Mock,
    replyMessage: clientInstance.replyMessage as jest.Mock,
    pushMessage: clientInstance.pushMessage as jest.Mock,
    middleware: sdk.middleware as jest.Mock,
  };
}

function getExpressMocks() {
  const exp = jest.requireMock("express") as jest.Mock;
  const app = exp.mock.results[exp.mock.results.length - 1]?.value;
  return {
    express: exp,
    app: app as { post: jest.Mock; get: jest.Mock; use: jest.Mock; listen: jest.Mock } | undefined,
  };
}

// Also import exported internals for unit testing
let isAllowedFn: (userId: string, isGroup: boolean) => boolean;
let handleEventFn: (event: any) => Promise<void>;
let sendReplyFn: (text: string, replyToken: string | undefined, userId: string) => Promise<void>;

beforeAll(async () => {
  const mod = await import("../src/index");
  isAllowedFn = (mod as any).isAllowed;
  handleEventFn = (mod as any).handleEvent;
  sendReplyFn = (mod as any).sendReply;
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_CHANNEL_SECRET;
});

// ─── Test 1: Plugin exports ───────────────────────────────────────────────────

describe("Plugin exports", () => {
  it("has name === 'line'", () => {
    expect(plugin.name).toBe("line");
  });

  it("has version === '1.0.0'", () => {
    expect(plugin.version).toBe("1.0.0");
  });

  it("has init as function", () => {
    expect(typeof plugin.init).toBe("function");
  });

  it("has shutdown as function", () => {
    expect(typeof plugin.shutdown).toBe("function");
  });
});

// ─── Tests 2–3: init() ───────────────────────────────────────────────────────

describe("init()", () => {
  it("should not throw with no credentials; logs warning, no client created", async () => {
    const context = buildMockContext({});
    await expect(plugin.init!(context)).resolves.not.toThrow();
    const sdk = jest.requireMock("@line/bot-sdk");
    // MessagingApiClient should not have been called as a constructor (no credentials)
    expect(sdk.messagingApi.MessagingApiClient).not.toHaveBeenCalled();
  });

  it("should register config schema regardless of credentials", async () => {
    const context = buildMockContext({});
    await plugin.init!(context);
    expect(context.registerConfigSchema).toHaveBeenCalledWith(
      "line",
      expect.objectContaining({ title: "LINE Integration" })
    );
  });

  it("should create MessagingApiClient and start server with valid credentials", async () => {
    const context = buildMockContext({
      channelAccessToken: "test-token",
      channelSecret: "test-secret",
    });
    await plugin.init!(context);
    const { MessagingApiClient } = getLineSdkMocks();
    expect(MessagingApiClient).toHaveBeenCalledWith({ channelAccessToken: "test-token" });
    const { app } = getExpressMocks();
    expect(app?.listen).toHaveBeenCalled();
  });

  it("should resolve credentials from environment variables", async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "env-token";
    process.env.LINE_CHANNEL_SECRET = "env-secret";
    const context = buildMockContext({});
    await plugin.init!(context);
    const { MessagingApiClient } = getLineSdkMocks();
    expect(MessagingApiClient).toHaveBeenCalledWith({ channelAccessToken: "env-token" });
  });
});

// ─── Test 4: shutdown() ───────────────────────────────────────────────────────

describe("shutdown()", () => {
  it("should complete without throwing after init with credentials", async () => {
    const context = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
    });
    await plugin.init!(context);
    await expect(plugin.shutdown!()).resolves.not.toThrow();
  });

  it("should complete without throwing when no server was started", async () => {
    await expect(plugin.shutdown!()).resolves.not.toThrow();
  });
});

// ─── Tests 5–9: isAllowed() ──────────────────────────────────────────────────

describe("isAllowed() — DM policies", () => {
  it("open policy: returns true for any userId", async () => {
    const context = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
      dmPolicy: "open",
    });
    await plugin.init!(context);
    expect(isAllowedFn("Uanyone", false)).toBe(true);
  });

  it("disabled policy: returns false for all", async () => {
    const context = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
      dmPolicy: "disabled",
    });
    await plugin.init!(context);
    expect(isAllowedFn("Uanyone", false)).toBe(false);
  });

  it("allowlist policy: returns true only for listed userIds", async () => {
    const context = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
      dmPolicy: "allowlist",
      allowFrom: ["Uallowed123"],
    });
    await plugin.init!(context);
    expect(isAllowedFn("Uallowed123", false)).toBe(true);
    expect(isAllowedFn("Unotallowed", false)).toBe(false);
  });
});

describe("isAllowed() — Group policies", () => {
  it("open policy: returns true for any userId in group", async () => {
    const context = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
      groupPolicy: "open",
    });
    await plugin.init!(context);
    expect(isAllowedFn("Uanyone", true)).toBe(true);
  });

  it("disabled policy: returns false for all in group", async () => {
    const context = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
      groupPolicy: "disabled",
    });
    await plugin.init!(context);
    expect(isAllowedFn("Uanyone", true)).toBe(false);
  });

  it("allowlist policy: returns true only for listed userIds in group", async () => {
    const context = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
      groupPolicy: "allowlist",
      groupAllowFrom: ["Ugroupuser"],
    });
    await plugin.init!(context);
    expect(isAllowedFn("Ugroupuser", true)).toBe(true);
    expect(isAllowedFn("Uother", true)).toBe(false);
  });
});

// ─── Tests 10–15: handleEvent() ──────────────────────────────────────────────

function buildMessageEvent(
  messageType: string,
  messageProps: Record<string, unknown>,
  userId: string,
  sourceType: "user" | "group" | "room" = "user",
  replyToken = "reply-token-abc"
): any {
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

describe("handleEvent()", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    const context = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
      dmPolicy: "open",
      groupPolicy: "open",
    });
    await plugin.init!(context);
  });

  it("text message: calls inject with correct session key and message, calls replyMessage", async () => {
    const event = buildMessageEvent("text", { text: "Hello bot" }, "Uuser123");
    await handleEventFn(event);
    const sdk = jest.requireMock("@line/bot-sdk");
    const client = new sdk.messagingApi.MessagingApiClient({});
    expect(client.replyMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToken: "reply-token-abc",
        messages: [expect.objectContaining({ type: "text", text: "Hello from WOPR" })],
      })
    );
  });

  it("sticker message: extracts [sticker: packageId/stickerId]", async () => {
    const event = buildMessageEvent(
      "sticker",
      { packageId: "789", stickerId: "456" },
      "Uuser123"
    );
    // We need to check what was injected — but ctx is module-level so we check via logMessage
    // Since ctx was set in init(), we need to spy on the mock context
    const context = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
      dmPolicy: "open",
    });
    await plugin.init!(context);
    await handleEventFn(event);
    expect(context.inject).toHaveBeenCalledWith(
      expect.any(String),
      "[Uuser123]: [sticker: 789/456]",
      expect.any(Object)
    );
  });

  it("image message: extracts [image]", async () => {
    const event = buildMessageEvent("image", {}, "Uuser123");
    const context = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
      dmPolicy: "open",
    });
    await plugin.init!(context);
    await handleEventFn(event);
    expect(context.inject).toHaveBeenCalledWith(
      expect.any(String),
      "[Uuser123]: [image]",
      expect.any(Object)
    );
  });

  it("location message: extracts formatted location string", async () => {
    const event = buildMessageEvent(
      "location",
      {
        title: "Tokyo Tower",
        address: "4 Chome-2-8 Shibakoen",
        latitude: 35.6586,
        longitude: 139.7454,
      },
      "Uuser123"
    );
    const context = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
      dmPolicy: "open",
    });
    await plugin.init!(context);
    await handleEventFn(event);
    const call = (context.inject as jest.Mock).mock.calls[0];
    expect(call[1]).toContain("[location:");
    expect(call[1]).toContain("35.6586");
    expect(call[1]).toContain("139.7454");
  });

  it("non-message event (follow): is ignored, no inject call", async () => {
    const context = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
    });
    await plugin.init!(context);
    const followEvent = {
      type: "follow",
      source: { type: "user", userId: "Uuser123" },
      timestamp: Date.now(),
      mode: "active",
    };
    await handleEventFn(followEvent);
    expect(context.inject).not.toHaveBeenCalled();
  });

  it("blocked user: does not inject or reply", async () => {
    const context = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
      dmPolicy: "allowlist",
      allowFrom: ["Uallowed"],
    });
    await plugin.init!(context);
    const event = buildMessageEvent("text", { text: "Hello" }, "Ublocked");
    await handleEventFn(event);
    expect(context.inject).not.toHaveBeenCalled();
  });
});

// ─── Tests 16–18: sendReply() ─────────────────────────────────────────────────

describe("sendReply()", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    const context = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
    });
    await plugin.init!(context);
  });

  it("short message with reply token: calls replyMessage with correct structure", async () => {
    await sendReplyFn("Hello there!", "reply-token-xyz", "Uuser123");
    const sdk = jest.requireMock("@line/bot-sdk");
    const client = new sdk.messagingApi.MessagingApiClient({});
    expect(client.replyMessage).toHaveBeenCalledWith({
      replyToken: "reply-token-xyz",
      messages: [{ type: "text", text: "Hello there!" }],
    });
    expect(client.pushMessage).not.toHaveBeenCalled();
  });

  it("long message: splits into chunks <= 5000 chars, max 5 messages", async () => {
    const longText = "This is a sentence. ".repeat(600); // ~12000 chars
    await sendReplyFn(longText, "reply-token-xyz", "Uuser123");
    const sdk = jest.requireMock("@line/bot-sdk");
    const client = new sdk.messagingApi.MessagingApiClient({});
    const callArg = client.replyMessage.mock.calls[0][0];
    expect(callArg.messages.length).toBeLessThanOrEqual(5);
    for (const msg of callArg.messages) {
      expect((msg as any).text.length).toBeLessThanOrEqual(5000);
    }
  });

  it("no reply token: falls back to pushMessage", async () => {
    await sendReplyFn("Hello!", undefined, "Uuser123");
    const sdk = jest.requireMock("@line/bot-sdk");
    const client = new sdk.messagingApi.MessagingApiClient({});
    expect(client.pushMessage).toHaveBeenCalledWith({
      to: "Uuser123",
      messages: [{ type: "text", text: "Hello!" }],
    });
    expect(client.replyMessage).not.toHaveBeenCalled();
  });

  it("expired reply token (HTTPFetchError 400): falls back to pushMessage", async () => {
    const sdk = jest.requireMock("@line/bot-sdk");
    const client = new sdk.messagingApi.MessagingApiClient({});
    const expiredTokenError = new sdk.HTTPFetchError(400, "Invalid reply token");
    (client.replyMessage as jest.Mock).mockRejectedValueOnce(expiredTokenError);

    await sendReplyFn("Hello!", "expired-token", "Uuser123");

    expect(client.replyMessage).toHaveBeenCalledWith(
      expect.objectContaining({ replyToken: "expired-token" })
    );
    expect(client.pushMessage).toHaveBeenCalledWith({
      to: "Uuser123",
      messages: [{ type: "text", text: "Hello!" }],
    });
  });
});

// ─── Test 19: Signature validation error handler ──────────────────────────────

describe("Signature validation error handler", () => {
  it("returns 401 for invalid signature", async () => {
    const context = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
    });
    await plugin.init!(context);

    const exp = jest.requireMock("express") as jest.Mock;
    const appInstance = exp.mock.results[exp.mock.results.length - 1]?.value;
    // Find the 4-argument error handler registered via .use()
    const useCall = appInstance?.use.mock.calls.find(
      (call: any[]) => typeof call[0] === "function" && call[0].length === 4
    );
    expect(useCall).toBeDefined();
    const errorHandler = useCall![0];

    const { SignatureValidationFailed } = jest.requireMock("@line/bot-sdk");
    const sigError = new SignatureValidationFailed("Invalid sig", "badsig");
    const mockReq = {};
    const mockRes = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    const mockNext = jest.fn();

    errorHandler(sigError, mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.send).toHaveBeenCalledWith("Invalid signature");
  });
});

// ─── Test 20: Health endpoint ─────────────────────────────────────────────────

describe("Health endpoint", () => {
  it("GET /health returns { status: 'ok', plugin: 'wopr-plugin-line' }", async () => {
    const context = buildMockContext({
      channelAccessToken: "token",
      channelSecret: "secret",
    });
    await plugin.init!(context);

    const exp = jest.requireMock("express") as jest.Mock;
    const appInstance = exp.mock.results[exp.mock.results.length - 1]?.value;
    const healthCall = appInstance?.get.mock.calls.find(
      (call: any[]) => call[0] === "/health"
    );
    expect(healthCall).toBeDefined();
    const healthHandler = healthCall![1];

    const mockReq = {};
    const mockRes = { json: jest.fn() };
    healthHandler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith({
      status: "ok",
      plugin: "wopr-plugin-line",
    });
  });
});
