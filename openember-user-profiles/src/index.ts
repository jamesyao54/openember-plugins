import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import { UserProfileStore } from "./store.js";
import { extractUserIdFromSessionKey } from "./session-key.js";
import { extractChannelName } from "./identity.js";

interface PluginConfig {
  dataDir?: string;
}

interface ToolContext {
  sessionKey?: string;
  channelId?: string;
  peerDisplayName?: string;
  senderIsOwner?: boolean;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

const plugin = {
  id: "openember-user-profiles",
  name: "OpenEmber User Profiles",
  description:
    "User profile management, identity resolution, and context injection for multi-user OpenClaw",
  version: "0.1.0",
  kind: "general" as const,

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(api: any) {
    const rawConfig = (api.pluginConfig ?? {}) as PluginConfig;
    const workspaceDir: string = api.workspaceDir ?? process.cwd();
    const dataDir = path.resolve(workspaceDir, rawConfig.dataDir ?? "./users");

    const store = new UserProfileStore(dataDir);
    let storeLoaded = false;

    const ensureLoaded = async (): Promise<void> => {
      if (!storeLoaded) {
        await store.load();
        storeLoaded = true;
      }
    };

    // Tool factory: provides admin_users and user_context tools, handles user context
    api.registerTool(
      (ctx: ToolContext) => {
        const tools: unknown[] = [];

        // Auto-resolve user on each tool factory call (runs per-session)
        const userId = extractUserIdFromSessionKey(ctx.sessionKey);

        if (userId) {
          // Touch the profile to update lastSeen (fire-and-forget)
          ensureLoaded()
            .then(() => {
              const channel = extractChannelName(ctx.channelId);
              const profile = store.resolveOrCreate(channel, userId, ctx.peerDisplayName);
              profile.lastSeen = new Date().toISOString();
              store.flush().catch(() => {});
            })
            .catch(() => {});
        }

        // Admin tool — only visible to owner
        if (ctx.senderIsOwner) {
          tools.push({
            label: "User Admin",
            name: "admin_users",
            description:
              "List all users, view user details, manage tags and notes. Only available to the admin/owner.",
            parameters: Type.Object({
              action: Type.Union([
                Type.Literal("list"),
                Type.Literal("show"),
                Type.Literal("tag"),
                Type.Literal("note"),
                Type.Literal("merge"),
              ]),
              userId: Type.Optional(
                Type.String({ description: "Target user ID" })
              ),
              value: Type.Optional(
                Type.String({ description: "Value for tag/note/merge operations" })
              ),
            }),
            execute: async (
              _toolCallId: string,
              params: {
                action: "list" | "show" | "tag" | "note" | "merge";
                userId?: string;
                value?: string;
              }
            ): Promise<ToolResult> => {
              await ensureLoaded();
              const { action, userId: targetId, value } = params;

              switch (action) {
                case "list": {
                  const users = store.listAll().map((u) => ({
                    id: u.canonicalId,
                    name: u.displayName,
                    access: u.accessLevel,
                    channels: u.channelIds.map((c) => c.channel).join(", "),
                    firstSeen: u.firstSeen,
                    lastSeen: u.lastSeen,
                    tags: u.tags,
                  }));
                  return jsonResult({ users, total: users.length });
                }
                case "show": {
                  if (!targetId) return jsonResult({ error: "userId required" });
                  const profile = store.getByCanonicalId(targetId);
                  if (!profile)
                    return jsonResult({ error: `User ${targetId} not found` });
                  return jsonResult({ profile });
                }
                case "tag": {
                  if (!targetId || !value)
                    return jsonResult({ error: "userId and value required" });
                  const profile = store.getByCanonicalId(targetId);
                  if (!profile)
                    return jsonResult({ error: `User ${targetId} not found` });
                  const newTags = [
                    ...new Set([
                      ...profile.tags,
                      ...value
                        .split(",")
                        .map((t) => t.trim())
                        .filter(Boolean),
                    ]),
                  ];
                  store.updateProfile(targetId, { tags: newTags });
                  return jsonResult({ success: true, tags: newTags });
                }
                case "note": {
                  if (!targetId || value === undefined)
                    return jsonResult({ error: "userId and value required" });
                  store.updateProfile(targetId, { notes: value });
                  return jsonResult({ success: true });
                }
                case "merge": {
                  if (!targetId || !value)
                    return jsonResult({
                      error: "userId (target) and value (source) required",
                    });
                  const ok = store.mergeProfiles(targetId, value);
                  return jsonResult({
                    success: ok,
                    error: ok ? undefined : "Merge failed — check IDs",
                  });
                }
                default: {
                  const _exhaustive: never = action;
                  return jsonResult({ error: `Unknown action: ${String(_exhaustive)}` });
                }
              }
            },
          });
        }

        // User context tool — allows the agent to look up current user info
        tools.push({
          label: "User Context",
          name: "user_context",
          description:
            "Get the current user's profile information including name, preferences, and history.",
          parameters: Type.Object({}),
          execute: async (
            _toolCallId: string,
            _params: Record<string, never>
          ): Promise<ToolResult> => {
            await ensureLoaded();
            const uid = extractUserIdFromSessionKey(ctx.sessionKey);
            if (!uid)
              return jsonResult({ error: "Cannot determine user from session" });
            const profile = store.getByCanonicalId(uid);
            if (!profile)
              return jsonResult({ error: "No profile found", userId: uid });
            return jsonResult({
              userId: profile.canonicalId,
              displayName: profile.displayName,
              accessLevel: profile.accessLevel,
              firstSeen: profile.firstSeen,
              lastSeen: profile.lastSeen,
              channels: profile.channelIds.map(
                (c) => `${c.channel}:${c.peerId}`
              ),
              tags: profile.tags,
              notes: profile.notes || undefined,
            });
          },
        });

        return tools;
      },
      { names: ["admin_users", "user_context"] }
    );

    // Cleanup on gateway stop
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api.on("gateway_stop", async () => {
      await store.close();
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    api.logger.info(`openember-user-profiles loaded (dataDir=${dataDir})`);
  },
};

export default plugin;
