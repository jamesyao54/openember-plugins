import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { BindFlowManager } from "../dist/user-profiles/bind-flow.js";
import { ProfileStore } from "../dist/user-profiles/store.js";

const noopLogger = { info() {}, warn() {}, debug() {} };

describe("BindFlowManager", () => {
  let dir;
  let store;
  let manager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bind-test-"));
    store = new ProfileStore(dir, noopLogger);
    manager = new BindFlowManager(store, 600_000); // 10 min TTL
  });

  afterEach(() => {
    manager.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  // ─── createBind ───

  it("generates a 6-character uppercase token", () => {
    const token = manager.createBind("discord", "111", "canonical-aaa");
    assert.equal(typeof token, "string");
    assert.equal(token.length, 6);
    assert.match(token, /^[A-F0-9]{6}$/);
  });

  it("increments pending count", () => {
    assert.equal(manager.pendingCount, 0);
    manager.createBind("discord", "111", "canonical-aaa");
    assert.equal(manager.pendingCount, 1);
    manager.createBind("telegram", "222", "canonical-bbb");
    assert.equal(manager.pendingCount, 2);
  });

  // ─── verifyBind: success (no merge) ───

  it("links verifier identity to initiator canonical (no merge needed)", () => {
    const canonical = store.getOrCreateUser("discord", "111", { label: "alice" });
    const token = manager.createBind("discord", "111", canonical);

    const result = manager.verifyBind(token, { provider: "telegram", externalId: "222" });
    assert.ok(result.ok);
    assert.equal(result.merged, false);
    assert.equal(result.canonicalId, canonical);

    // Verify identity is linked in store
    assert.equal(store.resolveCanonicalId("telegram", "222"), canonical);
  });

  it("token is consumed after verify", () => {
    const canonical = store.getOrCreateUser("discord", "111");
    const token = manager.createBind("discord", "111", canonical);

    manager.verifyBind(token, { provider: "telegram", externalId: "222" });

    // Second use fails
    const result2 = manager.verifyBind(token, { provider: "webchat", externalId: "333" });
    assert.equal(result2.ok, false);
    assert.equal(result2.reason, "invalid_or_expired_token");
  });

  // ─── verifyBind: merge ───

  it("merges profiles when verifier has different canonical", () => {
    const canonical1 = store.getOrCreateUser("discord", "111", { label: "alice" });
    const canonical2 = store.getOrCreateUser("telegram", "222", { label: "alice_tg" });

    store.updateProfile(canonical2, { notes: "telegram note" });

    const token = manager.createBind("discord", "111", canonical1);
    const result = manager.verifyBind(token, { provider: "telegram", externalId: "222" });

    assert.ok(result.ok);
    assert.equal(result.merged, true);
    assert.equal(result.canonicalId, canonical1);

    // Both identities now resolve to canonical1
    assert.equal(store.resolveCanonicalId("discord", "111"), canonical1);
    assert.equal(store.resolveCanonicalId("telegram", "222"), canonical1);

    // Source profile is gone
    assert.equal(store.getProfile(canonical2), null);

    // Target profile has merged identities
    const profile = store.getProfile(canonical1);
    assert.equal(profile.linkedIdentities.length, 2);
    assert.ok(profile.notes.includes("telegram note"));
  });

  // ─── verifyBind: error cases ───

  it("rejects invalid token", () => {
    const result = manager.verifyBind("XXXXXX", { provider: "telegram", externalId: "222" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_or_expired_token");
  });

  it("rejects same identity", () => {
    const canonical = store.getOrCreateUser("discord", "111");
    const token = manager.createBind("discord", "111", canonical);

    const result = manager.verifyBind(token, { provider: "discord", externalId: "111" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "same_identity");
  });

  it("rejects expired token", async () => {
    // Create manager with 1ms TTL
    const shortManager = new BindFlowManager(store, 1);
    const canonical = store.getOrCreateUser("discord", "111");
    const token = shortManager.createBind("discord", "111", canonical);

    // Wait just enough for the token to expire
    await new Promise((r) => setTimeout(r, 10));

    const result = shortManager.verifyBind(token, { provider: "telegram", externalId: "222" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "token_expired");
    shortManager.dispose();
  });

  // ─── case insensitive tokens ───

  it("handles case-insensitive token matching", () => {
    const canonical = store.getOrCreateUser("discord", "111");
    const token = manager.createBind("discord", "111", canonical);

    // Verify with lowercase version
    const result = manager.verifyBind(token.toLowerCase(), { provider: "telegram", externalId: "222" });
    assert.ok(result.ok);
  });

  // ─── dispose ───

  it("clears pending binds on dispose", () => {
    manager.createBind("discord", "111", "aaa");
    assert.equal(manager.pendingCount, 1);
    manager.dispose();
    assert.equal(manager.pendingCount, 0);
  });
});
