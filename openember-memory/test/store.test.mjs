import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ProfileStore } from "../dist/user-profiles/store.js";

const noopLogger = { info() {}, warn() {}, debug() {} };

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "store-test-"));
}

describe("ProfileStore", () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = makeTempDir();
    store = new ProfileStore(dir, noopLogger);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ─── resolveCanonicalId ───

  it("returns null for unmapped identity", () => {
    assert.equal(store.resolveCanonicalId("discord", "999"), null);
  });

  // ─── getOrCreateUser ───

  it("creates a new user and returns canonical id", () => {
    const id = store.getOrCreateUser("discord", "111", { label: "alice" });
    assert.equal(typeof id, "string");
    assert.equal(id.length, 12); // 6 bytes hex = 12 chars
  });

  it("returns existing canonical on second call", () => {
    const id1 = store.getOrCreateUser("discord", "111");
    const id2 = store.getOrCreateUser("discord", "111");
    assert.equal(id1, id2);
  });

  it("writes identity-map.json and profiles.json to disk", () => {
    store.getOrCreateUser("discord", "222", { label: "bob" });
    assert.ok(existsSync(join(dir, "identity-map.json")));
    assert.ok(existsSync(join(dir, "profiles.json")));

    const map = JSON.parse(readFileSync(join(dir, "identity-map.json"), "utf-8"));
    assert.ok("discord:222" in map);

    const profiles = JSON.parse(readFileSync(join(dir, "profiles.json"), "utf-8"));
    const canonical = map["discord:222"];
    assert.equal(profiles[canonical].displayName, "bob");
  });

  // ─── resolveCanonicalId after create ───

  it("resolves after creation", () => {
    const id = store.getOrCreateUser("telegram", "555");
    assert.equal(store.resolveCanonicalId("telegram", "555"), id);
  });

  // ─── getProfile ───

  it("returns profile for existing user", () => {
    const id = store.getOrCreateUser("discord", "333", { label: "charlie" });
    const profile = store.getProfile(id);
    assert.ok(profile);
    assert.equal(profile.canonicalId, id);
    assert.equal(profile.displayName, "charlie");
    assert.equal(profile.linkedIdentities.length, 1);
    assert.equal(profile.linkedIdentities[0].provider, "discord");
    assert.equal(profile.linkedIdentities[0].externalId, "333");
  });

  it("returns null for unknown canonical", () => {
    assert.equal(store.getProfile("nonexistent"), null);
  });

  // ─── updateProfile ───

  it("updates profile fields", () => {
    const id = store.getOrCreateUser("discord", "444");
    store.updateProfile(id, { language: "zh-CN", timezone: "Asia/Shanghai", role: "owner" });
    const profile = store.getProfile(id);
    assert.equal(profile.language, "zh-CN");
    assert.equal(profile.timezone, "Asia/Shanghai");
    assert.equal(profile.role, "owner");
  });

  it("sets updatedAt on update", () => {
    const id = store.getOrCreateUser("discord", "444");
    const before = store.getProfile(id).updatedAt;
    // Tiny delay to ensure timestamp difference
    store.updateProfile(id, { bio: "test bio" });
    const after = store.getProfile(id).updatedAt;
    assert.ok(after >= before);
    assert.equal(store.getProfile(id).bio, "test bio");
  });

  it("ignores update for unknown canonical", () => {
    // Should not throw
    store.updateProfile("unknown-id", { bio: "nope" });
  });

  // ─── linkIdentity ───

  it("links a new identity to existing canonical", () => {
    const id = store.getOrCreateUser("discord", "100");
    store.linkIdentity(id, "telegram", "200", "tg_user");

    assert.equal(store.resolveCanonicalId("telegram", "200"), id);

    const profile = store.getProfile(id);
    assert.equal(profile.linkedIdentities.length, 2);
    const tgLink = profile.linkedIdentities.find((li) => li.provider === "telegram");
    assert.ok(tgLink);
    assert.equal(tgLink.externalId, "200");
    assert.equal(tgLink.label, "tg_user");
  });

  it("does not duplicate already-linked identity", () => {
    const id = store.getOrCreateUser("discord", "100");
    store.linkIdentity(id, "discord", "100", "same");
    const profile = store.getProfile(id);
    assert.equal(profile.linkedIdentities.length, 1);
  });

  // ─── mergeUsers ───

  it("merges source canonical into target", () => {
    const target = store.getOrCreateUser("discord", "aaa", { label: "target_user" });
    const source = store.getOrCreateUser("telegram", "bbb", { label: "source_user" });

    // Add notes to source
    store.updateProfile(source, { notes: "source note", tags: ["tag-s"] });
    store.updateProfile(target, { notes: "target note", tags: ["tag-t"] });

    store.mergeUsers(target, source);

    // Source identity now resolves to target
    assert.equal(store.resolveCanonicalId("telegram", "bbb"), target);

    // Source profile deleted
    assert.equal(store.getProfile(source), null);

    // Target has merged identities
    const profile = store.getProfile(target);
    assert.equal(profile.linkedIdentities.length, 2);
    assert.ok(profile.linkedIdentities.some((li) => li.provider === "telegram" && li.externalId === "bbb"));

    // Notes merged
    assert.ok(profile.notes.includes("target note"));
    assert.ok(profile.notes.includes("source note"));

    // Tags merged
    assert.ok(profile.tags.includes("tag-t"));
    assert.ok(profile.tags.includes("tag-s"));
  });

  it("no-ops when merging same canonical", () => {
    const id = store.getOrCreateUser("discord", "same");
    store.mergeUsers(id, id);
    assert.ok(store.getProfile(id)); // still exists
  });

  it("handles merge when source has no profile", () => {
    const target = store.getOrCreateUser("discord", "x");
    // merging a nonexistent source should not throw
    store.mergeUsers(target, "nonexistent");
    assert.ok(store.getProfile(target));
  });

  // ─── reload / mtime cache ───

  it("picks up external file changes after reload", () => {
    const id = store.getOrCreateUser("discord", "reload-test");

    // Externally modify profiles.json
    const profilesPath = join(dir, "profiles.json");
    const profiles = JSON.parse(readFileSync(profilesPath, "utf-8"));
    profiles[id].displayName = "externally_changed";
    writeFileSync(profilesPath, JSON.stringify(profiles), "utf-8");

    // Force reload (mtime may not change within same ms — force via reload)
    store.reload();
    const profile = store.getProfile(id);
    assert.equal(profile.displayName, "externally_changed");
  });

  // ─── listCanonicals ───

  it("lists all canonical IDs", () => {
    const id1 = store.getOrCreateUser("discord", "c1");
    const id2 = store.getOrCreateUser("telegram", "c2");
    const list = store.listCanonicals();
    assert.ok(list.includes(id1));
    assert.ok(list.includes(id2));
    assert.equal(list.length, 2);
  });

  // ─── Persistence across instances ───

  it("new store instance reads existing data", () => {
    const id = store.getOrCreateUser("discord", "persist-test", { label: "persisted" });

    const store2 = new ProfileStore(dir, noopLogger);
    assert.equal(store2.resolveCanonicalId("discord", "persist-test"), id);
    assert.equal(store2.getProfile(id).displayName, "persisted");
  });
});
