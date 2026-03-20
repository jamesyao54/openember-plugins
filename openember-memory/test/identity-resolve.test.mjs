import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { extractExternalIdentity, resolveCanonicalUserId } from "../dist/user-profiles/identity-resolve.js";
import { ProfileStore } from "../dist/user-profiles/store.js";

const noopLogger = { info() {}, warn() {}, debug() {} };

describe("extractExternalIdentity", () => {
  // ─── From sessionKey ───

  it("extracts discord identity from direct sessionKey", () => {
    const result = extractExternalIdentity("agent:ember:direct:1112318905768231003");
    assert.deepEqual(result, { provider: "discord", externalId: "1112318905768231003" });
  });

  it("extracts webchat identity from main sessionKey", () => {
    const result = extractExternalIdentity("agent:ember:main");
    assert.deepEqual(result, { provider: "discord", externalId: "main" });
  });

  it("extracts telegram identity from direct sessionKey", () => {
    const result = extractExternalIdentity("agent:tg:direct:12345");
    assert.deepEqual(result, { provider: "telegram", externalId: "12345" });
  });

  it("extracts webchat identity from webchat sessionKey", () => {
    const result = extractExternalIdentity("agent:web:direct:user42");
    assert.deepEqual(result, { provider: "webchat", externalId: "user42" });
  });

  // ─── From explicit senderId + channelId ───

  it("uses senderId + channelId when provided", () => {
    const result = extractExternalIdentity(undefined, undefined, "discord", "99999");
    assert.deepEqual(result, { provider: "discord", externalId: "99999" });
  });

  it("sessionKey takes priority over senderId + channelId", () => {
    const result = extractExternalIdentity("agent:ember:direct:111", undefined, "telegram", "222");
    assert.deepEqual(result, { provider: "discord", externalId: "111" });
  });

  // ─── From prompt metadata ───

  it("extracts from Sender metadata in prompt", () => {
    const prompt = `Hello\nSender (untrusted metadata): \`\`\`json\n{"userId": "alice_from_prompt"}\n\`\`\`\nHi there`;
    const result = extractExternalIdentity(undefined, prompt);
    assert.ok(result);
    assert.equal(result.externalId, "alice_from_prompt");
    assert.equal(result.provider, "unknown"); // no sessionKey to derive provider
  });

  it("uses sessionKey prefix for provider when extracting from prompt", () => {
    const prompt = `Sender (untrusted metadata): \`\`\`json\n{"userId": "bob"}\n\`\`\``;
    const result = extractExternalIdentity("agent:tg:group:chat123", prompt, undefined, undefined);
    assert.ok(result);
    assert.equal(result.externalId, "bob");
    assert.equal(result.provider, "telegram");
  });

  // ─── Edge cases ───

  it("returns null when no context provided", () => {
    assert.equal(extractExternalIdentity(), null);
  });

  it("returns null for unrecognized sessionKey format", () => {
    assert.equal(extractExternalIdentity("some:random:key"), null);
  });
});

describe("resolveCanonicalUserId", () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "resolve-test-"));
    store = new ProfileStore(dir, noopLogger);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ─── With store ───

  it("creates user and resolves canonical when store is provided", () => {
    const id = resolveCanonicalUserId(store, "agent:ember:direct:111");
    assert.ok(id);
    assert.equal(id.length, 12);

    // Same call returns same id
    const id2 = resolveCanonicalUserId(store, "agent:ember:direct:111");
    assert.equal(id, id2);
  });

  it("respects autoCreate=false", () => {
    const id = resolveCanonicalUserId(store, "agent:ember:direct:999", undefined, undefined, undefined, false);
    assert.equal(id, null);
  });

  it("resolves through existing identity map", () => {
    // Pre-create user
    const canonical = store.getOrCreateUser("discord", "777");

    const id = resolveCanonicalUserId(store, "agent:ember:direct:777");
    assert.equal(id, canonical);
  });

  // ─── Without store (legacy fallback) ───

  it("falls back to raw peerId when store is null", () => {
    const id = resolveCanonicalUserId(null, "agent:ember:direct:alice");
    assert.equal(id, "alice");
  });

  it("falls back to prompt sender when store is null", () => {
    const prompt = `Sender (untrusted metadata): \`\`\`json\n{"userId": "bob"}\n\`\`\``;
    const id = resolveCanonicalUserId(null, undefined, prompt);
    assert.equal(id, "bob");
  });

  it("returns null when store is null and no context", () => {
    assert.equal(resolveCanonicalUserId(null), null);
  });
});
