import { createRequire } from "module";
import * as OpenApi from "@alicloud/openapi-client";
import * as Util from "@alicloud/tea-util";

// Use createRequire to work around ESM/CJS interop issues with the Alibaba Cloud SDK
const _require = createRequire(import.meta.url);
const _dysmsapi = _require("@alicloud/dysmsapi20170525") as typeof import("@alicloud/dysmsapi20170525");
const Dysmsapi = _dysmsapi.default;
const { SendSmsRequest } = _dysmsapi;

export type SmsConfig = {
  endpoint: string;
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
  templateCode: string;
  templateParamKey: string;
};

export type SendResult = {
  success: boolean;
  code?: string;
  message?: string;
};

export class SmsClient {
  private readonly client: InstanceType<typeof Dysmsapi>;
  private readonly config: SmsConfig;

  constructor(config: SmsConfig) {
    this.config = config;
    const openApiConfig = new OpenApi.Config({
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      endpoint: config.endpoint,
    });
    this.client = new Dysmsapi(openApiConfig);
  }

  async sendVerificationSms(mobile: string, code: string): Promise<SendResult> {
    const req = this._buildRequest(mobile, code);
    const sendReq = new SendSmsRequest(req);
    const runtime = new Util.RuntimeOptions({});
    try {
      const resp = await this.client.sendSmsWithOptions(sendReq, runtime);
      const body = resp.body;
      if (!body) {
        return { success: false, code: "NO_BODY", message: "Empty response body" };
      }
      if (body.code === "OK") {
        return { success: true };
      }
      return { success: false, code: body.code ?? undefined, message: body.message ?? undefined };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, code: "SDK_ERROR", message: msg };
    }
  }

  _buildRequest(mobile: string, code: string) {
    return {
      phoneNumbers: mobile,
      signName: this.config.signName,
      templateCode: this.config.templateCode,
      templateParam: JSON.stringify({ [this.config.templateParamKey]: code }),
    };
  }
}
