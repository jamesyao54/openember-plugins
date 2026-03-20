/**
 * Memory namespace migration when identities are linked.
 *
 * When a /verify links two canonical IDs, memories stored under the old
 * canonical's namespace need to be moved to the new (target) canonical.
 */

import type { OpenVikingClient } from "../client.js";
import { sanitizeUserId, agentSpaceName } from "../client.js";

export type MigrationLogger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
};

/**
 * Migrate memories from oldCanonicalId namespace to newCanonicalId namespace.
 *
 * For each scope (user + agent), this:
 * 1. Searches for all memories under the old namespace
 * 2. Reads each memory's content
 * 3. Stores it under the new namespace via session create/message/extract
 * 4. Deletes the old entry
 */
export async function migrateMemoryNamespace(
  createClient: (userId: string | null, agentId: string) => OpenVikingClient,
  oldCanonicalId: string,
  newCanonicalId: string,
  agentId: string,
  logger: MigrationLogger,
): Promise<{ migratedCount: number; errors: number }> {
  let migratedCount = 0;
  let errors = 0;

  const oldUserId = sanitizeUserId(oldCanonicalId);
  const newUserId = sanitizeUserId(newCanonicalId);

  // Build search URIs for old namespace
  const oldUserUri = `viking://user/${oldUserId}/memories`;
  const oldAgentUri = `viking://agent/${agentSpaceName(oldCanonicalId, agentId)}/memories`;

  const readClient = createClient(null, agentId);
  const oldClient = createClient(oldCanonicalId, agentId);
  const newClient = createClient(newCanonicalId, agentId);

  for (const [scopeName, oldUri] of [["user", oldUserUri], ["agent", oldAgentUri]] as const) {
    try {
      const result = await oldClient.find("", { targetUri: oldUri, limit: 200, scoreThreshold: 0 });
      const memories = (result.memories ?? []).filter((m) => m.level === 2);

      if (memories.length === 0) {
        logger.info?.(`user-profiles: migration ${scopeName} scope: no memories to migrate for ${oldCanonicalId}`);
        continue;
      }

      logger.info?.(`user-profiles: migration ${scopeName} scope: found ${memories.length} memories to migrate from ${oldCanonicalId} to ${newCanonicalId}`);

      // Re-ingest each memory under the new namespace
      for (const memory of memories) {
        try {
          // Read full content
          let content: string;
          try {
            content = await readClient.read(memory.uri);
          } catch {
            content = memory.abstract ?? memory.overview ?? "";
          }

          if (!content || !content.trim()) {
            continue;
          }

          // Store under new namespace
          const sessionId = await newClient.createSession();
          try {
            await newClient.addSessionMessage(sessionId, "user", content.trim());
            await newClient.extractSessionMemories(sessionId);
          } finally {
            await newClient.deleteSession(sessionId).catch(() => {});
          }

          // Delete old entry
          try {
            await oldClient.deleteUri(memory.uri);
          } catch {
            // Best-effort deletion
            logger.warn?.(`user-profiles: migration could not delete old memory ${memory.uri}`);
          }

          migratedCount++;
        } catch (err) {
          errors++;
          logger.warn?.(`user-profiles: migration failed for ${memory.uri}: ${String(err)}`);
        }
      }
    } catch (err) {
      logger.warn?.(`user-profiles: migration ${scopeName} scope search failed: ${String(err)}`);
      errors++;
    }
  }

  logger.info?.(`user-profiles: migration complete — ${migratedCount} memories migrated, ${errors} errors`);
  return { migratedCount, errors };
}
