import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { memoryOpenVikingConfigSchema } from "../dist/config.js";

describe("memoryOpenVikingConfigSchema.parse — userProfiles", () => {
  it("defaults userProfiles to disabled when omitted", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({});
    assert.equal(cfg.userProfiles.enabled, false);
    assert.equal(cfg.userProfiles.autoCreateProfile, true);
    assert.equal(cfg.userProfiles.injectProfile, true);
    assert.equal(cfg.userProfiles.tokenTtlMs, 600_000);
  });

  it("defaults userProfiles to disabled when null", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({ userProfiles: null });
    assert.equal(cfg.userProfiles.enabled, false);
  });

  it("enables userProfiles when explicitly set", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({
      userProfiles: {
        enabled: true,
        dataDir: "/tmp/test-profiles",
      },
    });
    assert.equal(cfg.userProfiles.enabled, true);
    assert.equal(cfg.userProfiles.dataDir, "/tmp/test-profiles");
  });

  it("applies tokenTtlMs minimum of 30s", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true, tokenTtlMs: 100 },
    });
    assert.equal(cfg.userProfiles.tokenTtlMs, 30_000);
  });

  it("accepts valid tokenTtlMs", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true, tokenTtlMs: 300_000 },
    });
    assert.equal(cfg.userProfiles.tokenTtlMs, 300_000);
  });

  it("defaults autoCreateProfile to true when not set", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true },
    });
    assert.equal(cfg.userProfiles.autoCreateProfile, true);
  });

  it("respects autoCreateProfile = false", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true, autoCreateProfile: false },
    });
    assert.equal(cfg.userProfiles.autoCreateProfile, false);
  });

  it("defaults injectProfile to true", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true },
    });
    assert.equal(cfg.userProfiles.injectProfile, true);
  });

  it("respects injectProfile = false", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true, injectProfile: false },
    });
    assert.equal(cfg.userProfiles.injectProfile, false);
  });

  // ─── Backward compatibility ───

  it("existing config without userProfiles still parses correctly", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({
      mode: "remote",
      baseUrl: "http://localhost:1933",
      agentId: "test",
      autoCapture: true,
      autoRecall: true,
    });
    assert.equal(cfg.mode, "remote");
    assert.equal(cfg.baseUrl, "http://localhost:1933");
    assert.equal(cfg.agentId, "test");
    assert.equal(cfg.autoCapture, true);
    assert.equal(cfg.autoRecall, true);
    assert.equal(cfg.userProfiles.enabled, false);
  });

  it("rejects unknown top-level keys", () => {
    assert.throws(() => {
      memoryOpenVikingConfigSchema.parse({ unknownKey: true });
    }, /unknown keys/);
  });
});
