/**
 * Extract userId from OpenClaw session key.
 * Format: "agent:ember:direct:alice" → "alice"
 */
export function extractUserIdFromSessionKey(sessionKey?: string): string | null {
  if (!sessionKey) return null;
  const match = sessionKey.match(/^agent:[^:]+:direct:(.+)$/);
  return match ? match[1] : null;
}
