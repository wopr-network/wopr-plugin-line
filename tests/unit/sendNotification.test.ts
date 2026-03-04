/**
 * Unit tests for sendNotification() and postback handling in the LINE plugin.
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
  class MessagingApiClient {
    replyMessage = mockReplyMessage;
    pushMessage = mockPushMessage;
  }

  return {
    HTTPFetchError,
    SignatureValidationFailed,
    JSONParseError,
    middleware: vi.fn().mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
    messagingApi: {
      MessagingApiClient,
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
import {
  buildFriendRequestFlexMessage,
  clearPendingNotifications,
  handleEvent,
} from "../../src/index.js";
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildFriendRequestFlexMessage", () => {
  it("should return a Flex Message with accept and deny postback buttons", () => {
    const msg = buildFriendRequestFlexMessage("Alice", "notif_1");
    expect(msg.type).toBe("flex");
    expect(msg.altText).toContain("Friend Request");
    const body = (msg.contents as Record<string, unknown>).body as Record<string, unknown>;
    expect(body).toBeDefined();
    const footer = (msg.contents as Record<string, unknown>).footer as Record<string, unknown>;
    expect(footer).toBeDefined();
    const footerContents = footer.contents as Array<Record<string, unknown>>;
    expect(footerContents).toHaveLength(2);
    // Accept button
    const acceptAction = footerContents[0].action as Record<string, unknown>;
    expect(acceptAction.type).toBe("postback");
    expect(acceptAction.data).toBe("notif_accept:notif_1");
    expect(acceptAction.displayText).toBe("Accept");
    // Deny button
    const denyAction = footerContents[1].action as Record<string, unknown>;
    expect(denyAction.type).toBe("postback");
    expect(denyAction.data).toBe("notif_deny:notif_1");
    expect(denyAction.displayText).toBe("Deny");
  });

  it("should use 'Someone' when fromName is empty", () => {
    const msg = buildFriendRequestFlexMessage("", "notif_2");
    const body = (msg.contents as Record<string, unknown>).body as Record<string, unknown>;
    const bodyContents = body.contents as Array<Record<string, unknown>>;
    const bodyText = bodyContents[1].text as string;
    expect(bodyText).toContain("Someone");
  });
});

describe("sendNotification", () => {
  let mockCtx: WOPRPluginContext;
  let provider: Record<string, unknown>;

  beforeEach(async () => {
    mockPushMessage.mockClear();
    mockReplyMessage.mockClear();
    mockListen.mockClear();
    mockAppPost.mockClear();
    mockAppGet.mockClear();
    mockAppUse.mockClear();
    mockServerClose.mockClear();
    clearPendingNotifications();
    mockCtx = buildMockContext({ channelAccessToken: "token", channelSecret: "secret" });
    await plugin.init!(mockCtx);
    provider = (mockCtx.registerChannelProvider as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
  });

  it("should send Flex Message for friend-request notification", async () => {
    expect(provider.sendNotification).toBeDefined();

    const callbacks = {
      onAccept: vi.fn().mockResolvedValue(undefined),
      onDeny: vi.fn().mockResolvedValue(undefined),
    };

    await (provider.sendNotification as Function)("dm:Uuser123", { type: "friend-request", from: "Alice" }, callbacks);

    expect(mockPushMessage).toHaveBeenCalledOnce();
    const pushArg = mockPushMessage.mock.calls[0][0] as { to: string; messages: Array<{ type: string }> };
    expect(pushArg.to).toBe("Uuser123");
    expect(pushArg.messages).toHaveLength(1);
    expect(pushArg.messages[0].type).toBe("flex");
  });

  it("should ignore non-friend-request notification types", async () => {
    await (provider.sendNotification as Function)("dm:Uuser123", { type: "some-other-type" }, {});
    expect(mockPushMessage).not.toHaveBeenCalled();
  });

  it("should throw if LINE client is not initialized (no credentials)", async () => {
    // Shutdown first to clear lineClient, then init without credentials
    await plugin.shutdown!();
    const noCredCtx = buildMockContext({});
    await plugin.init!(noCredCtx);
    const noCredProvider = (noCredCtx.registerChannelProvider as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    await expect(
      (noCredProvider.sendNotification as Function)("dm:Uuser123", { type: "friend-request" }, {}),
    ).rejects.toThrow("LINE client not initialized");
  });
});

describe("postback event handling", () => {
  let mockCtx: WOPRPluginContext;
  let provider: Record<string, unknown>;

  beforeEach(async () => {
    mockPushMessage.mockClear();
    mockReplyMessage.mockClear();
    mockListen.mockClear();
    mockAppPost.mockClear();
    mockAppGet.mockClear();
    mockAppUse.mockClear();
    mockServerClose.mockClear();
    clearPendingNotifications();
    mockCtx = buildMockContext({ channelAccessToken: "token", channelSecret: "secret" });
    await plugin.init!(mockCtx);
    provider = (mockCtx.registerChannelProvider as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
  });

  it("should fire onAccept callback on notif_accept postback", async () => {
    const callbacks = {
      onAccept: vi.fn().mockResolvedValue(undefined),
      onDeny: vi.fn().mockResolvedValue(undefined),
    };

    await (provider.sendNotification as Function)("dm:Uuser123", { type: "friend-request", from: "Alice" }, callbacks);

    const flexMsg = mockPushMessage.mock.calls[0][0] as {
      messages: Array<{ contents: { footer: { contents: Array<{ action: { data: string } }> } } }>;
    };
    const acceptData = flexMsg.messages[0].contents.footer.contents[0].action.data;
    const notifId = acceptData.replace("notif_accept:", "");

    const postbackEvent = {
      type: "postback",
      source: { type: "user", userId: "Uuser123" },
      replyToken: "reply-token-postback",
      postback: { data: `notif_accept:${notifId}` },
      timestamp: Date.now(),
      mode: "active",
    };

    await handleEvent(postbackEvent as never);

    expect(callbacks.onAccept).toHaveBeenCalledOnce();
    expect(callbacks.onDeny).not.toHaveBeenCalled();
    expect(mockReplyMessage).toHaveBeenCalled();
  });

  it("should fire onDeny callback on notif_deny postback", async () => {
    const callbacks = {
      onAccept: vi.fn().mockResolvedValue(undefined),
      onDeny: vi.fn().mockResolvedValue(undefined),
    };

    await (provider.sendNotification as Function)("dm:Uuser123", { type: "friend-request", from: "Alice" }, callbacks);

    const flexMsg = mockPushMessage.mock.calls[0][0] as {
      messages: Array<{ contents: { footer: { contents: Array<{ action: { data: string } }> } } }>;
    };
    const denyData = flexMsg.messages[0].contents.footer.contents[1].action.data;
    const notifId = denyData.replace("notif_deny:", "");

    const postbackEvent = {
      type: "postback",
      source: { type: "user", userId: "Uuser123" },
      replyToken: "reply-token-postback",
      postback: { data: `notif_deny:${notifId}` },
      timestamp: Date.now(),
      mode: "active",
    };

    await handleEvent(postbackEvent as never);

    expect(callbacks.onDeny).toHaveBeenCalledOnce();
    expect(callbacks.onAccept).not.toHaveBeenCalled();
  });

  it("should remove pending notification after callback fires (no double-fire)", async () => {
    const callbacks = { onAccept: vi.fn().mockResolvedValue(undefined) };

    await (provider.sendNotification as Function)("dm:Uuser123", { type: "friend-request", from: "Alice" }, callbacks);

    const flexMsg = mockPushMessage.mock.calls[0][0] as {
      messages: Array<{ contents: { footer: { contents: Array<{ action: { data: string } }> } } }>;
    };
    const acceptData = flexMsg.messages[0].contents.footer.contents[0].action.data;
    const notifId = acceptData.replace("notif_accept:", "");

    const postbackEvent = {
      type: "postback",
      source: { type: "user", userId: "Uuser123" },
      replyToken: "reply-token-1",
      postback: { data: `notif_accept:${notifId}` },
      timestamp: Date.now(),
      mode: "active",
    };

    await handleEvent(postbackEvent as never);
    expect(callbacks.onAccept).toHaveBeenCalledOnce();

    // Second postback -- callback should NOT fire again
    mockReplyMessage.mockClear();
    await handleEvent({ ...postbackEvent, replyToken: "reply-token-2" } as never);
    expect(callbacks.onAccept).toHaveBeenCalledOnce(); // still 1
  });

  it("should handle postback with unknown notification ID gracefully", async () => {
    const postbackEvent = {
      type: "postback",
      source: { type: "user", userId: "Uuser123" },
      replyToken: "reply-token-postback",
      postback: { data: "notif_accept:notif_999" },
      timestamp: Date.now(),
      mode: "active",
    };

    await handleEvent(postbackEvent as never);
    // Should not throw, just reply with "expired" message
    expect(mockReplyMessage).toHaveBeenCalled();
  });

  it("should ignore postback events with non-notification data", async () => {
    const postbackEvent = {
      type: "postback",
      source: { type: "user", userId: "Uuser123" },
      replyToken: "reply-token-postback",
      postback: { data: "some_other_action" },
      timestamp: Date.now(),
      mode: "active",
    };

    await handleEvent(postbackEvent as never);
    expect(mockReplyMessage).not.toHaveBeenCalled();
    expect(mockPushMessage).not.toHaveBeenCalled();
  });
});
