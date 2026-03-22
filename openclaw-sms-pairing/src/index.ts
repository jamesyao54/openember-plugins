import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Type } from "@sinclair/typebox";

import { smsPairingConfigSchema } from "./config.js";
import type { SmsPairingConfig } from "./config.js";
import { normalizeMobile, maskMobile } from "./phone.js";
import { SmsClient } from "./sms-client.js";
import { VerificationStateMachine } from "./state-machine.js";
import { RateLimiter } from "./rate-limit.js";
import { ProfileWriter } from "./profile-writer.js";

// ─── Inline OpenClawPluginApi type (peer-dep; avoid direct import) ───
type OpenClawPluginApi = {
  pluginConfig: unknown;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  registerTool: (factory: (ctx: ToolContext) => unknown[], options: { names: string[] }) => void;
  on: (event: string, handler: (event: any, ctx?: any) => Promise<unknown> | void) => void;
  registerService: (service: { id: string; start: () => Promise<void>; stop: () => void }) => void;
};

type ToolContext = {
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
  requesterSenderId?: string;
};

// ─── Constants ───
const CLEANUP_INTERVAL_MS = 60_000; // 1 minute
const VERIFICATION_PROMPT = `<sms-verification>
该用户尚未完成手机号验证。你的唯一任务是引导用户完成验证：
1. 告诉用户需要验证手机号
2. 当用户提供手机号时，调用 sms_send_code 工具
3. 当用户提供验证码时，调用 sms_verify_code 工具
4. 验证成功后告诉用户"搞定了，直接说你想吃什么吧。"

不要回答任何其他问题。如果用户问与验证无关的问题，礼貌地引导回验证流程。
</sms-verification>`;

// ─── Helpers ───

/**
 * Extract channel and senderId from context.
 * Prefer dedicated fields (requesterSenderId + messageChannel) over sessionKey parsing.
 * sessionKey format: "agent:{agentId}:{channel}:{scope}:{userId}" (5 parts)
 */
function extractIdentity(ctx?: ToolContext): { channel: string; senderId: string } | null {
  // Prefer dedicated fields (matches openember-memory's approach)
  if (ctx?.requesterSenderId) {
    return { channel: ctx.messageChannel ?? "unknown", senderId: ctx.requesterSenderId };
  }
  // Fallback: parse sessionKey
  if (ctx?.sessionKey) {
    const parts = ctx.sessionKey.split(":");
    // Format: agent:agentId:channel:scope:userId (5 parts)
    if (parts.length >= 5) {
      return { channel: parts[2], senderId: parts[4] };
    }
  }
  return null;
}

/**
 * Check if a user already has a profile by looking up identity-map.json.
 */
function hasProfile(dataDir: string, channel: string, senderId: string): boolean {
  try {
    const mapPath = join(dataDir, "identity-map.json");
    const raw = readFileSync(mapPath, "utf-8");
    const map: Record<string, string> = JSON.parse(raw);
    return `${channel}:${senderId}` in map;
  } catch {
    return false;
  }
}

// ─── Plugin Definition ───

const smsPairingPlugin = {
  id: "openclaw-sms-pairing",
  name: "SMS Pairing",
  description: "Self-service SMS verification for user onboarding",
  version: "0.1.0",
  configSchema: smsPairingConfigSchema,

  register(api: OpenClawPluginApi) {
    // ─── Parse & validate config ───
    const cfg: SmsPairingConfig = smsPairingConfigSchema.parse(api.pluginConfig);

    if (!cfg.sms.accessKeyId || !cfg.sms.accessKeySecret) {
      api.logger.warn("openclaw-sms-pairing: SMS credentials not configured — plugin will not send SMS");
    }
    if (!cfg.sms.signName || !cfg.sms.templateCode) {
      api.logger.warn("openclaw-sms-pairing: signName or templateCode missing — SMS sending will fail");
    }

    // ─── Initialize modules ───
    const stateMachine = new VerificationStateMachine({
      expiryMs: cfg.expiryMs,
      maxAttempts: cfg.maxCodeAttempts,
    });

    const rateLimiter = new RateLimiter({
      resendIntervalSeconds: cfg.rateLimit.resendIntervalSeconds,
      maxAttemptsPerHour: cfg.rateLimit.maxAttemptsPerHour,
      maxDailyTotal: cfg.rateLimit.maxDailyTotal,
    });

    const smsClient = new SmsClient({
      endpoint: cfg.sms.endpoint,
      accessKeyId: cfg.sms.accessKeyId,
      accessKeySecret: cfg.sms.accessKeySecret,
      signName: cfg.sms.signName,
      templateCode: cfg.sms.templateCode,
      templateParamKey: cfg.sms.templateParamKey,
    });

    const profileWriter = new ProfileWriter(cfg.profiles.dataDir);

    // ─── Periodic cleanup ───
    let cleanupTimer: ReturnType<typeof setInterval> | null = null;

    // ─── Hook: before_prompt_build — gate unverified users ───
    api.on("before_prompt_build", async (_event, ctx) => {
      const identity = extractIdentity(ctx);
      if (!identity) {
        api.logger.debug?.("openclaw-sms-pairing: no identity in context, skipping gate");
        return;
      }

      const { channel, senderId } = identity;

      if (hasProfile(cfg.profiles.dataDir, channel, senderId)) {
        // User already verified — do nothing
        return;
      }

      api.logger.info(
        `openclaw-sms-pairing: unverified user ${channel}:${senderId}, injecting verification prompt`,
      );

      return {
        prependContext: VERIFICATION_PROMPT,
      };
    });

    // ─── Tool factory ───
    const toolFactory = (ctx: ToolContext) => {
      const identity = extractIdentity(ctx);
      const channel = identity?.channel ?? "unknown";
      const senderId = identity?.senderId ?? "anonymous";
      const senderKey = `${channel}:${senderId}`;

      // ── sms_send_code ──
      const smsSendCodeTool = {
        name: "sms_send_code",
        label: "Send SMS Verification Code",
        description:
          "Send an SMS verification code to the user's mobile number. Use when the user provides their phone number for verification.",
        parameters: Type.Object({
          mobile: Type.String({ description: "User's mobile phone number" }),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const rawMobile = String(params.mobile ?? "");
          const mobile = normalizeMobile(rawMobile);

          if (!mobile) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `手机号格式不正确："${rawMobile}"。请提供11位中国大陆手机号。`,
                },
              ],
            };
          }

          // Rate limit check
          const rateCheck = rateLimiter.check(senderKey, mobile);
          if (!rateCheck.allowed) {
            const messages: Record<string, string> = {
              resend_cooldown: "发送太频繁，请稍后再试。",
              phone_hourly_limit: "该号码本小时发送次数已达上限，请稍后再试。",
              daily_global_limit: "系统今日发送量已达上限，请明天再试。",
            };
            return {
              content: [
                {
                  type: "text" as const,
                  text: messages[rateCheck.reason] ?? "发送受限，请稍后再试。",
                },
              ],
            };
          }

          // Create verification state (generates code)
          const state = stateMachine.create(channel, senderId, mobile);

          // Send SMS
          const result = await smsClient.sendVerificationSms(mobile, state.code);

          if (!result.success) {
            api.logger.warn(
              `openclaw-sms-pairing: SMS send failed for ${maskMobile(mobile)}: ${result.code} ${result.message}`,
            );
            // Clean up state on send failure
            stateMachine.complete(channel, senderId);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `短信发送失败，请稍后再试。(${result.code ?? "UNKNOWN"})`,
                },
              ],
            };
          }

          // Record the send for rate limiting
          rateLimiter.recordSend(senderKey, mobile);

          api.logger.info(
            `openclaw-sms-pairing: SMS sent to ${maskMobile(mobile)} for ${channel}:${senderId}`,
          );

          return {
            content: [
              {
                type: "text" as const,
                text: `验证码已发送到 ${maskMobile(mobile)}，请告诉我你收到的6位验证码。`,
              },
            ],
          };
        },
      };

      // ── sms_verify_code ──
      const smsVerifyCodeTool = {
        name: "sms_verify_code",
        label: "Verify SMS Code",
        description:
          "Verify the SMS code that the user received. Use when the user provides a verification code.",
        parameters: Type.Object({
          code: Type.String({ description: "The 6-digit verification code from SMS" }),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const code = String(params.code ?? "").trim();

          if (!code) {
            return {
              content: [
                { type: "text" as const, text: "请提供验证码。" },
              ],
            };
          }

          const currentState = stateMachine.get(channel, senderId);
          if (!currentState) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "没有找到待验证的记录，可能已过期。请重新发送验证码。",
                },
              ],
            };
          }

          const result = stateMachine.verify(channel, senderId, code);

          switch (result) {
            case "success": {
              // Create or link profile
              const mobile = currentState.mobile;
              try {
                const profileResult = await profileWriter.createOrLinkProfile(
                  mobile,
                  channel,
                  senderId,
                );
                api.logger.info(
                  `openclaw-sms-pairing: verification success for ${maskMobile(mobile)} ` +
                    `(${channel}:${senderId}, canonicalId=${profileResult.canonicalId}, isNew=${profileResult.isNew})`,
                );
              } catch (err) {
                api.logger.warn(
                  `openclaw-sms-pairing: profile write failed after verification: ${String(err)}`,
                );
                // Verification succeeded but profile write failed — still tell user it worked
                // Profile can be repaired later
              }

              return {
                content: [
                  {
                    type: "text" as const,
                    text: "验证成功！用户手机号已确认。",
                  },
                ],
              };
            }

            case "wrong_code": {
              const remaining = cfg.maxCodeAttempts - (currentState.attempts + 1);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `验证码不正确，还可以尝试 ${remaining} 次。`,
                  },
                ],
              };
            }

            case "max_attempts":
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "验证码错误次数过多，请重新发送验证码。",
                  },
                ],
              };

            case "not_found":
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "没有找到待验证的记录，可能已过期。请重新发送验证码。",
                  },
                ],
              };
          }
        },
      };

      return [smsSendCodeTool, smsVerifyCodeTool];
    };

    api.registerTool(toolFactory, {
      names: ["sms_send_code", "sms_verify_code"],
    });

    // ─── Service lifecycle ───
    api.registerService({
      id: "openclaw-sms-pairing",
      start: async () => {
        cleanupTimer = setInterval(() => {
          stateMachine.cleanup();
          rateLimiter.cleanup();
        }, CLEANUP_INTERVAL_MS);

        // Prevent the timer from keeping the process alive
        if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
          cleanupTimer.unref();
        }

        api.logger.info(
          `openclaw-sms-pairing: started (dataDir=${cfg.profiles.dataDir})`,
        );
      },
      stop: () => {
        if (cleanupTimer) {
          clearInterval(cleanupTimer);
          cleanupTimer = null;
        }
        api.logger.info("openclaw-sms-pairing: stopped");
      },
    });

    api.logger.info("openclaw-sms-pairing: registered");
  },
};

export default smsPairingPlugin;
