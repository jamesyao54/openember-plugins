/**
 * ProfileStore — JSON file-backed store for identity-map.json and profiles.json.
 *
 * Uses mtime-based hot-reload cache and atomic writes (write-temp → rename).
 */

import { readFileSync, writeFileSync, statSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  IdentityMap,
  ProfilesMap,
  UserProfile,
  LinkedIdentity,
} from "./types.js";

export type ProfileStoreLogger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
};

export class ProfileStore {
  private readonly identityMapPath: string;
  private readonly profilesPath: string;

  private identityMapCache: IdentityMap = {};
  private identityMapMtime = 0;

  private profilesCache: ProfilesMap = {};
  private profilesMtime = 0;

  constructor(
    private readonly dataDir: string,
    private readonly logger: ProfileStoreLogger,
  ) {
    this.identityMapPath = join(dataDir, "identity-map.json");
    this.profilesPath = join(dataDir, "profiles.json");
    mkdirSync(dataDir, { recursive: true });
    this.reload();
  }

  // ─── Read operations (mtime-based cache) ───

  private refreshIdentityMap(): IdentityMap {
    try {
      const mtime = statSync(this.identityMapPath).mtimeMs;
      if (mtime !== this.identityMapMtime) {
        this.identityMapCache = JSON.parse(readFileSync(this.identityMapPath, "utf-8")) as IdentityMap;
        this.identityMapMtime = mtime;
      }
    } catch {
      // File doesn't exist yet — keep empty cache
    }
    return this.identityMapCache;
  }

  private refreshProfiles(): ProfilesMap {
    try {
      const mtime = statSync(this.profilesPath).mtimeMs;
      if (mtime !== this.profilesMtime) {
        this.profilesCache = JSON.parse(readFileSync(this.profilesPath, "utf-8")) as ProfilesMap;
        this.profilesMtime = mtime;
      }
    } catch {
      // File doesn't exist yet — keep empty cache
    }
    return this.profilesCache;
  }

  reload(): void {
    this.identityMapMtime = 0;
    this.profilesMtime = 0;
    this.refreshIdentityMap();
    this.refreshProfiles();
  }

  // ─── Atomic write helpers ───

  private writeIdentityMap(map: IdentityMap): void {
    const tmp = this.identityMapPath + `.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(map, null, 2), "utf-8");
    renameSync(tmp, this.identityMapPath);
    this.identityMapCache = map;
    try {
      this.identityMapMtime = statSync(this.identityMapPath).mtimeMs;
    } catch { /* next read will reload */ }
  }

  private writeProfiles(profiles: ProfilesMap): void {
    const tmp = this.profilesPath + `.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(profiles, null, 2), "utf-8");
    renameSync(tmp, this.profilesPath);
    this.profilesCache = profiles;
    try {
      this.profilesMtime = statSync(this.profilesPath).mtimeMs;
    } catch { /* next read will reload */ }
  }

  // ─── Public API ───

  /** Look up canonical ID for a provider:externalId pair. Returns null if not mapped. */
  resolveCanonicalId(provider: string, externalId: string): string | null {
    const map = this.refreshIdentityMap();
    return map[`${provider}:${externalId}`] ?? null;
  }

  /**
   * Get or create a canonical user for the given external identity.
   * Returns the canonical ID (existing or newly created).
   */
  getOrCreateUser(provider: string, externalId: string, hint?: { label?: string }): string {
    const existing = this.resolveCanonicalId(provider, externalId);
    if (existing) return existing;

    const canonicalId = randomBytes(6).toString("hex");
    const now = Date.now();

    // Update identity map
    const map = this.refreshIdentityMap();
    map[`${provider}:${externalId}`] = canonicalId;
    this.writeIdentityMap(map);

    // Create profile
    const profiles = this.refreshProfiles();
    const profile: UserProfile = {
      canonicalId,
      displayName: hint?.label ?? externalId,
      linkedIdentities: [
        {
          provider,
          externalId,
          label: hint?.label,
          linkedAt: now,
        },
      ],
      role: "",
      language: "",
      timezone: "",
      bio: "",
      notes: "",
      tags: [],
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      lastChannel: provider,
    };
    profiles[canonicalId] = profile;
    this.writeProfiles(profiles);

    this.logger.info?.(`user-profiles: created new user ${canonicalId} for ${provider}:${externalId}`);
    return canonicalId;
  }

  getProfile(canonicalId: string): UserProfile | null {
    const profiles = this.refreshProfiles();
    return profiles[canonicalId] ?? null;
  }

  updateProfile(canonicalId: string, patch: Partial<Omit<UserProfile, "canonicalId" | "createdAt" | "linkedIdentities">>): void {
    const profiles = this.refreshProfiles();
    const existing = profiles[canonicalId];
    if (!existing) {
      this.logger.warn?.(`user-profiles: updateProfile called for unknown canonical ${canonicalId}`);
      return;
    }
    Object.assign(existing, patch, { updatedAt: Date.now() });
    this.writeProfiles(profiles);
  }

  linkIdentity(canonicalId: string, provider: string, externalId: string, label?: string): void {
    const profiles = this.refreshProfiles();
    const profile = profiles[canonicalId];
    if (!profile) {
      this.logger.warn?.(`user-profiles: linkIdentity called for unknown canonical ${canonicalId}`);
      return;
    }

    // Add to identity map
    const map = this.refreshIdentityMap();
    map[`${provider}:${externalId}`] = canonicalId;
    this.writeIdentityMap(map);

    // Add to profile's linkedIdentities (if not already present)
    const alreadyLinked = profile.linkedIdentities.some(
      (li) => li.provider === provider && li.externalId === externalId,
    );
    if (!alreadyLinked) {
      profile.linkedIdentities.push({
        provider,
        externalId,
        label,
        linkedAt: Date.now(),
      });
      profile.updatedAt = Date.now();
      this.writeProfiles(profiles);
    }

    this.logger.info?.(`user-profiles: linked ${provider}:${externalId} to ${canonicalId}`);
  }

  /**
   * Merge source canonical into target canonical.
   * - All source identity mappings point to target
   * - Source linkedIdentities appended to target
   * - Source profile deleted
   */
  mergeUsers(targetCanonical: string, sourceCanonical: string): void {
    if (targetCanonical === sourceCanonical) return;

    const map = this.refreshIdentityMap();
    const profiles = this.refreshProfiles();

    const targetProfile = profiles[targetCanonical];
    const sourceProfile = profiles[sourceCanonical];
    if (!targetProfile) {
      this.logger.warn?.(`user-profiles: mergeUsers target ${targetCanonical} not found`);
      return;
    }

    // Re-point all source identity mappings to target
    for (const [key, value] of Object.entries(map)) {
      if (value === sourceCanonical) {
        map[key] = targetCanonical;
      }
    }
    this.writeIdentityMap(map);

    // Merge linked identities
    if (sourceProfile) {
      const existingKeys = new Set(
        targetProfile.linkedIdentities.map((li) => `${li.provider}:${li.externalId}`),
      );
      for (const li of sourceProfile.linkedIdentities) {
        const key = `${li.provider}:${li.externalId}`;
        if (!existingKeys.has(key)) {
          targetProfile.linkedIdentities.push(li);
          existingKeys.add(key);
        }
      }

      // Merge notes (append source notes if any)
      if (sourceProfile.notes && sourceProfile.notes.trim()) {
        targetProfile.notes = targetProfile.notes
          ? `${targetProfile.notes}\n${sourceProfile.notes}`
          : sourceProfile.notes;
      }

      // Merge tags
      const tagSet = new Set([...targetProfile.tags, ...sourceProfile.tags]);
      targetProfile.tags = [...tagSet];

      // Keep earlier createdAt
      if (sourceProfile.createdAt < targetProfile.createdAt) {
        targetProfile.createdAt = sourceProfile.createdAt;
      }

      // Delete source profile
      delete profiles[sourceCanonical];
    }

    targetProfile.updatedAt = Date.now();
    this.writeProfiles(profiles);

    this.logger.info?.(`user-profiles: merged ${sourceCanonical} into ${targetCanonical}`);
  }

  /** Get all canonical IDs (for admin/debug). */
  listCanonicals(): string[] {
    const profiles = this.refreshProfiles();
    return Object.keys(profiles);
  }
}
