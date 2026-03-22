import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/rate-limit.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;
  beforeEach(() => {
    limiter = new RateLimiter({ resendIntervalSeconds: 60, maxAttemptsPerHour: 5, maxDailyTotal: 200 });
  });

  it("allows first SMS for a sender", () => {
    assert.equal(limiter.check("discord:user1", "13812345678").allowed, true);
  });
  it("blocks sender within resend interval", () => {
    limiter.recordSend("discord:user1", "13812345678");
    const result = limiter.check("discord:user1", "13812345678");
    assert.equal(result.allowed, false);
    assert.equal((result as any).reason, "resend_cooldown");
  });
  it("blocks phone number exceeding hourly limit", () => {
    for (let i = 0; i < 5; i++) limiter.recordSend(`discord:user${i}`, "13812345678");
    const result = limiter.check("discord:user99", "13812345678");
    assert.equal(result.allowed, false);
    assert.equal((result as any).reason, "phone_hourly_limit");
  });
  it("blocks when daily global cap reached", () => {
    const small = new RateLimiter({ resendIntervalSeconds: 0, maxAttemptsPerHour: 999, maxDailyTotal: 3 });
    for (let i = 0; i < 3; i++) small.recordSend(`discord:user${i}`, `1381234000${i}`);
    const result = small.check("discord:new", "13899999999");
    assert.equal(result.allowed, false);
    assert.equal((result as any).reason, "daily_global_limit");
  });
  it("resets phone counter after 1 hour", () => {
    limiter.recordSend("discord:user1", "13812345678");
    limiter._setPhoneWindowStart("13812345678", Date.now() - 3600_001);
    limiter._setPhoneCount("13812345678", 5);
    const result = limiter.check("discord:user2", "13812345678");
    assert.equal(result.allowed, true);
  });
});
