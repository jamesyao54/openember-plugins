/**
 * Multi-user isolation: resolve userId from OpenClaw session context.
 *
 * Three-level fallback:
 * 1. Private chat: extract peerId from sessionKey ("agent:ember:direct:alice" → "alice")
 * 2. Group chat: extract Sender from prompt metadata block
 * 3. Fallback: return null → only agent shared memories
 */

const SESSION_KEY_DIRECT_RE = /^agent:[^:]+:direct:(.+)$/;
const SENDER_METADATA_RE = /Sender\s*\(untrusted metadata\)\s*:\s*```json\s*([\s\S]*?)```/i;
const CONVERSATION_METADATA_RE = /Conversation info\s*\(untrusted metadata\)\s*:\s*```json\s*([\s\S]*?)```/i;

/**
 * Extract peerId from OpenClaw sessionKey (private chat).
 * Format: "agent:ember:direct:alice" → "alice"
 */
export function extractPeerIdFromSessionKey(sessionKey?: string): string | null {
  if (!sessionKey) return null;
  const match = sessionKey.match(SESSION_KEY_DIRECT_RE);
  return match?.[1] ?? null;
}

/**
 * Try to extract a sender/user id from a parsed metadata JSON object.
 */
function extractIdFromMeta(meta: Record<string, unknown>): string | null {
  const userId = meta.userId ?? meta.senderId ?? meta.sender_id ?? meta.sender ?? meta.user_id ?? meta.id;
  if (typeof userId === "string" && userId.trim()) {
    return userId.trim();
  }
  return null;
}

/**
 * Extract sender userId from prompt text (group chat).
 * Supports two metadata block formats:
 * 1. "Sender (untrusted metadata): ```json { ... } ```"
 * 2. "Conversation info (untrusted metadata): ```json { "sender_id": "..." } ```"
 */
export function extractSenderFromPrompt(prompt: string): string | null {
  if (!prompt) return null;

  // Try Sender block first (more specific)
  const senderMatch = prompt.match(SENDER_METADATA_RE);
  if (senderMatch?.[1]) {
    try {
      const result = extractIdFromMeta(JSON.parse(senderMatch[1]));
      if (result) return result;
    } catch { /* not valid JSON */ }
  }

  // Try Conversation info block (contains sender_id in group chat)
  const convMatch = prompt.match(CONVERSATION_METADATA_RE);
  if (convMatch?.[1]) {
    try {
      const result = extractIdFromMeta(JSON.parse(convMatch[1]));
      if (result) return result;
    } catch { /* not valid JSON */ }
  }

  return null;
}

/**
 * Combined strategy: sessionKey → prompt metadata → null
 */
export function resolveUserId(sessionKey?: string, prompt?: string): string | null {
  const fromSession = extractPeerIdFromSessionKey(sessionKey);
  if (fromSession) return fromSession;

  if (prompt) {
    const fromPrompt = extractSenderFromPrompt(prompt);
    if (fromPrompt) return fromPrompt;
  }

  return null;
}

/**
 * Extract userId from raw message objects (without sanitization).
 * Useful in agent_end where sanitized text has metadata stripped.
 */
export function resolveUserIdFromMessages(sessionKey?: string, messages?: unknown[]): string | null {
  const fromSession = extractPeerIdFromSessionKey(sessionKey);
  if (fromSession) return fromSession;

  if (!messages || messages.length === 0) return null;

  // Walk messages in reverse to find the latest user message with metadata
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown> | undefined;
    if (!msg || msg.role !== "user") continue;
    const content = msg.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as Record<string, unknown> | undefined;
        if (b?.type === "text" && typeof b.text === "string") {
          text = b.text as string;
          break;
        }
      }
    }
    if (text) {
      const result = extractSenderFromPrompt(text);
      if (result) return result;
    }
  }

  return null;
}
