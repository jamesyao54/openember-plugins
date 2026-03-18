/**
 * Extract userId from OpenClaw session key.
 * Format: "agent:ember:direct:alice" -> "alice"
 * Returns null if the format doesn't match per-peer direct sessions.
 */
export function extractUserIdFromSessionKey(sessionKey?: string): string | null {
  if (!sessionKey) return null;
  const match = sessionKey.match(/^agent:[^:]+:direct:(.+)$/);
  return match ? match[1] : null;
}
