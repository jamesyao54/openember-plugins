/**
 * User Profiles module — registers commands, tools, and hooks when userProfiles is enabled.
 */

import { Type } from "@sinclair/typebox";
import type { ProfileStore } from "./store.js";
import type { UserProfile } from "./types.js";
import { BindFlowManager } from "./bind-flow.js";
import { extractExternalIdentity, resolveCanonicalUserId } from "./identity-resolve.js";
import { migrateMemoryNamespace } from "./migration.js";
import type { OpenVikingClient } from "../client.js";
import type { UserProfilesParsedConfig } from "../config.js";

/** OpenClaw plugin command context (v2026.3+) */
type PluginCommandContext = {
  senderId?: string;
  channel?: string;
  channelId?: string;
  isAuthorizedSender?: boolean;
  args?: string;
  commandBody?: string;
  from?: string;
  to?: string;
  sessionKey?: string;
};

/** OpenClaw command result — { text } */
type PluginCommandResult = { text?: string };

type PluginApi = {
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  registerTool: (factory: (ctx: ToolCtx) => unknown[], options: { names: string[] }) => void;
  on: (event: string, handler: (event: any, ctx?: any) => Promise<unknown> | void) => void;
  registerCommand?: (cmd: {
    name: string;
    description: string;
    handler: (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
    acceptsArgs?: boolean;
  }) => void;
};

type ToolCtx = {
  agentId?: string;
  sessionKey?: string;
  requesterSenderId?: string;
};

// Debounce interval for lastSeenAt updates (1 minute)
const LAST_SEEN_DEBOUNCE_MS = 60_000;

export function registerUserProfiles(
  api: PluginApi,
  profileCfg: UserProfilesParsedConfig,
  store: ProfileStore,
  agentId: string,
  createConfiguredClient: (userId: string | null, agentId: string) => OpenVikingClient,
): void {
  const bindManager = new BindFlowManager(store, profileCfg.tokenTtlMs);
  const lastSeenTimestamps = new Map<string, number>();

  // ─── Commands ───

  if (api.registerCommand) {
    // /bind — initiate cross-channel identity binding
    api.registerCommand({
      name: "bind",
      description: "Link this channel's identity to another channel. Generates a verification code.",
      async handler(ctx) {
        const identity = extractExternalIdentity(ctx.sessionKey, undefined, ctx.channel ?? ctx.channelId, ctx.senderId);
        if (!identity) {
          return { text: "Could not determine your identity. Please try from a channel with a known session." };
        }

        const canonical = resolveCanonicalUserId(store, ctx.sessionKey, undefined, ctx.channel ?? ctx.channelId, ctx.senderId);
        if (!canonical) {
          return { text: "Could not resolve your user profile. Please try again." };
        }

        const token = bindManager.createBind(identity.provider, identity.externalId, canonical);
        const ttlMinutes = Math.round(profileCfg.tokenTtlMs / 60_000);
        return { text: `Your bind code is **${token}**.\n\nEnter \`/verify ${token}\` from another channel within ${ttlMinutes} minutes to link your identities.` };
      },
    });

    // /verify — complete cross-channel identity binding
    api.registerCommand({
      name: "verify",
      description: "Complete identity binding by entering the code from /bind.",
      acceptsArgs: true,
      async handler(ctx) {
        const token = (ctx.args ?? "").trim();
        if (!token) {
          return { text: "Usage: `/verify <code>`\n\nEnter the 6-character code from `/bind`." };
        }

        const verifierIdentity = extractExternalIdentity(ctx.sessionKey, undefined, ctx.channel ?? ctx.channelId, ctx.senderId);
        if (!verifierIdentity) {
          return { text: "Could not determine your identity on this channel." };
        }

        const result = bindManager.verifyBind(token, verifierIdentity);

        if (!result.ok) {
          const messages: Record<string, string> = {
            invalid_or_expired_token: "Invalid or expired code. Please run `/bind` again.",
            token_expired: "This code has expired. Please run `/bind` again.",
            same_identity: "You cannot verify from the same identity that initiated `/bind`. Use a different channel.",
          };
          return { text: messages[result.reason] ?? `Verification failed: ${result.reason}` };
        }

        // Trigger memory migration if profiles were merged
        if (result.merged) {
          migrateMemoryNamespace(
            createConfiguredClient,
            verifierIdentity.externalId,
            result.canonicalId,
            agentId,
            api.logger,
          ).catch((err) => {
            api.logger.warn?.(`user-profiles: post-bind memory migration failed: ${String(err)}`);
          });
        }

        return { text: `Bound! Your identities are now linked.\n\nCanonical ID: \`${result.canonicalId}\`` };
      },
    });

    // /profile — view current user profile
    api.registerCommand({
      name: "profile",
      description: "View your user profile.",
      async handler(ctx) {
        const canonical = resolveCanonicalUserId(store, ctx.sessionKey, undefined, ctx.channel ?? ctx.channelId, ctx.senderId, false);
        if (!canonical) {
          return { text: "No profile found for your identity." };
        }

        const profile = store.getProfile(canonical);
        if (!profile) {
          return { text: "Profile exists in identity map but data is missing." };
        }

        const identities = profile.linkedIdentities
          .map((li) => `  - ${li.provider}:${li.externalId}${li.label ? ` (${li.label})` : ""}`)
          .join("\n");

        const lines = [
          `**Profile: ${profile.displayName}**`,
          `Canonical ID: \`${profile.canonicalId}\``,
          profile.role ? `Role: ${profile.role}` : null,
          profile.language ? `Language: ${profile.language}` : null,
          profile.timezone ? `Timezone: ${profile.timezone}` : null,
          profile.bio ? `Bio: ${profile.bio}` : null,
          `Linked identities:\n${identities}`,
          profile.tags.length > 0 ? `Tags: ${profile.tags.join(", ")}` : null,
          profile.notes ? `Notes:\n${profile.notes}` : null,
        ].filter(Boolean);

        return { text: lines.join("\n") };
      },
    });
  }

  // ─── Tool: user_profile_update ───

  const profileToolFactory = (ctx: ToolCtx) => {
    const userId = resolveCanonicalUserId(store, ctx.sessionKey, undefined, undefined, ctx.requesterSenderId, false);

    const userProfileUpdateTool = {
      name: "user_profile_update",
      label: "User Profile Update",
      description:
        "Update a user's profile field. Use when learning stable user facts like language preference, timezone, role, or personal notes. " +
        "For 'notes', read the current value first, merge with new info, and write back the complete version.",
      parameters: Type.Object({
        field: Type.String({
          description:
            "Profile field to update. One of: displayName, role, language, timezone, bio, notes, tags",
        }),
        value: Type.Union([Type.String(), Type.Array(Type.String())], {
          description: "New value for the field. For 'tags', provide an array of strings.",
        }),
        targetUserId: Type.Optional(
          Type.String({
            description: "Canonical user ID to update. Defaults to the current user.",
          }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const field = params.field as string;
        const value = params.value;
        const targetId = (params.targetUserId as string) || userId;

        if (!targetId) {
          return {
            content: [{ type: "text" as const, text: "Cannot determine user. No profile to update." }],
          };
        }

        const allowedFields = ["displayName", "role", "language", "timezone", "bio", "notes", "tags"];
        if (!allowedFields.includes(field)) {
          return {
            content: [{ type: "text" as const, text: `Invalid field "${field}". Allowed: ${allowedFields.join(", ")}` }],
          };
        }

        const profile = store.getProfile(targetId);
        if (!profile) {
          return {
            content: [{ type: "text" as const, text: `No profile found for canonical ID ${targetId}.` }],
          };
        }

        if (field === "tags") {
          const tags = Array.isArray(value) ? value.map(String) : [String(value)];
          store.updateProfile(targetId, { tags });
        } else {
          store.updateProfile(targetId, { [field]: String(value) });
        }

        return {
          content: [{ type: "text" as const, text: `Updated ${field} for user ${profile.displayName}.` }],
          details: { canonicalId: targetId, field, value },
        };
      },
    };

    return [userProfileUpdateTool];
  };

  api.registerTool(profileToolFactory, { names: ["user_profile_update"] });

  // ─── Hook: before_prompt_build — profile injection ───

  if (profileCfg.injectProfile) {
    api.on("before_prompt_build", async (event: any, ctx: any) => {
      const canonical = resolveCanonicalUserId(
        store,
        ctx?.sessionKey,
        event.prompt,
        ctx?.channelId,
        ctx?.senderId,
      );
      if (!canonical) return;

      const profile = store.getProfile(canonical);
      if (!profile) return;

      const profileBlock = formatProfileBlock(profile);
      if (!profileBlock) return;

      // Update lastSeenAt (debounced)
      const now = Date.now();
      const lastSeen = lastSeenTimestamps.get(canonical) ?? 0;
      if (now - lastSeen > LAST_SEEN_DEBOUNCE_MS) {
        lastSeenTimestamps.set(canonical, now);
        const identity = extractExternalIdentity(ctx?.sessionKey, undefined, ctx?.channelId, ctx?.senderId);
        store.updateProfile(canonical, {
          lastSeenAt: now,
          lastChannel: identity?.provider ?? profile.lastChannel,
        });
      }

      return {
        prependContext: profileBlock,
      };
    });
  }

  // ─── Hook: message_received — lastSeenAt (debounced) ───

  api.on("message_received", async (_event: any, ctx: any) => {
    const canonical = resolveCanonicalUserId(
      store,
      ctx?.sessionKey,
      undefined,
      ctx?.channelId,
      ctx?.senderId,
      profileCfg.autoCreateProfile,
    );
    if (!canonical) return;

    const now = Date.now();
    const lastSeen = lastSeenTimestamps.get(canonical) ?? 0;
    if (now - lastSeen > LAST_SEEN_DEBOUNCE_MS) {
      lastSeenTimestamps.set(canonical, now);
      const identity = extractExternalIdentity(ctx?.sessionKey, undefined, ctx?.channelId, ctx?.senderId);
      store.updateProfile(canonical, {
        lastSeenAt: now,
        lastChannel: identity?.provider ?? "",
      });
    }
  });

  api.logger.info?.("user-profiles: registered commands, tools, and hooks");
}

// ─── Helpers ───

function formatProfileBlock(profile: UserProfile): string | null {
  const parts: string[] = [];

  parts.push(`ID: ${profile.canonicalId}`);
  if (profile.displayName) parts.push(`Name: ${profile.displayName}`);
  if (profile.role) parts.push(`Role: ${profile.role}`);
  if (profile.language) parts.push(`Language: ${profile.language}`);
  if (profile.timezone) parts.push(`Timezone: ${profile.timezone}`);
  if (profile.bio) parts.push(`Bio: ${profile.bio}`);
  if (profile.notes) parts.push(`Notes:\n${profile.notes}`);
  if (profile.tags.length > 0) parts.push(`Tags: ${profile.tags.join(", ")}`);

  if (parts.length === 0) return null;

  const instruction =
    "When you learn stable facts about this user (e.g. their name, display name, " +
    "language preference, timezone, role, interests, or other lasting personal details), " +
    "call the user_profile_update tool to save them. " +
    "For the \"notes\" field, read the current value above first, merge new info, and write back the complete version. " +
    "Do not ask for permission — just update silently when you notice new facts.";

  return `<user-profile>\n${parts.join("\n")}\n\n${instruction}\n</user-profile>`;
}

export { ProfileStore } from "./store.js";
export { BindFlowManager } from "./bind-flow.js";
export { extractExternalIdentity, resolveCanonicalUserId } from "./identity-resolve.js";
export { migrateMemoryNamespace } from "./migration.js";
export type { UserProfile, ExternalIdentity, BindResult } from "./types.js";
