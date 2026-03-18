/**
 * OpenViking Memory Plugin for OpenClaw — openember-memory fork
 */
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { OpenVikingClient } from "./client.js";
import { OpenVikingMemoryManager } from "./manager.js";
import { OpenVikingServerManager } from "./server.js";
import { extractUserIdFromSessionKey } from "./session-key.js";
import type { OpenVikingPluginConfig, ServerConfig } from "./types.js";

export { OpenVikingMemoryManager } from "./manager.js";
export { OpenVikingClient } from "./client.js";
export { PathMapper } from "./mapper.js";
export { OpenVikingServerManager } from "./server.js";
export type { OpenVikingPluginConfig } from "./types.js";
export type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
} from "./memory.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
});

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

const MemoryCaptureSchema = Type.Object({
  content: Type.String({ description: "The memory content to store (markdown)" }),
  title: Type.String({ description: "Short title for this memory" }),
});

const configSchema = {
  type: "object",
  additionalProperties: false,
  required: ["baseUrl"],
  properties: {
    baseUrl: { type: "string" },
    apiKey: { type: "string" },
    uriBase: { type: "string" },
    tieredLoading: { type: "boolean" },
    mappings: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    sync: {
      type: "object",
      additionalProperties: false,
      properties: {
        interval: { type: "string" },
        onBoot: { type: "boolean" },
        extraPaths: {
          type: "array",
          items: { type: "string" },
        },
        waitForProcessing: { type: "boolean" },
        waitTimeoutSec: { type: "number", minimum: 0 },
      },
    },
    search: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["find", "search"] },
        defaultLimit: { type: "number", minimum: 1 },
        scoreThreshold: { type: "number", minimum: 0, maximum: 1 },
        targetUri: { type: "string" },
      },
    },
    server: {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "venvPath"],
      properties: {
        enabled: { type: "boolean" },
        venvPath: { type: "string" },
        dataDir: { type: "string" },
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        startupTimeoutMs: { type: "number", minimum: 1000 },
        env: { type: "object", additionalProperties: { type: "string" } },
      },
    },
  },
} as const;

const plugin = {
  id: "openember-memory",
  name: "OpenViking Memory",
  description:
    "OpenViking-backed memory_search/memory_get/memory_capture tools for OpenClaw",
  version: "0.1.0",
  kind: "memory",
  configSchema: {
    jsonSchema: configSchema,
    uiHints: {
      baseUrl: {
        label: "OpenViking Base URL",
        placeholder: "http://127.0.0.1:1933",
        help: "OpenViking HTTP endpoint.",
      },
      apiKey: {
        label: "API Key",
        sensitive: true,
        help: "Optional API key when OpenViking auth is enabled.",
      },
      uriBase: {
        label: "URI Base",
        advanced: true,
        placeholder: "viking://resources/openclaw/{agentId}",
        help: "Resource root URI. Supports the {agentId} placeholder.",
      },
      tieredLoading: {
        label: "Tiered Loading",
        advanced: true,
        help: "When true, memory_get uses overview first (for whole-file reads) and falls back to full read.",
      },
      "sync.interval": {
        label: "Sync Interval",
        advanced: true,
        placeholder: "5m",
        help: "Automatic sync interval. Supported units: s, m, h, d (e.g. 30s, 5m, 1h).",
      },
      "sync.onBoot": {
        label: "Sync On Boot",
        advanced: true,
        help: "Run one sync after plugin startup.",
      },
      "sync.extraPaths": {
        label: "Extra Paths",
        advanced: true,
        help: "Additional files/directories to sync. Paths are workspace-relative; directories are scanned recursively for .md files.",
      },
      "sync.waitForProcessing": {
        label: "Wait For Processing",
        advanced: true,
        help: "Wait until OpenViking processing queues finish after sync.",
      },
      "sync.waitTimeoutSec": {
        label: "Wait Timeout (sec)",
        advanced: true,
        help: "Timeout in seconds for waitForProcessing.",
      },
      "search.mode": {
        label: "Search Mode",
        advanced: true,
        help: "find: stateless retrieval (default). search: session-aware retrieval when session context is available.",
      },
      "search.defaultLimit": {
        label: "Default Limit",
        advanced: true,
        help: "Default max result count if memory_search.maxResults is not provided.",
      },
      "search.scoreThreshold": {
        label: "Score Threshold",
        advanced: true,
        help: "Minimum similarity score in [0, 1].",
      },
      "search.targetUri": {
        label: "Target URI",
        advanced: true,
        help: "Restrict search to a specific URI subtree.",
      },
      "server.enabled": {
        label: "Auto-start OpenViking",
        advanced: true,
        help: "If true, the plugin starts/stops an OpenViking process automatically.",
      },
      "server.venvPath": {
        label: "OpenViking Venv Path",
        advanced: true,
        placeholder: "/path/to/venv",
        help: "Required when server.enabled=true. Points to the Python virtual environment root.",
      },
      "server.dataDir": {
        label: "OpenViking Data Dir",
        advanced: true,
        help: "Optional data directory passed to openviking serve --data-dir.",
      },
      "server.host": {
        label: "OpenViking Host",
        advanced: true,
        help: "Host for auto-started OpenViking server. Defaults to 127.0.0.1.",
      },
      "server.port": {
        label: "OpenViking Port",
        advanced: true,
        help: "Port for auto-started OpenViking server. Defaults to 1933.",
      },
      "server.startupTimeoutMs": {
        label: "Startup Timeout (ms)",
        advanced: true,
        help: "Max wait time for OpenViking health check during startup.",
      },
      "server.env": {
        label: "Server Env",
        advanced: true,
        help: "Extra environment variables for the auto-started OpenViking process.",
      },
    },
  },

  register(api: OpenClawPluginApi): void {
    const cfg = resolveConfig(api.pluginConfig);
    api.logger.info(`openember-memory plugin loaded (baseUrl=${cfg.baseUrl})`);

    const managers = new Map<string, OpenVikingMemoryManager>();
    const bootSyncDone = new Set<string>();
    let serverManager: OpenVikingServerManager | undefined;
    let serverStarted = false;
    let serverStartPromise: Promise<void> | null = null;
    let syncTimer: ReturnType<typeof setInterval> | null = null;

    const ensureServer = async (): Promise<void> => {
      if (!cfg.server?.enabled) {
        return;
      }
      if (serverStarted) {
        return;
      }
      if (serverStartPromise) {
        await serverStartPromise;
        return;
      }
      serverManager = new OpenVikingServerManager({
        config: cfg.server,
        logger: api.logger,
      });
      serverStartPromise = serverManager.start();
      await serverStartPromise;
      serverStarted = true;
    };

    const managerKey = (workspaceDir: string, agentId: string): string =>
      `${workspaceDir}::${agentId}`;

    const getManager = async (ctx: {
      workspaceDir?: string;
      agentId?: string;
      sessionKey?: string;
    }): Promise<OpenVikingMemoryManager> => {
      const workspaceDir = ctx.workspaceDir ?? process.cwd();
      const agentId = ctx.agentId ?? "main";
      const key = managerKey(workspaceDir, agentId);

      await ensureServer();

      let manager = managers.get(key);
      if (!manager) {
        manager = new OpenVikingMemoryManager({
          config: cfg,
          workspaceDir,
          agentId,
          logger: api.logger,
        });
        managers.set(key, manager);
      }

      if (!bootSyncDone.has(key) && cfg.sync?.onBoot !== false) {
        bootSyncDone.add(key);
        manager
          .sync({ reason: "boot" })
          .catch((error: unknown) =>
            api.logger.warn(
              `openviking boot sync failed (${agentId}): ${String(error)}`
            )
          );
      }

      return manager;
    };

    const memorySearchToolFactory = (ctx: {
      workspaceDir?: string;
      agentId?: string;
      sessionKey?: string;
    }) => {
      const memorySearchTool = {
        label: "Memory Search",
        name: "memory_search",
        description:
          "Search memory content in OpenViking before answering questions about prior decisions, people, preferences, tasks, and historical context.",
        parameters: MemorySearchSchema,
        execute: async (
          _toolCallId: string,
          params: unknown
        ) => {
          const payload = (params ?? {}) as Record<string, unknown>;
          const query = readStringParam(payload, "query");
          const maxResults = readOptionalNumber(payload, "maxResults");
          const minScore = readOptionalNumber(payload, "minScore");

          if (!query) {
            return jsonResult({
              results: [],
              disabled: true,
              error: "query required",
            });
          }

          try {
            const manager = await getManager(ctx);
            const userId = extractUserIdFromSessionKey(ctx.sessionKey);

            let results;
            if (userId) {
              // Two searches: user-specific + agent shared, merge and dedup
              const [userResults, sharedResults] = await Promise.all([
                manager.searchWithTargetUri(query, {
                  targetUri: `viking://resources/openember/ember/users/${userId}`,
                  maxResults: 4,
                }),
                manager.searchWithTargetUri(query, {
                  targetUri:
                    "viking://resources/openember/ember/memory-sync",
                  maxResults: 2,
                }),
              ]);

              // Merge, dedup by path, sort by score
              const seen = new Set<string>();
              const merged = [...userResults, ...sharedResults].filter(
                (entry) => {
                  if (seen.has(entry.path)) return false;
                  seen.add(entry.path);
                  return true;
                }
              );
              merged.sort((a, b) => b.score - a.score);
              results = merged;
            } else {
              // Fallback: original search
              results = await manager.search(query, {
                maxResults: maxResults ?? undefined,
                minScore: minScore ?? undefined,
                sessionKey: ctx.sessionKey,
              });
            }

            const status = manager.status();
            return jsonResult({
              results,
              provider: status.provider,
              model: status.model,
            });
          } catch (error) {
            return jsonResult({
              results: [],
              disabled: true,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      };

      const memoryGetTool = {
        label: "Memory Get",
        name: "memory_get",
        description:
          "Read a specific memory file path from OpenViking (optionally by line range) after running memory_search.",
        parameters: MemoryGetSchema,
        execute: async (
          _toolCallId: string,
          params: unknown
        ) => {
          const payload = (params ?? {}) as Record<string, unknown>;
          const relPath = readStringParam(payload, "path");
          const from = readOptionalInteger(payload, "from");
          const lines = readOptionalInteger(payload, "lines");

          if (!relPath) {
            return jsonResult({
              path: "",
              text: "",
              disabled: true,
              error: "path required",
            });
          }

          try {
            // If path is a direct viking:// URI, read it directly via client
            if (relPath.startsWith("viking://")) {
              const client = new OpenVikingClient({
                baseUrl: cfg.baseUrl,
                apiKey: cfg.apiKey,
                timeoutMs: 30000,
              });
              const text = await client.read(relPath);
              const sliced = sliceLines(text, from ?? undefined, lines ?? undefined);
              return jsonResult({ path: relPath, text: sliced });
            }

            const manager = await getManager(ctx);
            const result = await manager.readFile({
              relPath,
              from: from ?? undefined,
              lines: lines ?? undefined,
            });
            return jsonResult(result);
          } catch (error) {
            return jsonResult({
              path: relPath,
              text: "",
              disabled: true,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      };

      const memoryCaptureTool = {
        label: "Memory Capture",
        name: "memory_capture",
        description:
          "Write a memory for the current user into OpenViking. Use this to persist important facts, preferences, or context about the user for future sessions.",
        parameters: MemoryCaptureSchema,
        execute: async (
          _toolCallId: string,
          params: unknown
        ) => {
          const payload = (params ?? {}) as Record<string, unknown>;
          const content = readStringParam(payload, "content");
          const title = readStringParam(payload, "title");

          if (!content) {
            return jsonResult({
              ok: false,
              error: "content required",
            });
          }
          if (!title) {
            return jsonResult({
              ok: false,
              error: "title required",
            });
          }

          const userId = extractUserIdFromSessionKey(ctx.sessionKey);
          if (!userId) {
            return jsonResult({
              ok: false,
              error:
                "Cannot capture memory: no user session context available.",
            });
          }

          try {
            await getManager(ctx); // ensure server is started

            const safeTitle = title
              .replace(/[^\w\s-]/g, "")
              .replace(/\s+/g, "_")
              .slice(0, 60) || "memory";
            const timestamp = Date.now();
            const fileName = `mem_${timestamp}_${safeTitle}.md`;
            const markdownContent = `# ${title}\n\n${content}\n`;

            const client = new OpenVikingClient({
              baseUrl: cfg.baseUrl,
              apiKey: cfg.apiKey,
              timeoutMs: 30000,
            });

            // 1. Upload content to server temp storage
            const { temp_path } = await client.tempUpload(
              markdownContent,
              fileName
            );

            // 2. Import resource directly into user namespace
            //    Using "to" places it at the correct URI so vector index matches
            const targetUri = `viking://resources/openember/ember/users/${userId}/${safeTitle}_${timestamp}`;
            await client.addResource({
              temp_path,
              to: targetUri,
              reason: `Memory capture for user ${userId}: ${title}`,
            });

            return jsonResult({
              ok: true,
              userId,
              title,
            });
          } catch (error) {
            return jsonResult({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      };

      return [memorySearchTool, memoryGetTool, memoryCaptureTool];
    };

    api.registerTool(memorySearchToolFactory, {
      names: ["memory_search", "memory_get", "memory_capture"],
    });

    const intervalMs = parseInterval(cfg.sync?.interval);
    if (intervalMs > 0) {
      syncTimer = setInterval(() => {
        for (const manager of managers.values()) {
          manager.sync?.({ reason: "interval" }).catch((error: unknown) => {
            api.logger.warn(
              `openviking scheduled sync failed: ${String(error)}`
            );
          });
        }
      }, intervalMs);
    }

    api.on("gateway_stop", async () => {
      if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
      }
      await Promise.all(
        [...managers.values()].map(async (manager) => {
          await manager.close?.().catch(() => undefined);
        })
      );
      managers.clear();
      if (serverManager) {
        await serverManager.stop().catch((error: unknown) => {
          api.logger.warn(
            `failed to stop openviking server: ${String(error)}`
          );
        });
      }
    });
  },
};

function resolveConfig(raw: unknown): OpenVikingPluginConfig & {
  sync: NonNullable<OpenVikingPluginConfig["sync"]>;
  search: NonNullable<OpenVikingPluginConfig["search"]>;
} {
  const input = (
    raw && typeof raw === "object" ? raw : {}
  ) as Record<string, unknown>;

  const baseUrl =
    typeof input["baseUrl"] === "string" && input["baseUrl"].trim()
      ? input["baseUrl"].trim()
      : "";
  if (!baseUrl) {
    throw new Error("OpenViking config invalid: baseUrl is required");
  }

  const searchRaw =
    input["search"] && typeof input["search"] === "object"
      ? (input["search"] as Record<string, unknown>)
      : {};
  const syncRaw =
    input["sync"] && typeof input["sync"] === "object"
      ? (input["sync"] as Record<string, unknown>)
      : {};
  const serverRaw =
    input["server"] && typeof input["server"] === "object"
      ? (input["server"] as Record<string, unknown>)
      : undefined;

  return {
    baseUrl,
    apiKey:
      typeof input["apiKey"] === "string" ? input["apiKey"] : undefined,
    uriBase:
      typeof input["uriBase"] === "string" ? input["uriBase"] : undefined,
    tieredLoading:
      typeof input["tieredLoading"] === "boolean"
        ? input["tieredLoading"]
        : true,
    mappings:
      input["mappings"] && typeof input["mappings"] === "object"
        ? (input["mappings"] as Record<string, string>)
        : undefined,
    search: {
      mode: searchRaw["mode"] === "search" ? "search" : "find",
      defaultLimit:
        typeof searchRaw["defaultLimit"] === "number" &&
        Number.isFinite(searchRaw["defaultLimit"])
          ? (searchRaw["defaultLimit"] as number)
          : 6,
      scoreThreshold:
        typeof searchRaw["scoreThreshold"] === "number" &&
        Number.isFinite(searchRaw["scoreThreshold"])
          ? (searchRaw["scoreThreshold"] as number)
          : 0.0,
      targetUri:
        typeof searchRaw["targetUri"] === "string"
          ? searchRaw["targetUri"]
          : undefined,
    },
    sync: {
      interval:
        typeof syncRaw["interval"] === "string"
          ? syncRaw["interval"]
          : undefined,
      onBoot:
        typeof syncRaw["onBoot"] === "boolean" ? syncRaw["onBoot"] : true,
      extraPaths: parseStringArray(syncRaw["extraPaths"]),
      waitForProcessing:
        typeof syncRaw["waitForProcessing"] === "boolean"
          ? syncRaw["waitForProcessing"]
          : false,
      waitTimeoutSec:
        typeof syncRaw["waitTimeoutSec"] === "number" &&
        Number.isFinite(syncRaw["waitTimeoutSec"])
          ? (syncRaw["waitTimeoutSec"] as number)
          : undefined,
    },
    server: resolveServerConfig(serverRaw),
  };
}

function resolveServerConfig(
  serverRaw: Record<string, unknown> | undefined
): ServerConfig | undefined {
  if (!serverRaw || serverRaw["enabled"] !== true) {
    return undefined;
  }
  if (
    typeof serverRaw["venvPath"] !== "string" ||
    !(serverRaw["venvPath"] as string).trim()
  ) {
    throw new Error(
      "OpenViking config invalid: server.venvPath is required when server.enabled=true"
    );
  }
  return {
    enabled: true,
    venvPath: (serverRaw["venvPath"] as string).trim(),
    dataDir:
      typeof serverRaw["dataDir"] === "string"
        ? serverRaw["dataDir"]
        : undefined,
    host:
      typeof serverRaw["host"] === "string" ? serverRaw["host"] : undefined,
    port:
      typeof serverRaw["port"] === "number" &&
      Number.isFinite(serverRaw["port"])
        ? Math.trunc(serverRaw["port"] as number)
        : undefined,
    startupTimeoutMs:
      typeof serverRaw["startupTimeoutMs"] === "number" &&
      Number.isFinite(serverRaw["startupTimeoutMs"])
        ? Math.trunc(serverRaw["startupTimeoutMs"] as number)
        : undefined,
    env: isStringRecord(serverRaw["env"])
      ? (serverRaw["env"] as Record<string, string>)
      : undefined,
  };
}

function isStringRecord(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === "string"
  );
}

function parseInterval(interval: string | undefined): number {
  if (!interval) {
    return 0;
  }
  const match = interval.trim().match(/^(\d+)\s*([smhd])$/i);
  if (!match) {
    return 0;
  }
  const amount = Math.max(0, Number.parseInt(match[1], 10));
  const unit = match[2].toLowerCase();
  const multiplier: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return amount * (multiplier[unit] ?? 0);
}

function parseStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const cleaned = (raw as unknown[])
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  if (cleaned.length === 0) {
    return undefined;
  }
  return [...new Set(cleaned)];
}

function readStringParam(params: Record<string, unknown>, key: string): string {
  const raw = params[key];
  if (typeof raw !== "string") {
    return "";
  }
  return raw.trim();
}

function readOptionalNumber(
  params: Record<string, unknown>,
  key: string
): number | undefined {
  const raw = params[key];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readOptionalInteger(
  params: Record<string, unknown>,
  key: string
): number | undefined {
  const value = readOptionalNumber(params, key);
  if (value === undefined) {
    return undefined;
  }
  return Math.trunc(value);
}

function sliceLines(text: string, from?: number, lines?: number): string {
  if (from === undefined && lines === undefined) return text;
  const allLines = text.split("\n");
  const start = Math.max(0, (from ?? 1) - 1);
  const count = lines ?? allLines.length;
  return allLines.slice(start, start + count).join("\n");
}

function jsonResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

export default plugin;
