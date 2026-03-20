/**
 * OpenEmber Memory — ContextEngine implementation (v0.2.9 architecture).
 *
 * Replaces the old `agent_end` hook auto-capture with `afterTurn()`.
 * Key difference from official: multi-user isolation via resolveUserIdFromMessages
 * and createConfiguredClient.
 */

import type { OpenVikingClient, FindResultItem } from "./client.js";
import type { MemoryOpenVikingConfig } from "./config.js";
import type { ProfileStore } from "./user-profiles/store.js";
import { resolveCanonicalUserId } from "./user-profiles/identity-resolve.js";
import {
  getCaptureDecision,
  extractNewTurnTexts,
  pickRecentUniqueTexts,
  CAPTURE_LIMIT,
} from "./text-utils.js";
import {
  trimForLog,
  toJsonLog,
  summarizeExtractedMemories,
} from "./memory-ranking.js";

export type ContextEngineLogger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
};

/**
 * Minimal afterTurn params — matches the OpenClaw v0.2.9 ContextEngine contract.
 */
export type AfterTurnParams = {
  messages: unknown[];
  prePromptMessageCount: number;
  sessionId?: string;
  agentId?: string;
  success?: boolean;
};

/**
 * Minimal compact params.
 */
export type CompactParams = {
  messages: unknown[];
  sessionId?: string;
  agentId?: string;
};

export type ContextEngineInstance = {
  ingest(data: unknown): Promise<void>;
  ingestBatch(items: unknown[]): Promise<void>;
  assemble(context: unknown): Promise<unknown>;
  afterTurn(params: AfterTurnParams): Promise<void>;
  compact(params: CompactParams): Promise<unknown>;
};

export type CreateContextEngineOptions = {
  cfg: Required<MemoryOpenVikingConfig>;
  logger: ContextEngineLogger;
  getClient: () => Promise<OpenVikingClient>;
  resolveAgentId: (sessionId?: string) => string;
  createConfiguredClient: (userId: string | null, agentId: string) => OpenVikingClient;
  resolveUserIdFromMessages: (sessionKey?: string, messages?: unknown[]) => string | null;
  profileStore?: ProfileStore | null;
};

/**
 * Factory: create a ContextEngine with multi-user memory isolation.
 */
export function createOpenEmberContextEngine(
  options: CreateContextEngineOptions,
): ContextEngineInstance {
  const { cfg, logger, getClient, resolveAgentId, createConfiguredClient, resolveUserIdFromMessages, profileStore } = options;

  return {
    /** No-op — OpenViking handles ingestion via sessions. */
    async ingest(_data: unknown): Promise<void> {
      // no-op, consistent with official v0.2.9
    },

    /** No-op — batch ingestion not used. */
    async ingestBatch(_items: unknown[]): Promise<void> {
      // no-op, consistent with official v0.2.9
    },

    /** Pass-through — context assembly handled by before_prompt_build hook. */
    async assemble(context: unknown): Promise<unknown> {
      return context;
    },

    /**
     * afterTurn: auto-capture new conversation messages into OpenViking.
     *
     * Multi-user isolation:
     *  - Resolves userId from raw message metadata (Sender block or sessionKey)
     *  - Creates a user-routed client for capture (X-OpenViking-User header)
     *  - Uses prePromptMessageCount as the starting index for new messages
     */
    async afterTurn(params: AfterTurnParams): Promise<void> {
      if (!cfg.autoCapture) return;

      const { messages, prePromptMessageCount, success } = params;
      // success may be undefined when OpenClaw doesn't pass it — treat undefined as true
      if (success === false || !messages || messages.length === 0) {
        logger.info?.(
          `openember-memory: afterTurn skipped (success=${String(success)}, messages=${messages?.length ?? 0})`,
        );
        return;
      }

      try {
        const hookAgentId = params.agentId
          ? resolveAgentId(params.sessionId)
          : cfg.agentId;

        // Resolve userId from raw messages (unsanitized text has Sender metadata)
        // When profileStore is available, resolve through canonical IDs
        const rawUserId = resolveUserIdFromMessages(params.sessionId, messages);
        const userId = profileStore && rawUserId
          ? (resolveCanonicalUserId(profileStore, params.sessionId) ?? rawUserId)
          : rawUserId;

        logger.info?.(
          `openember-memory: afterTurn userId=${userId ?? "null"} agentId=${hookAgentId} msgCount=${messages.length} prePrompt=${prePromptMessageCount}`,
        );

        // Use prePromptMessageCount as the starting index — no need for lastProcessedMsgCount state
        const effectiveStart = prePromptMessageCount;
        const { texts: newTexts, newCount } = extractNewTurnTexts(messages, effectiveStart);

        if (newTexts.length === 0) {
          logger.info?.("openember-memory: afterTurn skipped (no new user/assistant messages)");
          return;
        }

        // Deduplicate and limit total capture size
        const uniqueTexts = pickRecentUniqueTexts(newTexts, CAPTURE_LIMIT);
        const turnText = uniqueTexts.join("\n");

        const decision = getCaptureDecision(turnText, cfg.captureMode, cfg.captureMaxLength);
        const preview = turnText.length > 80 ? `${turnText.slice(0, 80)}...` : turnText;
        logger.info?.(
          `openember-memory: afterTurn capture-check shouldCapture=${String(decision.shouldCapture)} reason=${decision.reason} userId=${userId ?? "null"} newMsgCount=${newCount} text="${preview}"`,
        );

        if (!decision.shouldCapture) {
          logger.info?.("openember-memory: afterTurn skipped (capture decision rejected)");
          return;
        }

        // Capture to user-specific namespace
        const captureClient = createConfiguredClient(userId, hookAgentId);
        const sessionId = await captureClient.createSession();
        try {
          await captureClient.addSessionMessage(sessionId, "user", decision.normalizedText);
          await captureClient.getSession(sessionId).catch(() => ({}));
          const extracted = await captureClient.extractSessionMemories(sessionId);
          logger.info?.(
            `openember-memory: afterTurn captured ${newCount} new messages, extracted ${extracted.length} memories (userId=${userId ?? "null"})`,
          );
          logger.info?.(
            `openember-memory: afterTurn capture-detail ${toJsonLog({
              capturedCount: newCount,
              userId,
              captured: [trimForLog(turnText, 260)],
              extractedCount: extracted.length,
              extracted: summarizeExtractedMemories(extracted),
            })}`,
          );
          if (extracted.length === 0) {
            logger.warn?.(
              "openember-memory: afterTurn completed but extract returned 0 memories. Check OpenViking server logs.",
            );
          }
        } finally {
          await captureClient.deleteSession(sessionId).catch(() => {});
        }
      } catch (err) {
        logger.warn?.(`openember-memory: afterTurn auto-capture failed: ${String(err)}`);
      }
    },

    /** Compact: delegate to legacy compact engine (no-op for now, consistent with official v0.2.9). */
    async compact(_params: CompactParams): Promise<unknown> {
      return {};
    },
  };
}
