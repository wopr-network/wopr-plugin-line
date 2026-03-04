/**
 * Type definitions for the WOPR LINE plugin.
 *
 * Shared types are re-exported from @wopr-network/plugin-types.
 * Plugin-specific types that don't exist in the shared package are defined here.
 */

// Re-export all shared types that this plugin uses
export type {
  AgentIdentity,
  ChannelCommand,
  ChannelMessageParser,
  ChannelNotificationCallbacks,
  ChannelNotificationPayload,
  ChannelProvider,
  ChannelRef,
  ConfigField,
  ConfigSchema,
  PluginLogger,
  WOPRPlugin,
  WOPRPluginContext,
} from "@wopr-network/plugin-types";
