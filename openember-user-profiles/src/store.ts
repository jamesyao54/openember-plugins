import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface ChannelId {
  channel: string;
  peerId: string;
  displayName?: string;
}

export type AccessLevel = "guest" | "user" | "trusted" | "admin";

export interface UserProfile {
  canonicalId: string;
  displayName?: string;
  firstSeen: string;
  lastSeen: string;
  channelIds: ChannelId[];
  tags: string[];
  accessLevel: AccessLevel;
  notes: string;
}

export class UserProfileStore {
  private profiles: Map<string, UserProfile> = new Map();
  private identityMap: Map<string, string> = new Map(); // "channel:peerId" → canonicalId
  private dataDir: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async load(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });

    // Load profiles
    const profilesPath = path.join(this.dataDir, "profiles.json");
    try {
      const data = JSON.parse(await fs.readFile(profilesPath, "utf-8")) as unknown;
      if (data && typeof data === "object") {
        for (const [id, profile] of Object.entries(data as Record<string, unknown>)) {
          this.profiles.set(id, profile as UserProfile);
        }
      }
    } catch {
      // File doesn't exist or is empty — start fresh
    }

    // Load identity map
    const identityPath = path.join(this.dataDir, "identity-map.json");
    try {
      const data = JSON.parse(await fs.readFile(identityPath, "utf-8")) as unknown;
      if (data && typeof data === "object") {
        for (const [key, canonicalId] of Object.entries(data as Record<string, unknown>)) {
          this.identityMap.set(key, canonicalId as string);
        }
      }
    } catch {
      // Start fresh
    }
  }

  /**
   * Resolve or create a user profile given a channel and peerId.
   * Returns the canonical user profile.
   */
  resolveOrCreate(channel: string, peerId: string, displayName?: string): UserProfile {
    const key = `${channel}:${peerId}`;

    // Check identity map first
    const existingId = this.identityMap.get(key);
    if (existingId) {
      const profile = this.profiles.get(existingId);
      if (profile) {
        return profile;
      }
    }

    // Check if peerId itself is a known canonical ID
    const directProfile = this.profiles.get(peerId);
    if (directProfile) {
      // Ensure channel mapping exists
      if (!this.identityMap.has(key)) {
        this.identityMap.set(key, peerId);
        // Add channel if not already present
        const hasChannel = directProfile.channelIds.some(
          (c) => c.channel === channel && c.peerId === peerId
        );
        if (!hasChannel) {
          directProfile.channelIds.push({ channel, peerId, displayName });
        }
        this.markDirty();
      }
      return directProfile;
    }

    // Create new profile using peerId as canonicalId
    const now = new Date().toISOString();
    const profile: UserProfile = {
      canonicalId: peerId,
      displayName: displayName ?? peerId,
      firstSeen: now,
      lastSeen: now,
      channelIds: [{ channel, peerId, displayName }],
      tags: [],
      accessLevel: "user",
      notes: "",
    };

    this.profiles.set(peerId, profile);
    this.identityMap.set(key, peerId);
    this.markDirty();
    return profile;
  }

  getByCanonicalId(id: string): UserProfile | undefined {
    return this.profiles.get(id);
  }

  resolveCanonicalId(channel: string, peerId: string): string | undefined {
    return this.identityMap.get(`${channel}:${peerId}`);
  }

  listAll(): UserProfile[] {
    return [...this.profiles.values()];
  }

  updateProfile(
    id: string,
    updates: Partial<Pick<UserProfile, "displayName" | "tags" | "accessLevel" | "notes">>
  ): boolean {
    const profile = this.profiles.get(id);
    if (!profile) return false;
    if (updates.displayName !== undefined) profile.displayName = updates.displayName;
    if (updates.tags !== undefined) profile.tags = updates.tags;
    if (updates.accessLevel !== undefined) profile.accessLevel = updates.accessLevel;
    if (updates.notes !== undefined) profile.notes = updates.notes;
    this.markDirty();
    return true;
  }

  touchLastSeen(id: string): void {
    const profile = this.profiles.get(id);
    if (profile) {
      profile.lastSeen = new Date().toISOString();
      this.markDirty();
    }
  }

  /**
   * Merge two profiles (used for cross-channel identity binding).
   * Keeps the target profile, merges source into it.
   */
  mergeProfiles(targetId: string, sourceId: string): boolean {
    const target = this.profiles.get(targetId);
    const source = this.profiles.get(sourceId);
    if (!target || !source || targetId === sourceId) return false;

    // Merge channel IDs
    for (const ch of source.channelIds) {
      const exists = target.channelIds.some(
        (c) => c.channel === ch.channel && c.peerId === ch.peerId
      );
      if (!exists) {
        target.channelIds.push(ch);
      }
    }

    // Merge tags
    target.tags = [...new Set([...target.tags, ...source.tags])];

    // Keep earlier firstSeen
    if (source.firstSeen < target.firstSeen) {
      target.firstSeen = source.firstSeen;
    }

    // Append notes
    if (source.notes) {
      target.notes = target.notes
        ? `${target.notes}\n${source.notes}`
        : source.notes;
    }

    // Update identity map: redirect all source mappings to target
    for (const [key, id] of this.identityMap.entries()) {
      if (id === sourceId) {
        this.identityMap.set(key, targetId);
      }
    }

    // Remove source profile
    this.profiles.delete(sourceId);
    this.markDirty();
    return true;
  }

  private markDirty(): void {
    this.dirty = true;
    // Debounce save: flush after 2 seconds of inactivity
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.flush().catch(() => {});
    }, 2000);
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    await fs.mkdir(this.dataDir, { recursive: true });

    // Save profiles
    const profilesObj: Record<string, UserProfile> = {};
    for (const [id, profile] of this.profiles) {
      profilesObj[id] = profile;
    }
    await fs.writeFile(
      path.join(this.dataDir, "profiles.json"),
      JSON.stringify(profilesObj, null, 2),
      "utf-8"
    );

    // Save identity map
    const identityObj: Record<string, string> = {};
    for (const [key, id] of this.identityMap) {
      identityObj[key] = id;
    }
    await fs.writeFile(
      path.join(this.dataDir, "identity-map.json"),
      JSON.stringify(identityObj, null, 2),
      "utf-8"
    );
  }

  async close(): Promise<void> {
    await this.flush();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }
}
