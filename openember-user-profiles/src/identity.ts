import type { UserProfileStore } from "./store.js";

/**
 * Resolve a canonical user ID from channel context.
 * Tries the identity map first, falls back to peerId.
 */
export function resolveUserId(
  store: UserProfileStore,
  channel: string,
  peerId: string
): string {
  return store.resolveCanonicalId(channel, peerId) ?? peerId;
}

/**
 * Extract channel name from OpenClaw channel identifier.
 * E.g., "imessage" from the channel context, or "unknown" as fallback.
 */
export function extractChannelName(channelId?: string): string {
  if (!channelId) return "unknown";
  // OpenClaw channel IDs can be like "imessage", "feishu", "discord", etc.
  return channelId.toLowerCase().trim() || "unknown";
}
