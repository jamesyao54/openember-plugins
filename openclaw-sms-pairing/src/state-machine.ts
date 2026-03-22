import { randomInt } from "node:crypto";

export type VerificationState = {
  mobile: string;
  code: string;
  expiresAt: number;
  attempts: number;
  smsSentAt: number;
};

export type StateMachineConfig = {
  expiryMs: number;       // default 300_000 (5 min)
  maxAttempts: number;     // default 5
};

export class VerificationStateMachine {
  private readonly states = new Map<string, VerificationState>();
  private readonly config: StateMachineConfig;

  constructor(config: StateMachineConfig) {
    this.config = config;
  }

  private key(channel: string, senderId: string): string {
    return `${channel}:${senderId}`;
  }

  get(channel: string, senderId: string): VerificationState | undefined {
    const state = this.states.get(this.key(channel, senderId));
    if (state && Date.now() > state.expiresAt) {
      this.states.delete(this.key(channel, senderId));
      return undefined;
    }
    return state;
  }

  create(channel: string, senderId: string, mobile: string): VerificationState {
    const now = Date.now();
    const state: VerificationState = {
      mobile,
      code: String(randomInt(100000, 999999)),
      expiresAt: now + this.config.expiryMs,
      attempts: 0,
      smsSentAt: now,
    };
    this.states.set(this.key(channel, senderId), state);
    return state;
  }

  verify(channel: string, senderId: string, inputCode: string): "success" | "wrong_code" | "max_attempts" | "not_found" {
    const state = this.get(channel, senderId);
    if (!state) return "not_found";

    if (state.code === inputCode.trim()) {
      this.states.delete(this.key(channel, senderId));
      return "success";
    }

    state.attempts++;
    if (state.attempts >= this.config.maxAttempts) {
      this.states.delete(this.key(channel, senderId));
      return "max_attempts";
    }

    return "wrong_code";
  }

  complete(channel: string, senderId: string): void {
    this.states.delete(this.key(channel, senderId));
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, state] of this.states) {
      if (now > state.expiresAt) this.states.delete(key);
    }
  }

  // Test helper
  _setExpiresAt(channel: string, senderId: string, ts: number): void {
    const state = this.states.get(this.key(channel, senderId));
    if (state) state.expiresAt = ts;
  }
}
