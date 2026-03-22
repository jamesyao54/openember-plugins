export type SmsPairingConfig = {
  sms: {
    provider: string;
    endpoint: string;
    accessKeyId: string;
    accessKeySecret: string;
    signName: string;
    templateCode: string;
    templateParamKey: string;
  };
  profiles: {
    dataDir: string;
  };
  rateLimit: {
    resendIntervalSeconds: number;
    maxAttemptsPerHour: number;
    maxDailyTotal: number;
  };
  expiryMs: number;
  maxCodeAttempts: number;
};

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] ?? "");
}

function toNumber(val: unknown, fallback: number): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

export const smsPairingConfigSchema = {
  parse(value: unknown): SmsPairingConfig {
    const cfg = (value && typeof value === "object" && !Array.isArray(value)
      ? value : {}) as Record<string, unknown>;

    const smsRaw = (cfg.sms ?? {}) as Record<string, unknown>;
    const profilesRaw = (cfg.profiles ?? {}) as Record<string, unknown>;
    const rateLimitRaw = (cfg.rateLimit ?? {}) as Record<string, unknown>;

    return {
      sms: {
        provider: String(smsRaw.provider ?? "aliyun"),
        endpoint: String(smsRaw.endpoint ?? "dysmsapi.aliyuncs.com"),
        accessKeyId: resolveEnvVars(String(smsRaw.accessKeyId ?? "")),
        accessKeySecret: resolveEnvVars(String(smsRaw.accessKeySecret ?? "")),
        signName: String(smsRaw.signName ?? ""),
        templateCode: String(smsRaw.templateCode ?? ""),
        templateParamKey: String(smsRaw.templateParamKey ?? "code"),
      },
      profiles: {
        dataDir: resolveEnvVars(String(profilesRaw.dataDir ?? "")).replace(/^~/, process.env.HOME ?? ""),
      },
      rateLimit: {
        resendIntervalSeconds: toNumber(rateLimitRaw.resendIntervalSeconds, 60),
        maxAttemptsPerHour: toNumber(rateLimitRaw.maxAttemptsPerHour, 5),
        maxDailyTotal: toNumber(rateLimitRaw.maxDailyTotal, 200),
      },
      expiryMs: toNumber(cfg.expiryMs, 300_000),
      maxCodeAttempts: toNumber(cfg.maxCodeAttempts, 5),
    };
  },

  uiHints: {
    "sms.accessKeyId": { label: "Aliyun Access Key ID", sensitive: true, placeholder: "${ALIYUN_ACCESS_KEY_ID}" },
    "sms.accessKeySecret": { label: "Aliyun Access Key Secret", sensitive: true, placeholder: "${ALIYUN_ACCESS_KEY_SECRET}" },
    "sms.signName": { label: "SMS Sign Name" },
    "sms.templateCode": { label: "SMS Template Code" },
    "profiles.dataDir": { label: "User Profiles Directory", placeholder: "${OPENCLAW_IDENTITY_DIR}/users" },
  },
};
