export type RateLimitConfig = {
  resendIntervalSeconds: number;
  maxAttemptsPerHour: number;
  maxDailyTotal: number;
};

type PhoneCounter = { count: number; windowStart: number };

type CheckResult =
  | { allowed: true }
  | { allowed: false; reason: "resend_cooldown" | "phone_hourly_limit" | "daily_global_limit" };

export class RateLimiter {
  private readonly config: RateLimitConfig;
  private readonly senderLastSent = new Map<string, number>();
  private readonly phoneCounters = new Map<string, PhoneCounter>();
  private dailyTotal = 0;
  private dailyWindowStart = Date.now();

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  check(senderKey: string, mobile: string): CheckResult {
    const now = Date.now();
    const lastSent = this.senderLastSent.get(senderKey);
    if (lastSent && now - lastSent < this.config.resendIntervalSeconds * 1000) {
      return { allowed: false, reason: "resend_cooldown" };
    }
    const counter = this.phoneCounters.get(mobile);
    if (counter) {
      if (now - counter.windowStart > 3600_000) {
        counter.count = 0;
        counter.windowStart = now;
      }
      if (counter.count >= this.config.maxAttemptsPerHour) {
        return { allowed: false, reason: "phone_hourly_limit" };
      }
    }
    if (now - this.dailyWindowStart > 86400_000) {
      this.dailyTotal = 0;
      this.dailyWindowStart = now;
    }
    if (this.dailyTotal >= this.config.maxDailyTotal) {
      return { allowed: false, reason: "daily_global_limit" };
    }
    return { allowed: true };
  }

  recordSend(senderKey: string, mobile: string): void {
    const now = Date.now();
    this.senderLastSent.set(senderKey, now);
    const counter = this.phoneCounters.get(mobile);
    if (counter) {
      if (now - counter.windowStart > 3600_000) {
        counter.count = 1; counter.windowStart = now;
      } else { counter.count++; }
    } else {
      this.phoneCounters.set(mobile, { count: 1, windowStart: now });
    }
    this.dailyTotal++;
  }

  // Test helpers
  _setPhoneWindowStart(mobile: string, ts: number): void {
    const c = this.phoneCounters.get(mobile); if (c) c.windowStart = ts;
  }
  _setPhoneCount(mobile: string, count: number): void {
    const c = this.phoneCounters.get(mobile); if (c) c.count = count;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, ts] of this.senderLastSent) {
      if (now - ts > this.config.resendIntervalSeconds * 1000 * 2) this.senderLastSent.delete(key);
    }
    for (const [key, counter] of this.phoneCounters) {
      if (now - counter.windowStart > 3600_000) this.phoneCounters.delete(key);
    }
  }
}
