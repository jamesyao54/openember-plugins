/**
 * Cross-channel identity extraction and canonical resolution.
 *
 * Builds on top of existing user-resolve.ts logic but produces structured
 * ExternalIdentity objects and resolves through ProfileStore when available.
 */

import type { ProfileStore } from "./store.js";
import type { ExternalIdentity } from "./types.js";
import { extractPeerIdFromSessionKey, extractSenderFromPrompt } from "../user-resolve.js";

/** SessionKey patterns → provider mapping */
const SESSION_KEY_DIRECT_RE = /^agent:([^:]+):direct:(.+)$/;
const SESSION_KEY_MAIN_RE = /^agent:([^:]+):main$/;
const SESSION_KEY_GROUP_RE = /^agent:([^:]+):group:(.+)$/;

/**
 * Extract a structured ExternalIdentity from available context.
 *
 * Priority:
 * 1. senderId + channelId (from ToolContext / HookContext)
 * 2. sessionKey parsing
 * 3. Sender metadata from prompt text
 */
export function extractExternalIdentity(
  sessionKey?: string,
  prompt?: string,
  channelId?: string,
  senderId?: string,
): ExternalIdentity | null {
  // 1. SessionKey parsing — most reliable provider source
  if (sessionKey) {
    const directMatch = sessionKey.match(SESSION_KEY_DIRECT_RE);
    if (directMatch) {
      const provider = normalizeProvider(directMatch[1]!);
      return { provider, externalId: directMatch[2]! };
    }

    const mainMatch = sessionKey.match(SESSION_KEY_MAIN_RE);
    if (mainMatch) {
      const provider = normalizeProvider(mainMatch[1]!);
      return { provider, externalId: "main" };
    }

    const groupMatch = sessionKey.match(SESSION_KEY_GROUP_RE);
    if (groupMatch && senderId) {
      const provider = normalizeProvider(groupMatch[1]!);
      return { provider, externalId: senderId };
    }

    // SessionKey exists but didn't match known patterns — use it for provider hint
    if (senderId) {
      const provider = providerFromSessionKey(sessionKey);
      if (provider !== "unknown") {
        return { provider, externalId: senderId };
      }
    }
  }

  // 2. Explicit senderId + channelId (from PluginCommandContext or HookContext)
  //    channelId might be a provider name ("discord") or a numeric channel ID ("1483885868300238938").
  //    Only use it as provider if it looks like a provider name, not a numeric ID.
  if (senderId && channelId) {
    const provider = looksLikeProviderId(channelId) ? normalizeProvider(channelId) : null;
    if (provider) {
      return { provider, externalId: senderId };
    }
  }

  // 3. Sender metadata from prompt text
  if (prompt) {
    const fromPrompt = extractSenderFromPrompt(prompt);
    if (fromPrompt) {
      // Best-effort provider detection from sessionKey prefix
      const provider = sessionKey ? providerFromSessionKey(sessionKey) : "unknown";
      return { provider, externalId: fromPrompt };
    }
  }

  return null;
}

/**
 * Resolve a canonical user ID using the ProfileStore.
 *
 * When store is null, falls back to legacy resolveUserId behavior.
 */
export function resolveCanonicalUserId(
  store: ProfileStore | null,
  sessionKey?: string,
  prompt?: string,
  channelId?: string,
  senderId?: string,
  autoCreate?: boolean,
  hint?: { label?: string },
): string | null {
  if (!store) {
    // Legacy fallback — raw channel IDs
    const fromSession = extractPeerIdFromSessionKey(sessionKey);
    if (fromSession) return fromSession;
    if (prompt) {
      const fromPrompt = extractSenderFromPrompt(prompt);
      if (fromPrompt) return fromPrompt;
    }
    return null;
  }

  const identity = extractExternalIdentity(sessionKey, prompt, channelId, senderId);
  if (!identity) return null;

  const existing = store.resolveCanonicalId(identity.provider, identity.externalId);
  if (existing) return existing;

  if (autoCreate !== false) {
    return store.getOrCreateUser(identity.provider, identity.externalId, hint);
  }

  return null;
}

// ─── Helpers ───

/** Returns true if the value looks like a provider name (e.g. "discord"), not a numeric channel ID. */
function looksLikeProviderId(value: string): boolean {
  // Numeric-only strings are Discord/Telegram channel IDs, not provider names
  return !/^\d+$/.test(value);
}

function normalizeProvider(raw: string): string {
  const lower = raw.toLowerCase();
  // Map common agent names to provider names
  if (lower === "ember" || lower === "discord") return "discord";
  if (lower === "tg" || lower === "telegram") return "telegram";
  if (lower === "web" || lower === "webchat") return "webchat";
  if (lower === "slack") return "slack";
  return lower;
}

function providerFromSessionKey(sessionKey: string): string {
  const match = sessionKey.match(/^agent:([^:]+):/);
  return match ? normalizeProvider(match[1]!) : "unknown";
}
