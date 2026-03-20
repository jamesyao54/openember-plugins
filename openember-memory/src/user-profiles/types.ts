/**
 * User identity & profile types for cross-channel identity unification.
 */

export type LinkedIdentity = {
  provider: string;
  externalId: string;
  label?: string;
  linkedAt: number;
};

export type UserProfile = {
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

/** identity-map.json: "provider:externalId" → canonicalId */
export type IdentityMap = Record<string, string>;

/** profiles.json: canonicalId → UserProfile */
export type ProfilesMap = Record<string, UserProfile>;

export type PendingBind = {
  provider: string;
  externalId: string;
  canonicalId: string;
  expiresAt: number;
};

export type ExternalIdentity = {
  provider: string;
  externalId: string;
};

export type BindResult =
  | { ok: true; merged: boolean; canonicalId: string; message: string }
  | { ok: false; reason: string };
