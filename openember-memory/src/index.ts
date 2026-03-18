import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { memoryOpenVikingConfigSchema } from "./config.js";

import { OpenVikingClient, localClientCache, localClientPendingPromises, isMemoryUri } from "./client.js";
import type { PendingClientEntry, FindResultItem } from "./client.js";
import {
  getCaptureDecision,
  isTranscriptLikeIngest,
  extractNewTurnTexts,
  extractLatestUserText,
} from "./text-utils.js";
import {
  clampScore,
  postProcessMemories,
  formatMemoryLines,
  trimForLog,
  toJsonLog,
  summarizeInjectionMemories,
  summarizeExtractedMemories,
  pickMemoriesForInjection,
} from "./memory-ranking.js";
import {
  IS_WIN,
  waitForHealth,
  withTimeout,
  quickRecallPrecheck,
  resolvePythonCommand,
  prepareLocalPort,
} from "./process-manager.js";
import { resolveUserId, resolveUserIdFromMessages } from "./user-resolve.js";

type ToolContext = {
  agentId?: string;
  sessionKey?: string;
  requesterSenderId?: string;
};

const MAX_OPENVIKING_STDERR_LINES = 200;
const MAX_OPENVIKING_STDERR_CHARS = 256_000;
const AUTO_RECALL_TIMEOUT_MS = 5_000;

const memoryPlugin = {
  id: "openember-memory",
  name: "Memory (OpenEmber)",
  description: "OpenViking-backed long-term memory with auto-recall/capture and multi-user isolation",
  kind: "memory" as const,
  configSchema: memoryOpenVikingConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = memoryOpenVikingConfigSchema.parse(api.pluginConfig);
    const localCacheKey = `${cfg.mode}:${cfg.baseUrl}:${cfg.configPath}:${cfg.apiKey}`;

    let clientPromise: Promise<OpenVikingClient>;
    let localProcess: ReturnType<typeof spawn> | null = null;
    let resolveLocalClient: ((c: OpenVikingClient) => void) | null = null;
    let rejectLocalClient: ((err: unknown) => void) | null = null;
    let localUnavailableReason: string | null = null;

    const markLocalUnavailable = (reason: string, err?: unknown) => {
      if (!localUnavailableReason) {
        localUnavailableReason = reason;
        api.logger.warn(
          `openember-memory: local mode marked unavailable (${reason})${err ? `: ${String(err)}` : ""}`,
        );
      }
      if (rejectLocalClient) {
        rejectLocalClient(
          err instanceof Error ? err : new Error(`openember-memory unavailable: ${reason}`),
        );
        rejectLocalClient = null;
      }
      resolveLocalClient = null;
    };

    if (cfg.mode === "local") {
      const cached = localClientCache.get(localCacheKey);
      if (cached) {
        localProcess = cached.process;
        clientPromise = Promise.resolve(cached.client);
      } else {
        const existingPending = localClientPendingPromises.get(localCacheKey);
        if (existingPending) {
          clientPromise = existingPending.promise;
        } else {
          const entry = {} as PendingClientEntry;
          entry.promise = new Promise<OpenVikingClient>((resolve, reject) => {
            entry.resolve = resolve;
            entry.reject = reject;
          });
          clientPromise = entry.promise;
          localClientPendingPromises.set(localCacheKey, entry);
        }
      }
    } else {
      clientPromise = Promise.resolve(new OpenVikingClient(cfg.baseUrl, cfg.apiKey, cfg.agentId, cfg.timeoutMs));
    }

    const getClient = (): Promise<OpenVikingClient> => clientPromise;

    /** Create a fresh client with the given userId + agentId pre-configured. */
    const createConfiguredClient = (userId: string | null, agentId: string): OpenVikingClient => {
      const c = new OpenVikingClient(cfg.baseUrl, cfg.apiKey, agentId, cfg.timeoutMs);
      c.setUserId(userId);
      return c;
    };

    /**
     * Parallel multi-scope search.
     *
     * With userId: 2-way parallel search via X-OpenViking-User header:
     *   1. viking://user/memories (routed to user's space by normalizeTargetUri)
     *   2. viking://agent/memories (agent shared, no user header)
     *
     * Without userId: agent shared only.
     */
    const multiScopeSearch = async (
      queryText: string,
      userId: string | null,
      agentId: string,
      candidateLimit: number,
    ): Promise<FindResultItem[]> => {
      const findOpts = { limit: candidateLimit, scoreThreshold: 0 };

      if (userId) {
        const userClient = createConfiguredClient(userId, agentId);
        const sharedClient = createConfiguredClient(null, agentId);

        const [userSettled, sharedSettled] = await Promise.allSettled([
          // User-specific memories (X-OpenViking-User + normalizeTargetUri adds peerId)
          userClient.find(queryText, { targetUri: "viking://user/memories", ...findOpts }),
          // Agent shared memories (no user header)
          sharedClient.find(queryText, { targetUri: "viking://agent/memories", ...findOpts }),
        ]);

        const userResult = userSettled.status === "fulfilled" ? userSettled.value : { memories: [] };
        const sharedResult = sharedSettled.status === "fulfilled" ? sharedSettled.value : { memories: [] };

        if (userSettled.status === "rejected") {
          api.logger.warn(`openember-memory: user memories search failed: ${String(userSettled.reason)}`);
        }
        if (sharedSettled.status === "rejected") {
          api.logger.warn(`openember-memory: agent shared memories search failed: ${String(sharedSettled.reason)}`);
        }

        const allMemories = [...(userResult.memories ?? []), ...(sharedResult.memories ?? [])];
        const uniqueMemories = allMemories.filter((memory, index, self) =>
          index === self.findIndex((m) => m.uri === memory.uri)
        );
        return uniqueMemories.filter((m) => m.level === 2);
      } else {
        const client = createConfiguredClient(null, agentId);
        const result = await client.find(queryText, {
          targetUri: "viking://agent/memories",
          ...findOpts,
        });
        return (result.memories ?? []).filter((m) => m.level === 2);
      }
    };

    // ─── Tools (registered as factory for per-request user context) ───

    const toolFactory = (ctx: ToolContext) => {
      const userId = ctx.requesterSenderId ?? resolveUserId(ctx.sessionKey);
      const agentId = ctx.agentId ?? cfg.agentId;

      const memoryRecallTool = {
        name: "memory_recall",
        label: "Memory Recall (OpenEmber)",
        description:
          "Search long-term memories from OpenViking. Use when you need past user preferences, facts, or decisions.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(
            Type.Number({ description: "Max results (default: plugin config)" }),
          ),
          scoreThreshold: Type.Optional(
            Type.Number({ description: "Minimum score (0-1, default: plugin config)" }),
          ),
          targetUri: Type.Optional(
            Type.String({ description: "Search scope URI (default: auto by user context)" }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const { query } = params as { query: string };
          const limit =
            typeof (params as { limit?: number }).limit === "number"
              ? Math.max(1, Math.floor((params as { limit: number }).limit))
              : cfg.recallLimit;
          const scoreThreshold =
            typeof (params as { scoreThreshold?: number }).scoreThreshold === "number"
              ? Math.max(0, Math.min(1, (params as { scoreThreshold: number }).scoreThreshold))
              : cfg.recallScoreThreshold;
          const targetUri =
            typeof (params as { targetUri?: string }).targetUri === "string"
              ? (params as { targetUri: string }).targetUri
              : undefined;
          const requestLimit = Math.max(limit * 4, 20);

          api.logger.info?.(`openember-memory: memory_recall userId=${userId ?? "null"} agentId=${agentId}`);

          let leafMemories: FindResultItem[];
          if (targetUri) {
            // Explicit target URI — search directly with user context
            const client = createConfiguredClient(userId, agentId);
            const result = await client.find(query, {
              targetUri,
              limit: requestLimit,
              scoreThreshold: 0,
            });
            leafMemories = (result.memories ?? []).filter((m) => m.level === 2);
          } else {
            leafMemories = await multiScopeSearch(query, userId, agentId, requestLimit);
          }

          const memories = postProcessMemories(leafMemories, { limit, scoreThreshold });
          if (memories.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No relevant OpenViking memories found." }],
              details: { count: 0, total: leafMemories.length, scoreThreshold },
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${memories.length} memories:\n\n${formatMemoryLines(memories)}`,
              },
            ],
            details: {
              count: memories.length,
              memories,
              total: leafMemories.length,
              scoreThreshold,
              requestLimit,
            },
          };
        },
      };

      const memoryStoreTool = {
        name: "memory_store",
        label: "Memory Store (OpenEmber)",
        description:
          "Store text in OpenViking memory pipeline by writing to a session and running memory extraction.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to store as memory source text" }),
          role: Type.Optional(Type.String({ description: "Session role, default user" })),
          sessionId: Type.Optional(Type.String({ description: "Existing OpenViking session ID" })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const { text } = params as { text: string };
          const role =
            typeof (params as { role?: string }).role === "string"
              ? (params as { role: string }).role
              : "user";
          const sessionIdIn = (params as { sessionId?: string }).sessionId;

          // Store to user-specific namespace when userId is available
          const client = createConfiguredClient(userId, agentId);

          api.logger.info?.(
            `openember-memory: memory_store invoked (userId=${userId ?? "null"}, textLength=${text?.length ?? 0}, sessionId=${sessionIdIn ?? "temp"})`,
          );

          let sessionId = sessionIdIn;
          let createdTempSession = false;
          try {
            if (!sessionId) {
              sessionId = await client.createSession();
              createdTempSession = true;
            }
            await client.addSessionMessage(sessionId, role, text);
            const extracted = await client.extractSessionMemories(sessionId);
            if (extracted.length === 0) {
              api.logger.warn(
                `openember-memory: memory_store completed but extract returned 0 memories (sessionId=${sessionId}).`,
              );
            } else {
              api.logger.info?.(`openember-memory: memory_store extracted ${extracted.length} memories`);
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Stored in OpenViking session ${sessionId} and extracted ${extracted.length} memories.`,
                },
              ],
              details: { action: "stored", sessionId, extractedCount: extracted.length, extracted, userId },
            };
          } catch (err) {
            api.logger.warn(`openember-memory: memory_store failed: ${String(err)}`);
            throw err;
          } finally {
            if (createdTempSession && sessionId) {
              await client.deleteSession(sessionId).catch(() => {});
            }
          }
        },
      };

      const memoryForgetTool = {
        name: "memory_forget",
        label: "Memory Forget (OpenEmber)",
        description:
          "Forget memory by URI, or search then delete when a strong single match is found.",
        parameters: Type.Object({
          uri: Type.Optional(Type.String({ description: "Exact memory URI to delete" })),
          query: Type.Optional(Type.String({ description: "Search query to find memory URI" })),
          targetUri: Type.Optional(
            Type.String({ description: "Search scope URI (default: plugin config)" }),
          ),
          limit: Type.Optional(Type.Number({ description: "Search limit (default: 5)" })),
          scoreThreshold: Type.Optional(
            Type.Number({ description: "Minimum score (0-1, default: plugin config)" }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const uri = (params as { uri?: string }).uri;
          const client = createConfiguredClient(userId, agentId);

          if (uri) {
            if (!isMemoryUri(uri)) {
              return {
                content: [{ type: "text" as const, text: `Refusing to delete non-memory URI: ${uri}` }],
                details: { action: "rejected", uri },
              };
            }
            await client.deleteUri(uri);
            return {
              content: [{ type: "text" as const, text: `Forgotten: ${uri}` }],
              details: { action: "deleted", uri },
            };
          }

          const query = (params as { query?: string }).query;
          if (!query) {
            return {
              content: [{ type: "text" as const, text: "Provide uri or query." }],
              details: { error: "missing_param" },
            };
          }

          const limit =
            typeof (params as { limit?: number }).limit === "number"
              ? Math.max(1, Math.floor((params as { limit: number }).limit))
              : 5;
          const scoreThreshold =
            typeof (params as { scoreThreshold?: number }).scoreThreshold === "number"
              ? Math.max(0, Math.min(1, (params as { scoreThreshold: number }).scoreThreshold))
              : cfg.recallScoreThreshold;
          const targetUri =
            typeof (params as { targetUri?: string }).targetUri === "string"
              ? (params as { targetUri: string }).targetUri
              : cfg.targetUri;
          const requestLimit = Math.max(limit * 4, 20);

          const result = await client.find(query, {
            targetUri,
            limit: requestLimit,
            scoreThreshold: 0,
          });
          const candidates = postProcessMemories(result.memories ?? [], {
            limit: requestLimit,
            scoreThreshold,
            leafOnly: true,
          }).filter((item) => isMemoryUri(item.uri));
          if (candidates.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "No matching leaf memory candidates found. Try a more specific query.",
                },
              ],
              details: { action: "none", scoreThreshold },
            };
          }
          const top = candidates[0];
          if (candidates.length === 1 && clampScore(top.score) >= 0.85) {
            await client.deleteUri(top.uri);
            return {
              content: [{ type: "text" as const, text: `Forgotten: ${top.uri}` }],
              details: { action: "deleted", uri: top.uri, score: top.score ?? 0 },
            };
          }

          const list = candidates
            .map((item) => `- ${item.uri} (${(clampScore(item.score) * 100).toFixed(0)}%)`)
            .join("\n");

          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${candidates.length} candidates. Specify uri:\n${list}`,
              },
            ],
            details: { action: "candidates", candidates, scoreThreshold, requestLimit },
          };
        },
      };

      return [memoryRecallTool, memoryStoreTool, memoryForgetTool];
    };

    api.registerTool(toolFactory, {
      names: ["memory_recall", "memory_store", "memory_forget"],
    });

    // ─── Auto-Recall (before_agent_start hook) ───
    if (cfg.autoRecall || cfg.ingestReplyAssist) {
      api.on("before_agent_start", async (event, ctx) => {
        const hookAgentId = ctx?.agentId ?? cfg.agentId;
        const userId = resolveUserId(ctx?.sessionKey, event.prompt);

        api.logger.info?.(`openember-memory: before_agent_start userId=${userId ?? "null"} agentId=${hookAgentId}`);

        const queryText = extractLatestUserText(event.messages) || event.prompt.trim();
        if (!queryText) {
          return;
        }
        const prependContextParts: string[] = [];

        if (cfg.autoRecall && queryText.length >= 5) {
          // For remote mode, skip precheck (500ms health check is too tight for remote servers).
          // For local mode, do precheck to avoid waiting on a dead local process.
          const precheck = cfg.mode === "remote"
            ? { ok: true as const }
            : await quickRecallPrecheck(cfg.mode, cfg.baseUrl, cfg.port, localProcess);
          if (!precheck.ok) {
            api.logger.info?.(
              `openember-memory: skipping auto-recall because precheck failed (${precheck.reason})`,
            );
          } else {
            try {
              await withTimeout(
                (async () => {
                  const candidateLimit = Math.max(cfg.recallLimit * 4, 20);
                  api.logger.info?.(`openember-memory: autoRecall searching (userId=${userId ?? "null"}, query="${queryText.slice(0, 80)}", limit=${candidateLimit})`);

                  const leafMemories = await multiScopeSearch(queryText, userId, hookAgentId, candidateLimit);

                  api.logger.info?.(`openember-memory: autoRecall found ${leafMemories.length} leaf memories`);

                  const processed = postProcessMemories(leafMemories, {
                    limit: candidateLimit,
                    scoreThreshold: cfg.recallScoreThreshold,
                  });
                  const memories = pickMemoriesForInjection(processed, cfg.recallLimit, queryText);
                  if (memories.length > 0) {
                    const readClient = createConfiguredClient(null, hookAgentId);
                    const memoryLines = await Promise.all(
                      memories.map(async (item: FindResultItem) => {
                        if (item.level === 2) {
                          try {
                            const content = await readClient.read(item.uri);
                            if (content && typeof content === "string" && content.trim()) {
                              return `- [${item.category ?? "memory"}] ${content.trim()}`;
                            }
                          } catch {
                            // fallback to abstract
                          }
                        }
                        return `- [${item.category ?? "memory"}] ${item.abstract ?? item.uri}`;
                      }),
                    );
                    const memoryContext = memoryLines.join("\n");
                    api.logger.info?.(
                      `openember-memory: injecting ${memories.length} memories into context (userId=${userId ?? "null"})`,
                    );
                    api.logger.info?.(
                      `openember-memory: inject-detail ${toJsonLog({ count: memories.length, userId, memories: summarizeInjectionMemories(memories) })}`,
                    );
                    prependContextParts.push(
                      "<relevant-memories>\nThe following OpenViking memories may be relevant:\n" +
                        `${memoryContext}\n` +
                      "</relevant-memories>",
                    );
                  }
                })(),
                AUTO_RECALL_TIMEOUT_MS,
                `openember-memory: auto-recall timed out after ${AUTO_RECALL_TIMEOUT_MS}ms`,
              );
            } catch (err) {
              api.logger.warn(`openember-memory: auto-recall failed or timed out: ${String(err)}`);
            }
          }
        }

        if (cfg.ingestReplyAssist) {
          const decision = isTranscriptLikeIngest(queryText, {
            minSpeakerTurns: cfg.ingestReplyAssistMinSpeakerTurns,
            minChars: cfg.ingestReplyAssistMinChars,
          });
          if (decision.shouldAssist) {
            api.logger.info?.(
              `openember-memory: ingest-reply-assist applied (reason=${decision.reason}, speakerTurns=${decision.speakerTurns}, chars=${decision.chars})`,
            );
            prependContextParts.push(
              "<ingest-reply-assist>\n" +
                "The latest user input looks like a multi-speaker transcript used for memory ingestion.\n" +
                "Reply with 1-2 concise sentences to acknowledge or summarize key points.\n" +
                "Do not output NO_REPLY or an empty reply.\n" +
                "Do not fabricate facts beyond the provided transcript and recalled memories.\n" +
                "</ingest-reply-assist>",
            );
          }
        }

        if (prependContextParts.length > 0) {
          return {
            prependContext: prependContextParts.join("\n\n"),
          };
        }
      });
    }

    // ─── Auto-Capture (agent_end hook) ───
    if (cfg.autoCapture) {
      let lastProcessedMsgCount = 0;

      api.on("agent_end", async (event, ctx) => {
        const hookAgentId = ctx?.agentId ?? cfg.agentId;
        // Resolve userId: sessionKey → raw message metadata (unsanitized)
        const userId = resolveUserIdFromMessages(ctx?.sessionKey, event.messages);

        api.logger.info?.(`openember-memory: agent_end userId=${userId ?? "null"} agentId=${hookAgentId}`);

        if (!event.success || !event.messages || event.messages.length === 0) {
          api.logger.info(
            `openember-memory: auto-capture skipped (success=${String(event.success)}, messages=${event.messages?.length ?? 0})`,
          );
          return;
        }
        try {
          const messages = event.messages;
          // On first run after restart, only capture the last few messages (not entire history)
          const effectiveStart = lastProcessedMsgCount === 0 && messages.length > 4
            ? messages.length - 4
            : lastProcessedMsgCount;
          const { texts: newTexts, newCount } = extractNewTurnTexts(messages, effectiveStart);
          lastProcessedMsgCount = messages.length;

          if (newTexts.length === 0) {
            api.logger.info("openember-memory: auto-capture skipped (no new user/assistant messages)");
            return;
          }

          const turnText = newTexts.join("\n");

          const decision = getCaptureDecision(turnText, cfg.captureMode, cfg.captureMaxLength);
          const preview = turnText.length > 80 ? `${turnText.slice(0, 80)}...` : turnText;
          api.logger.info(
            `openember-memory: capture-check shouldCapture=${String(decision.shouldCapture)} reason=${decision.reason} userId=${userId ?? "null"} newMsgCount=${newCount} text="${preview}"`,
          );
          if (!decision.shouldCapture) {
            api.logger.info("openember-memory: auto-capture skipped (capture decision rejected)");
            return;
          }

          // Capture to user-specific namespace when userId is available
          const captureClient = createConfiguredClient(userId, hookAgentId);
          const sessionId = await captureClient.createSession();
          try {
            await captureClient.addSessionMessage(sessionId, "user", decision.normalizedText);
            await captureClient.getSession(sessionId).catch(() => ({}));
            const extracted = await captureClient.extractSessionMemories(sessionId);
            api.logger.info(
              `openember-memory: auto-captured ${newCount} new messages, extracted ${extracted.length} memories (userId=${userId ?? "null"})`,
            );
            api.logger.info(
              `openember-memory: capture-detail ${toJsonLog({
                capturedCount: newCount,
                userId,
                captured: [trimForLog(turnText, 260)],
                extractedCount: extracted.length,
                extracted: summarizeExtractedMemories(extracted),
              })}`,
            );
            if (extracted.length === 0) {
              api.logger.warn(
                "openember-memory: auto-capture completed but extract returned 0 memories. Check OpenViking server logs.",
              );
            }
          } finally {
            await captureClient.deleteSession(sessionId).catch(() => {});
          }
        } catch (err) {
          api.logger.warn(`openember-memory: auto-capture failed: ${String(err)}`);
        }
      });
    }

    // ─── Service lifecycle ───
    api.registerService({
      id: "openember-memory",
      start: async () => {
        const pendingEntry = localClientPendingPromises.get(localCacheKey);
        const isSpawner = cfg.mode === "local" && !!pendingEntry;
        if (isSpawner) {
          localClientPendingPromises.delete(localCacheKey);
          resolveLocalClient = pendingEntry!.resolve;
          rejectLocalClient = pendingEntry!.reject;
        }
        if (isSpawner) {
          const timeoutMs = 60_000;
          const intervalMs = 500;

          const actualPort = await prepareLocalPort(cfg.port, api.logger);
          const baseUrl = `http://127.0.0.1:${actualPort}`;

          const pythonCmd = resolvePythonCommand(api.logger);

          const pathSep = IS_WIN ? ";" : ":";
          const env = {
            ...process.env,
            PYTHONUNBUFFERED: "1",
            PYTHONWARNINGS: "ignore::RuntimeWarning",
            OPENVIKING_CONFIG_FILE: cfg.configPath,
            OPENVIKING_START_CONFIG: cfg.configPath,
            OPENVIKING_START_HOST: "127.0.0.1",
            OPENVIKING_START_PORT: String(actualPort),
            ...(process.env.OPENVIKING_GO_PATH && { PATH: `${process.env.OPENVIKING_GO_PATH}${pathSep}${process.env.PATH || ""}` }),
            ...(process.env.OPENVIKING_GOPATH && { GOPATH: process.env.OPENVIKING_GOPATH }),
            ...(process.env.OPENVIKING_GOPROXY && { GOPROXY: process.env.OPENVIKING_GOPROXY }),
          };
          const runpyCode = `import sys,os,warnings; warnings.filterwarnings('ignore', category=RuntimeWarning, message='.*sys.modules.*'); sys.argv=['openviking.server.bootstrap','--config',os.environ['OPENVIKING_START_CONFIG'],'--host',os.environ.get('OPENVIKING_START_HOST','127.0.0.1'),'--port',os.environ['OPENVIKING_START_PORT']]; import runpy, importlib.util; spec=importlib.util.find_spec('openviking.server.bootstrap'); (runpy.run_path(spec.origin, run_name='__main__') if spec and getattr(spec,'origin',None) else runpy.run_module('openviking.server.bootstrap', run_name='__main__', alter_sys=True))`;
          const child = spawn(
            pythonCmd,
            ["-c", runpyCode],
            { env, cwd: IS_WIN ? tmpdir() : "/tmp", stdio: ["ignore", "pipe", "pipe"] },
          );
          localProcess = child;
          const stderrChunks: string[] = [];
          let stderrCharCount = 0;
          let stderrDroppedChunks = 0;
          const pushStderrChunk = (chunk: string) => {
            if (!chunk) return;
            stderrChunks.push(chunk);
            stderrCharCount += chunk.length;
            while (
              stderrChunks.length > MAX_OPENVIKING_STDERR_LINES ||
              stderrCharCount > MAX_OPENVIKING_STDERR_CHARS
            ) {
              const dropped = stderrChunks.shift();
              if (!dropped) break;
              stderrCharCount -= dropped.length;
              stderrDroppedChunks += 1;
            }
          };
          const formatStderrOutput = () => {
            if (!stderrChunks.length && !stderrDroppedChunks) return "";
            const truncated =
              stderrDroppedChunks > 0
                ? `[truncated ${stderrDroppedChunks} earlier stderr chunk(s)]\n`
                : "";
            return `\n[openviking stderr]\n${truncated}${stderrChunks.join("\n")}`;
          };
          child.on("error", (err: Error) => api.logger.warn(`openember-memory: local server error: ${String(err)}`));
          child.stderr?.on("data", (chunk: Buffer) => {
            const s = String(chunk).trim();
            pushStderrChunk(s);
            api.logger.debug?.(`[openviking] ${s}`);
          });
          child.on("exit", (code: number | null, signal: string | null) => {
            if (localProcess === child) {
              localProcess = null;
              localClientCache.delete(localCacheKey);
            }
            if (code != null && code !== 0 || signal) {
              const out = formatStderrOutput();
              api.logger.warn(`openember-memory: subprocess exited (code=${code}, signal=${signal})${out}`);
            }
          });
          try {
            await waitForHealth(baseUrl, timeoutMs, intervalMs);
            const client = new OpenVikingClient(baseUrl, cfg.apiKey, cfg.agentId, cfg.timeoutMs);
            localClientCache.set(localCacheKey, { client, process: child });
            resolveLocalClient!(client);
            rejectLocalClient = null;
            localClientPendingPromises.delete(localCacheKey);
            api.logger.info(
              `openember-memory: local server started (${baseUrl}, config: ${cfg.configPath})`,
            );
          } catch (err) {
            localProcess = null;
            child.kill("SIGTERM");
            localClientPendingPromises.delete(localCacheKey);
            markLocalUnavailable("startup failed", err);
            if (stderrChunks.length) {
              api.logger.warn(
                `openember-memory: startup failed (health check timeout or error).${formatStderrOutput()}`,
              );
            }
            throw err;
          }
        } else {
          const client = await getClient();
          await client.healthCheck().catch(() => {});
          api.logger.info(
            `openember-memory: initialized (url: ${cfg.baseUrl}, targetUri: ${cfg.targetUri})`,
          );
        }
      },
      stop: () => {
        localClientPendingPromises.delete(localCacheKey);
        if (localProcess) {
          localProcess.kill("SIGTERM");
          localClientCache.delete(localCacheKey);
          localProcess = null;
          api.logger.info("openember-memory: local server stopped");
        } else {
          api.logger.info("openember-memory: stopped");
        }
      },
    });
  },
};

export default memoryPlugin;
