/**
 * Cross-channel identity binding flow.
 *
 * User initiates /bind from one channel → gets a 6-char token →
 * enters /verify <token> from another channel → identities are linked.
 */

import { randomBytes } from "node:crypto";
import type { PendingBind, BindResult, ExternalIdentity } from "./types.js";
import type { ProfileStore } from "./store.js";

const TOKEN_LENGTH = 6;
const CLEANUP_INTERVAL_MS = 60_000;

export class BindFlowManager {
  private readonly pending = new Map<string, PendingBind>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: ProfileStore,
    private readonly tokenTtlMs: number,
  ) {
    // Lazy cleanup of expired tokens
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL_MS);
    // Ensure timer doesn't prevent process exit
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Create a bind token for the given identity.
   * Returns the 6-character alphanumeric token.
   */
  createBind(provider: string, externalId: string, canonicalId: string): string {
    const token = randomBytes(3)
      .toString("hex")
      .toUpperCase()
      .slice(0, TOKEN_LENGTH);

    this.pending.set(token, {
      provider,
      externalId,
      canonicalId,
      expiresAt: Date.now() + this.tokenTtlMs,
    });

    return token;
  }

  /**
   * Verify a bind token from a different channel.
   * Links the verifier's identity to the original identity's canonical user.
   */
  verifyBind(
    token: string,
    verifier: ExternalIdentity,
  ): BindResult {
    const normalizedToken = token.trim().toUpperCase();
    const bind = this.pending.get(normalizedToken);

    if (!bind) {
      return { ok: false, reason: "invalid_or_expired_token" };
    }

    if (Date.now() > bind.expiresAt) {
      this.pending.delete(normalizedToken);
      return { ok: false, reason: "token_expired" };
    }

    // Cannot bind to the same identity
    if (bind.provider === verifier.provider && bind.externalId === verifier.externalId) {
      return { ok: false, reason: "same_identity" };
    }

    // Clean up the used token
    this.pending.delete(normalizedToken);

    // Check if verifier already has a canonical ID
    const verifierCanonical = this.store.resolveCanonicalId(verifier.provider, verifier.externalId);

    if (verifierCanonical && verifierCanonical !== bind.canonicalId) {
      // Verifier has a different canonical — need to merge
      this.store.mergeUsers(bind.canonicalId, verifierCanonical);
      return {
        ok: true,
        merged: true,
        canonicalId: bind.canonicalId,
        message: `Identities linked and profiles merged. Canonical: ${bind.canonicalId}`,
      };
    }

    // Verifier has no canonical or same canonical — just link
    this.store.linkIdentity(bind.canonicalId, verifier.provider, verifier.externalId);
    return {
      ok: true,
      merged: false,
      canonicalId: bind.canonicalId,
      message: `Identity ${verifier.provider}:${verifier.externalId} linked to ${bind.canonicalId}.`,
    };
  }

  /** Get pending bind count (for diagnostics). */
  get pendingCount(): number {
    return this.pending.size;
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.pending.clear();
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [token, bind] of this.pending) {
      if (now > bind.expiresAt) {
        this.pending.delete(token);
      }
    }
  }
}
