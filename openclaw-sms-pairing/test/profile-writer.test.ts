import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileWriter } from "../src/profile-writer.js";

describe("ProfileWriter", () => {
  let dataDir: string;
  let writer: ProfileWriter;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pw-test-"));
    writer = new ProfileWriter(dataDir);
  });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it("creates new profile with mobile-derived canonicalId", async () => {
    const result = await writer.createOrLinkProfile("13812345678", "discord", "user123");
    assert.ok(result.canonicalId);
    assert.equal(result.canonicalId.length, 12);
    assert.equal(result.isNew, true);
    const profiles = JSON.parse(readFileSync(join(dataDir, "profiles.json"), "utf-8"));
    assert.ok(profiles[result.canonicalId]);
    assert.equal(profiles[result.canonicalId].linkedIdentities.length, 2);
  });

  it("derives same canonicalId for same mobile", async () => {
    const r1 = await writer.createOrLinkProfile("13812345678", "discord", "user1");
    const r2 = await writer.createOrLinkProfile("13812345678", "feishu", "user2");
    assert.equal(r1.canonicalId, r2.canonicalId);
    assert.equal(r2.isNew, false);
    const profiles = JSON.parse(readFileSync(join(dataDir, "profiles.json"), "utf-8"));
    assert.equal(profiles[r1.canonicalId].linkedIdentities.length, 3);
  });

  it("writes identity-map with both mobile and channel entries", async () => {
    await writer.createOrLinkProfile("13812345678", "discord", "user123");
    const map = JSON.parse(readFileSync(join(dataDir, "identity-map.json"), "utf-8"));
    assert.ok(map["mobile:13812345678"]);
    assert.ok(map["discord:user123"]);
    assert.equal(map["mobile:13812345678"], map["discord:user123"]);
  });

  it("handles concurrent writes without data loss", async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      writer.createOrLinkProfile(`1381234000${i}`, "discord", `user${i}`)
    );
    const results = await Promise.all(promises);
    const profiles = JSON.parse(readFileSync(join(dataDir, "profiles.json"), "utf-8"));
    assert.equal(Object.keys(profiles).length, 5);
    for (const r of results) assert.ok(profiles[r.canonicalId]);
  });
});
