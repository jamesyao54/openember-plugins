import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";

type LinkedIdentity = {
  provider: string;
  externalId: string;
  label?: string;
  linkedAt: number;
};

type UserProfile = {
  canonicalId: string;
  displayName: string;
  linkedIdentities: LinkedIdentity[];
  role: string;
  language: string;
  timezone: string;
  bio: string;
  notes: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  lastChannel: string;
};

type IdentityMap = Record<string, string>;
type ProfilesMap = Record<string, UserProfile>;
type CreateResult = { canonicalId: string; isNew: boolean };

export class ProfileWriter {
  private readonly identityMapPath: string;
  private readonly profilesPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.identityMapPath = join(dataDir, "identity-map.json");
    this.profilesPath = join(dataDir, "profiles.json");
  }

  async createOrLinkProfile(mobile: string, channel: string, channelUserId: string): Promise<CreateResult> {
    return new Promise<CreateResult>((resolve, reject) => {
      this.writeQueue = this.writeQueue
        .then(() => this._createOrLinkProfile(mobile, channel, channelUserId))
        .then(resolve, reject);
    });
  }

  private _createOrLinkProfile(mobile: string, channel: string, channelUserId: string): CreateResult {
    const now = Date.now();
    const canonicalId = deriveCanonicalId(mobile);
    const map = this.readIdentityMap();
    const profiles = this.readProfiles();
    const existingId = map[`mobile:${mobile}`];
    const isNew = !existingId;

    if (isNew) {
      const profile: UserProfile = {
        canonicalId,
        displayName: "",
        linkedIdentities: [
          { provider: "mobile", externalId: mobile, linkedAt: now },
          { provider: channel, externalId: channelUserId, linkedAt: now },
        ],
        role: "", language: "", timezone: "", bio: "", notes: "", tags: [],
        createdAt: now, updatedAt: now, lastSeenAt: now, lastChannel: channel,
      };
      profiles[canonicalId] = profile;
      map[`mobile:${mobile}`] = canonicalId;
      map[`${channel}:${channelUserId}`] = canonicalId;
    } else {
      const profile = profiles[existingId];
      if (profile) {
        const alreadyLinked = profile.linkedIdentities.some(
          (li) => li.provider === channel && li.externalId === channelUserId,
        );
        if (!alreadyLinked) {
          profile.linkedIdentities.push({ provider: channel, externalId: channelUserId, linkedAt: now });
          profile.updatedAt = now;
        }
        profile.lastSeenAt = now;
        profile.lastChannel = channel;
        map[`${channel}:${channelUserId}`] = existingId;
      }
    }

    this.writeIdentityMap(map);
    this.writeProfiles(profiles);
    return { canonicalId: existingId ?? canonicalId, isNew };
  }

  private readIdentityMap(): IdentityMap {
    try { return JSON.parse(readFileSync(this.identityMapPath, "utf-8")); } catch { return {}; }
  }
  private readProfiles(): ProfilesMap {
    try { return JSON.parse(readFileSync(this.profilesPath, "utf-8")); } catch { return {}; }
  }
  private writeIdentityMap(map: IdentityMap): void {
    const tmp = this.identityMapPath + `.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(map, null, 2), "utf-8");
    renameSync(tmp, this.identityMapPath);
  }
  private writeProfiles(profiles: ProfilesMap): void {
    const tmp = this.profilesPath + `.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(profiles, null, 2), "utf-8");
    renameSync(tmp, this.profilesPath);
  }
}

export function deriveCanonicalId(mobile: string): string {
  return createHash("sha256").update(mobile).digest("hex").slice(0, 12);
}
