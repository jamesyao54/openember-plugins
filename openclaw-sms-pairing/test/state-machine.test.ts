import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VerificationStateMachine } from "../src/state-machine.js";

describe("VerificationStateMachine", () => {
  let sm: VerificationStateMachine;

  beforeEach(() => {
    sm = new VerificationStateMachine({ expiryMs: 300_000, maxAttempts: 5 });
  });

  it("creates verification with 6-digit code", () => {
    const state = sm.create("discord", "user1", "13812345678");
    assert.equal(state.mobile, "13812345678");
    assert.equal(state.code.length, 6);
    assert.match(state.code, /^\d{6}$/);
    assert.equal(state.attempts, 0);
  });

  it("gets existing verification", () => {
    sm.create("discord", "user1", "13812345678");
    const state = sm.get("discord", "user1");
    assert.ok(state);
    assert.equal(state.mobile, "13812345678");
  });

  it("returns undefined for unknown sender", () => {
    assert.equal(sm.get("discord", "unknown"), undefined);
  });

  it("verifies correct code", () => {
    const state = sm.create("discord", "user1", "13812345678");
    const result = sm.verify("discord", "user1", state.code);
    assert.equal(result, "success");
    assert.equal(sm.get("discord", "user1"), undefined); // cleared after success
  });

  it("returns wrong_code for incorrect code", () => {
    sm.create("discord", "user1", "13812345678");
    const result = sm.verify("discord", "user1", "000000");
    assert.equal(result, "wrong_code");
    const state = sm.get("discord", "user1");
    assert.ok(state);
    assert.equal(state.attempts, 1);
  });

  it("returns max_attempts after too many wrong codes", () => {
    sm.create("discord", "user1", "13812345678");
    for (let i = 0; i < 4; i++) sm.verify("discord", "user1", "000000");
    const result = sm.verify("discord", "user1", "000000");
    assert.equal(result, "max_attempts");
    assert.equal(sm.get("discord", "user1"), undefined); // cleared
  });

  it("returns not_found for expired verification", () => {
    sm.create("discord", "user1", "13812345678");
    sm._setExpiresAt("discord", "user1", Date.now() - 1);
    assert.equal(sm.get("discord", "user1"), undefined);
  });

  it("cleanup removes expired entries", () => {
    sm.create("discord", "user1", "13812345678");
    sm._setExpiresAt("discord", "user1", Date.now() - 1);
    sm.cleanup();
    assert.equal(sm.get("discord", "user1"), undefined);
  });

  it("overwrites existing verification on re-create", () => {
    const first = sm.create("discord", "user1", "13812345678");
    const second = sm.create("discord", "user1", "13812345678");
    assert.notEqual(first.code, second.code); // very unlikely to match
  });
});
