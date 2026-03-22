import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SmsClient, type SmsConfig } from "../src/sms-client.js";

const testConfig: SmsConfig = {
  endpoint: "dysmsapi.aliyuncs.com",
  accessKeyId: "test-key-id",
  accessKeySecret: "test-key-secret",
  signName: "TestSign",
  templateCode: "SMS_000000",
  templateParamKey: "code",
};

describe("SmsClient", () => {
  it("constructs without error", () => {
    const client = new SmsClient(testConfig);
    assert.ok(client);
  });
  it("formats sendSms request correctly", () => {
    const client = new SmsClient(testConfig);
    const req = client._buildRequest("13812345678", "ABC123");
    assert.equal(req.phoneNumbers, "13812345678");
    assert.equal(req.signName, "TestSign");
    assert.equal(req.templateCode, "SMS_000000");
    assert.deepEqual(JSON.parse(req.templateParam!), { code: "ABC123" });
  });
});
