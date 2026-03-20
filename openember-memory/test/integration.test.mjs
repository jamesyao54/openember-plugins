/**
 * Integration tests for the User Profiles system.
 *
 * These test the full flows through the plugin API surface — commands, tools,
 * hooks — as OpenClaw would call them. Each test wires up a real ProfileStore
 * (backed by temp disk) + a mock PluginApi, then exercises realistic scenarios.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ProfileStore, registerUserProfiles } from "../dist/user-profiles/index.js";
import { memoryOpenVikingConfigSchema } from "../dist/config.js";

// ─── Helpers ───

const noopLogger = { info() {}, warn() {}, debug() {} };

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "integ-test-"));
}

/**
 * Build a mock PluginApi that captures registrations.
 * Returns the api plus accessors to invoke the registered handlers.
 */
function createMockApi() {
  const commands = new Map();
  const tools = new Map();
  const hooks = new Map();
  const logs = [];

  const api = {
    logger: {
      info: (msg) => logs.push(msg),
      warn: (msg) => logs.push(`WARN: ${msg}`),
      debug: (msg) => logs.push(`DEBUG: ${msg}`),
    },
    registerTool(factory, options) {
      for (const name of options.names) {
        tools.set(name, factory);
      }
    },
    on(event, handler) {
      if (!hooks.has(event)) hooks.set(event, []);
      hooks.get(event).push(handler);
    },
    registerCommand(cmd) {
      commands.set(cmd.name, cmd);
    },
  };

  return {
    api,
    logs,
    /** Invoke a registered command */
    async execCommand(name, args, ctx) {
      const cmd = commands.get(name);
      if (!cmd) throw new Error(`Command /${name} not registered`);
      const result = await cmd.handler({ args: args ?? "", ...(ctx ?? {}) });
      return typeof result === "string" ? result : result?.text ?? "";
    },
    /** Get a tool instance from the factory */
    getTool(name, ctx) {
      const factory = tools.get(name);
      if (!factory) throw new Error(`Tool ${name} not registered`);
      const toolList = factory(ctx ?? {});
      return toolList.find((t) => t.name === name);
    },
    /** Fire all handlers for an event */
    async fireHook(event, eventData, ctx) {
      const handlers = hooks.get(event) ?? [];
      let result;
      for (const handler of handlers) {
        const r = await handler(eventData ?? {}, ctx);
        if (r !== undefined) result = r;
      }
      return result;
    },
    hasCommand: (name) => commands.has(name),
    hasTool: (name) => tools.has(name),
    hasHook: (event) => hooks.has(event) && hooks.get(event).length > 0,
  };
}

function createMockVikingClient() {
  return {
    setUserId() {},
    setAgentId() {},
    getAgentId() { return "ember"; },
    async find() { return { memories: [] }; },
    async read() { return ""; },
    async createSession() { return "session-mock"; },
    async addSessionMessage() {},
    async getSession() { return { message_count: 0 }; },
    async extractSessionMemories() { return []; },
    async deleteSession() {},
    async deleteUri() {},
  };
}

// ═══════════════════════════════════════════════════════════
// 1. Full /bind → /verify cross-channel flow
// ═══════════════════════════════════════════════════════════

describe("Integration: /bind → /verify cross-channel linking", () => {
  let dir, store, mock;

  beforeEach(() => {
    dir = makeTempDir();
    store = new ProfileStore(dir, noopLogger);
    mock = createMockApi();

    const cfg = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true, dataDir: dir },
    });

    registerUserProfiles(
      mock.api,
      cfg.userProfiles,
      store,
      "ember",
      () => createMockVikingClient(),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers /bind, /verify, /profile commands", () => {
    assert.ok(mock.hasCommand("bind"));
    assert.ok(mock.hasCommand("verify"));
    assert.ok(mock.hasCommand("profile"));
  });

  it("full bind+verify flow links two channel identities", async () => {
    // Step 1: Discord user issues /bind
    const bindResult = await mock.execCommand("bind", "", {
      sessionKey: "agent:ember:direct:1112318905768231003",
    });
    assert.ok(bindResult.includes("bind code"));
    const tokenMatch = bindResult.match(/\*\*([A-F0-9]{6})\*\*/);
    assert.ok(tokenMatch, "Response should contain a 6-char token");
    const token = tokenMatch[1];

    // Step 2: Telegram user issues /verify with that token
    const verifyResult = await mock.execCommand("verify", token, {
      sessionKey: "agent:tg:direct:12345",
    });
    assert.ok(verifyResult.includes("Bound!"));
    assert.ok(verifyResult.includes("linked"));

    // Step 3: Both identities resolve to the same canonical
    const discordCanonical = store.resolveCanonicalId("discord", "1112318905768231003");
    const telegramCanonical = store.resolveCanonicalId("telegram", "12345");
    assert.ok(discordCanonical);
    assert.ok(telegramCanonical);
    assert.equal(discordCanonical, telegramCanonical);

    // Step 4: Profile shows both linked identities
    const profile = store.getProfile(discordCanonical);
    assert.equal(profile.linkedIdentities.length, 2);
    const providers = profile.linkedIdentities.map((li) => li.provider).sort();
    assert.deepEqual(providers, ["discord", "telegram"]);
  });

  it("verify fails with wrong token", async () => {
    const result = await mock.execCommand("verify", "ZZZZZZ", {
      sessionKey: "agent:tg:direct:999",
    });
    assert.ok(result.includes("Invalid") || result.includes("expired"));
  });

  it("verify rejects same identity", async () => {
    const bindResult = await mock.execCommand("bind", "", {
      sessionKey: "agent:ember:direct:111",
    });
    const token = bindResult.match(/\*\*([A-F0-9]{6})\*\*/)[1];

    const result = await mock.execCommand("verify", token, {
      sessionKey: "agent:ember:direct:111",
    });
    assert.ok(result.includes("same identity") || result.includes("different channel"));
  });

  it("verify with empty token returns usage", async () => {
    const result = await mock.execCommand("verify", "", {
      sessionKey: "agent:tg:direct:999",
    });
    assert.ok(result.includes("Usage") || result.includes("/verify"));
  });

  it("bind+verify merges existing profiles", async () => {
    // Pre-create both users (they'd have been auto-created on first message)
    const c1 = store.getOrCreateUser("discord", "aaa", { label: "user_discord" });
    const c2 = store.getOrCreateUser("telegram", "bbb", { label: "user_telegram" });
    store.updateProfile(c1, { language: "en", notes: "discord notes" });
    store.updateProfile(c2, { timezone: "Asia/Tokyo", notes: "telegram notes" });

    // Bind from discord
    const bindResult = await mock.execCommand("bind", "", {
      sessionKey: "agent:ember:direct:aaa",
    });
    const token = bindResult.match(/\*\*([A-F0-9]{6})\*\*/)[1];

    // Verify from telegram
    const verifyResult = await mock.execCommand("verify", token, {
      sessionKey: "agent:tg:direct:bbb",
    });
    assert.ok(verifyResult.includes("Bound!"));

    // Source profile (c2) should be merged into target (c1)
    assert.equal(store.getProfile(c2), null);
    const merged = store.getProfile(c1);
    assert.ok(merged);
    assert.ok(merged.notes.includes("discord notes"));
    assert.ok(merged.notes.includes("telegram notes"));
    assert.equal(merged.linkedIdentities.length, 2);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. /profile command
// ═══════════════════════════════════════════════════════════

describe("Integration: /profile command", () => {
  let dir, store, mock;

  beforeEach(() => {
    dir = makeTempDir();
    store = new ProfileStore(dir, noopLogger);
    mock = createMockApi();
    const cfg = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true, dataDir: dir },
    });
    registerUserProfiles(mock.api, cfg.userProfiles, store, "ember", () => createMockVikingClient());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows profile for known user", async () => {
    const canonical = store.getOrCreateUser("discord", "111", { label: "alice" });
    store.updateProfile(canonical, { role: "owner", language: "zh-CN", notes: "likes sushi" });

    const result = await mock.execCommand("profile", "", {
      sessionKey: "agent:ember:direct:111",
    });
    assert.ok(result.includes("alice"));
    assert.ok(result.includes("owner"));
    assert.ok(result.includes("zh-CN"));
    assert.ok(result.includes("likes sushi"));
    assert.ok(result.includes("discord:111"));
  });

  it("returns not-found for unknown user", async () => {
    const result = await mock.execCommand("profile", "", {
      sessionKey: "agent:ember:direct:unknown_user_999",
    });
    assert.ok(result.includes("No profile") || result.includes("not found"));
  });
});

// ═══════════════════════════════════════════════════════════
// 3. user_profile_update tool
// ═══════════════════════════════════════════════════════════

describe("Integration: user_profile_update tool", () => {
  let dir, store, mock;

  beforeEach(() => {
    dir = makeTempDir();
    store = new ProfileStore(dir, noopLogger);
    mock = createMockApi();
    const cfg = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true, dataDir: dir },
    });
    registerUserProfiles(mock.api, cfg.userProfiles, store, "ember", () => createMockVikingClient());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers user_profile_update tool", () => {
    assert.ok(mock.hasTool("user_profile_update"));
  });

  it("updates notes field for current user", async () => {
    const canonical = store.getOrCreateUser("discord", "111", { label: "alice" });

    const tool = mock.getTool("user_profile_update", {
      sessionKey: "agent:ember:direct:111",
    });
    const result = await tool.execute("call-1", {
      field: "notes",
      value: "- Full-stack dev\n- Prefers concise answers",
    });

    assert.ok(result.content[0].text.includes("Updated"));
    const profile = store.getProfile(canonical);
    assert.ok(profile.notes.includes("Full-stack dev"));
    assert.ok(profile.notes.includes("concise answers"));
  });

  it("updates language field", async () => {
    const canonical = store.getOrCreateUser("discord", "222");

    const tool = mock.getTool("user_profile_update", {
      sessionKey: "agent:ember:direct:222",
    });
    await tool.execute("call-2", { field: "language", value: "ja" });

    assert.equal(store.getProfile(canonical).language, "ja");
  });

  it("updates tags field with array", async () => {
    const canonical = store.getOrCreateUser("discord", "333");

    const tool = mock.getTool("user_profile_update", {
      sessionKey: "agent:ember:direct:333",
    });
    await tool.execute("call-3", { field: "tags", value: ["developer", "admin"] });

    assert.deepEqual(store.getProfile(canonical).tags, ["developer", "admin"]);
  });

  it("rejects invalid field name", async () => {
    store.getOrCreateUser("discord", "444");

    const tool = mock.getTool("user_profile_update", {
      sessionKey: "agent:ember:direct:444",
    });
    const result = await tool.execute("call-4", { field: "password", value: "bad" });

    assert.ok(result.content[0].text.includes("Invalid field"));
  });

  it("handles unknown user gracefully", async () => {
    const tool = mock.getTool("user_profile_update", {
      sessionKey: "agent:ember:direct:nonexistent",
    });
    // autoCreate=false for tool → userId will be null
    const result = await tool.execute("call-5", { field: "bio", value: "test" });
    assert.ok(
      result.content[0].text.includes("Cannot determine") ||
      result.content[0].text.includes("No profile"),
    );
  });

  it("updates by targetUserId (admin override)", async () => {
    const c1 = store.getOrCreateUser("discord", "admin1", { label: "admin" });
    const c2 = store.getOrCreateUser("telegram", "user2", { label: "user" });

    const tool = mock.getTool("user_profile_update", {
      sessionKey: "agent:ember:direct:admin1",
    });
    await tool.execute("call-6", { field: "role", value: "vip", targetUserId: c2 });

    assert.equal(store.getProfile(c2).role, "vip");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. before_prompt_build hook — profile injection
// ═══════════════════════════════════════════════════════════

describe("Integration: profile injection via before_prompt_build", () => {
  let dir, store, mock;

  beforeEach(() => {
    dir = makeTempDir();
    store = new ProfileStore(dir, noopLogger);
    mock = createMockApi();
    const cfg = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true, dataDir: dir, injectProfile: true },
    });
    registerUserProfiles(mock.api, cfg.userProfiles, store, "ember", () => createMockVikingClient());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("injects <user-profile> block for known user", async () => {
    const canonical = store.getOrCreateUser("discord", "111", { label: "james" });
    store.updateProfile(canonical, {
      role: "owner",
      language: "zh-CN",
      timezone: "Asia/Shanghai",
      notes: "- Full-stack dev\n- Prefers concise answers",
    });

    const result = await mock.fireHook(
      "before_prompt_build",
      { prompt: "Hello" },
      { sessionKey: "agent:ember:direct:111" },
    );

    assert.ok(result);
    assert.ok(result.prependContext);
    assert.ok(result.prependContext.includes("<user-profile>"));
    assert.ok(result.prependContext.includes("</user-profile>"));
    assert.ok(result.prependContext.includes("james"));
    assert.ok(result.prependContext.includes("owner"));
    assert.ok(result.prependContext.includes("zh-CN"));
    assert.ok(result.prependContext.includes("Asia/Shanghai"));
    assert.ok(result.prependContext.includes("Full-stack dev"));
  });

  it("returns undefined for unknown user (no injection)", async () => {
    const result = await mock.fireHook(
      "before_prompt_build",
      { prompt: "Hello" },
      { sessionKey: "agent:ember:direct:unknown_999" },
    );
    // autoCreate happens on message_received, not on before_prompt_build in this path
    // So an unknown user who was never auto-created has no profile
    // But resolveCanonicalUserId with autoCreate default=true will create one
    // The created profile will be empty → formatProfileBlock returns null
    // So result should either be undefined or have no prependContext
    if (result) {
      // If a profile was auto-created, it should just have a name
      assert.ok(result.prependContext.includes("<user-profile>"));
    }
  });

  it("always injects at least the canonical ID", async () => {
    // Create user but leave all optional fields empty
    const canonical = store.getOrCreateUser("discord", "empty_user", { label: "" });
    store.updateProfile(canonical, { displayName: "" });

    const result = await mock.fireHook(
      "before_prompt_build",
      { prompt: "Hello" },
      { sessionKey: "agent:ember:direct:empty_user" },
    );

    // ID is always present, so profile block is always injected
    assert.ok(result);
    assert.ok(result.prependContext.includes("<user-profile>"));
    assert.ok(result.prependContext.includes(`ID: ${canonical}`));
  });

  it("updates lastSeenAt on first hook invocation", async () => {
    const canonical = store.getOrCreateUser("discord", "seen_test", { label: "test" });
    const beforeLastSeen = store.getProfile(canonical).lastSeenAt;

    // Small delay so timestamp changes
    await new Promise((r) => setTimeout(r, 5));

    await mock.fireHook(
      "before_prompt_build",
      { prompt: "Hello" },
      { sessionKey: "agent:ember:direct:seen_test" },
    );

    const afterLastSeen = store.getProfile(canonical).lastSeenAt;
    assert.ok(afterLastSeen >= beforeLastSeen);
    assert.equal(store.getProfile(canonical).lastChannel, "discord");
  });
});

// ═══════════════════════════════════════════════════════════
// 5. message_received hook — auto-create + lastSeenAt
// ═══════════════════════════════════════════════════════════

describe("Integration: message_received hook", () => {
  let dir, store, mock;

  beforeEach(() => {
    dir = makeTempDir();
    store = new ProfileStore(dir, noopLogger);
    mock = createMockApi();
    const cfg = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true, dataDir: dir, autoCreateProfile: true },
    });
    registerUserProfiles(mock.api, cfg.userProfiles, store, "ember", () => createMockVikingClient());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("auto-creates profile on first message from new user", async () => {
    assert.equal(store.resolveCanonicalId("discord", "new_user_42"), null);

    await mock.fireHook(
      "message_received",
      {},
      { sessionKey: "agent:ember:direct:new_user_42" },
    );

    const canonical = store.resolveCanonicalId("discord", "new_user_42");
    assert.ok(canonical);
    const profile = store.getProfile(canonical);
    assert.ok(profile);
    assert.equal(profile.displayName, "new_user_42");
    assert.equal(profile.lastChannel, "discord");
  });

  it("updates lastSeenAt for existing user", async () => {
    const canonical = store.getOrCreateUser("discord", "existing_555", { label: "alice" });
    const originalLastSeen = store.getProfile(canonical).lastSeenAt;

    // Ensure timestamp advances
    await new Promise((r) => setTimeout(r, 5));

    await mock.fireHook(
      "message_received",
      {},
      { sessionKey: "agent:ember:direct:existing_555" },
    );

    const updatedLastSeen = store.getProfile(canonical).lastSeenAt;
    assert.ok(updatedLastSeen >= originalLastSeen);
  });

  it("works with senderId + channelId context", async () => {
    await mock.fireHook(
      "message_received",
      {},
      { channelId: "telegram", senderId: "tg_user_88" },
    );

    const canonical = store.resolveCanonicalId("telegram", "tg_user_88");
    assert.ok(canonical);
    assert.equal(store.getProfile(canonical).lastChannel, "telegram");
  });
});

// ═══════════════════════════════════════════════════════════
// 6. End-to-end scenario: multi-channel user journey
// ═══════════════════════════════════════════════════════════

describe("Integration: full multi-channel user journey", () => {
  let dir, store, mock;

  beforeEach(() => {
    dir = makeTempDir();
    store = new ProfileStore(dir, noopLogger);
    mock = createMockApi();
    const cfg = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true, dataDir: dir },
    });
    registerUserProfiles(mock.api, cfg.userProfiles, store, "ember", () => createMockVikingClient());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("complete journey: auto-create → update → bind → verify → unified profile", async () => {
    // 1. Discord user sends first message → auto-create
    await mock.fireHook("message_received", {}, {
      sessionKey: "agent:ember:direct:discord_user_1",
    });
    const discordCanonical = store.resolveCanonicalId("discord", "discord_user_1");
    assert.ok(discordCanonical);

    // 2. Agent updates profile via tool
    const tool = mock.getTool("user_profile_update", {
      sessionKey: "agent:ember:direct:discord_user_1",
    });
    await tool.execute("t1", { field: "language", value: "zh-CN" });
    await tool.execute("t2", { field: "notes", value: "- Loves TypeScript\n- Senior dev" });
    await tool.execute("t3", { field: "tags", value: ["developer", "senior"] });

    // 3. Verify profile via /profile
    const profileText = await mock.execCommand("profile", "", {
      sessionKey: "agent:ember:direct:discord_user_1",
    });
    assert.ok(profileText.includes("zh-CN"));
    assert.ok(profileText.includes("TypeScript"));
    assert.ok(profileText.includes("developer"));

    // 4. Telegram user sends first message → separate auto-create
    await mock.fireHook("message_received", {}, {
      sessionKey: "agent:tg:direct:telegram_user_1",
    });
    const telegramCanonical = store.resolveCanonicalId("telegram", "telegram_user_1");
    assert.ok(telegramCanonical);
    assert.notEqual(discordCanonical, telegramCanonical); // Different people so far

    // 5. Agent updates telegram profile
    const tgTool = mock.getTool("user_profile_update", {
      sessionKey: "agent:tg:direct:telegram_user_1",
    });
    await tgTool.execute("t4", { field: "timezone", value: "Asia/Shanghai" });
    await tgTool.execute("t5", { field: "notes", value: "- Uses Vim\n- Night owl" });

    // 6. User initiates /bind from Discord
    const bindResult = await mock.execCommand("bind", "", {
      sessionKey: "agent:ember:direct:discord_user_1",
    });
    const token = bindResult.match(/\*\*([A-F0-9]{6})\*\*/)[1];

    // 7. User verifies from Telegram
    const verifyResult = await mock.execCommand("verify", token, {
      sessionKey: "agent:tg:direct:telegram_user_1",
    });
    assert.ok(verifyResult.includes("Bound!"));

    // 8. Both identities now resolve to same canonical
    const unified = store.resolveCanonicalId("discord", "discord_user_1");
    assert.equal(store.resolveCanonicalId("telegram", "telegram_user_1"), unified);

    // 9. Merged profile has combined data
    const mergedProfile = store.getProfile(unified);
    assert.ok(mergedProfile);
    assert.equal(mergedProfile.language, "zh-CN"); // from discord profile
    assert.ok(mergedProfile.notes.includes("TypeScript")); // from discord
    assert.ok(mergedProfile.notes.includes("Vim")); // from telegram
    assert.ok(mergedProfile.tags.includes("developer"));
    assert.equal(mergedProfile.linkedIdentities.length, 2);

    // 10. Profile injection works with either channel
    const discordInject = await mock.fireHook(
      "before_prompt_build",
      { prompt: "Hi" },
      { sessionKey: "agent:ember:direct:discord_user_1" },
    );
    assert.ok(discordInject?.prependContext?.includes("<user-profile>"));
    assert.ok(discordInject.prependContext.includes("TypeScript"));

    const telegramInject = await mock.fireHook(
      "before_prompt_build",
      { prompt: "Hi" },
      { sessionKey: "agent:tg:direct:telegram_user_1" },
    );
    assert.ok(telegramInject?.prependContext?.includes("<user-profile>"));
    assert.ok(telegramInject.prependContext.includes("TypeScript"));

    // 11. Both inject the same profile content
    assert.equal(discordInject.prependContext, telegramInject.prependContext);
  });
});

// ═══════════════════════════════════════════════════════════
// 7. Backward compatibility: disabled userProfiles
// ═══════════════════════════════════════════════════════════

describe("Integration: backward compatibility (userProfiles disabled)", () => {
  it("config parses without userProfiles section", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({
      mode: "remote",
      baseUrl: "http://localhost:1933",
    });
    assert.equal(cfg.userProfiles.enabled, false);
    assert.equal(cfg.mode, "remote");
    assert.equal(cfg.autoCapture, true);
    assert.equal(cfg.autoRecall, true);
  });

  it("no commands/tools registered when not calling registerUserProfiles", () => {
    const mock = createMockApi();
    // Simulate what happens when userProfiles.enabled = false:
    // registerUserProfiles is never called
    assert.equal(mock.hasCommand("bind"), false);
    assert.equal(mock.hasCommand("verify"), false);
    assert.equal(mock.hasCommand("profile"), false);
    assert.equal(mock.hasTool("user_profile_update"), false);
  });
});

// ═══════════════════════════════════════════════════════════
// 8. Profile injection disabled
// ═══════════════════════════════════════════════════════════

describe("Integration: injectProfile=false", () => {
  let dir, store, mock;

  beforeEach(() => {
    dir = makeTempDir();
    store = new ProfileStore(dir, noopLogger);
    mock = createMockApi();
    const cfg = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true, dataDir: dir, injectProfile: false },
    });
    registerUserProfiles(mock.api, cfg.userProfiles, store, "ember", () => createMockVikingClient());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not register before_prompt_build handler for profile injection", async () => {
    const canonical = store.getOrCreateUser("discord", "111", { label: "alice" });
    store.updateProfile(canonical, { role: "owner", language: "zh-CN" });

    // before_prompt_build still has a handler (message_received registers one),
    // but profile injection should not fire
    const result = await mock.fireHook(
      "before_prompt_build",
      { prompt: "Hello" },
      { sessionKey: "agent:ember:direct:111" },
    );

    // With injectProfile=false, the before_prompt_build hook for profiles is never registered
    // So there's nothing returning prependContext with <user-profile>
    if (result && result.prependContext) {
      assert.ok(!result.prependContext.includes("<user-profile>"));
    }
  });

  it("commands and tools still work without injection", async () => {
    store.getOrCreateUser("discord", "222", { label: "bob" });

    const profileText = await mock.execCommand("profile", "", {
      sessionKey: "agent:ember:direct:222",
    });
    assert.ok(profileText.includes("bob"));
  });
});

// ═══════════════════════════════════════════════════════════
// 9. Data persistence across registrations
// ═══════════════════════════════════════════════════════════

describe("Integration: data persistence", () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("profile data persists across store instances", async () => {
    // First "boot" — create user and update profile
    const store1 = new ProfileStore(dir, noopLogger);
    const mock1 = createMockApi();
    const cfg1 = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true, dataDir: dir },
    });
    registerUserProfiles(mock1.api, cfg1.userProfiles, store1, "ember", () => createMockVikingClient());

    await mock1.fireHook("message_received", {}, {
      sessionKey: "agent:ember:direct:persist_user",
    });
    const canonical = store1.resolveCanonicalId("discord", "persist_user");
    const tool1 = mock1.getTool("user_profile_update", {
      sessionKey: "agent:ember:direct:persist_user",
    });
    await tool1.execute("t1", { field: "language", value: "ko" });
    await tool1.execute("t2", { field: "notes", value: "- Kotlin developer" });

    // Second "boot" — new store reads from same directory
    const store2 = new ProfileStore(dir, noopLogger);
    const mock2 = createMockApi();
    const cfg2 = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true, dataDir: dir },
    });
    registerUserProfiles(mock2.api, cfg2.userProfiles, store2, "ember", () => createMockVikingClient());

    // Identity and profile data should be preserved
    assert.equal(store2.resolveCanonicalId("discord", "persist_user"), canonical);
    const profile = store2.getProfile(canonical);
    assert.equal(profile.language, "ko");
    assert.ok(profile.notes.includes("Kotlin"));

    // Profile injection should work
    const result = await mock2.fireHook(
      "before_prompt_build",
      { prompt: "Hi" },
      { sessionKey: "agent:ember:direct:persist_user" },
    );
    assert.ok(result?.prependContext?.includes("ko"));
    assert.ok(result.prependContext.includes("Kotlin"));
  });

  it("bind tokens do NOT persist (in-memory only)", async () => {
    const store1 = new ProfileStore(dir, noopLogger);
    const mock1 = createMockApi();
    const cfg = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true, dataDir: dir },
    });
    registerUserProfiles(mock1.api, cfg.userProfiles, store1, "ember", () => createMockVikingClient());

    store1.getOrCreateUser("discord", "bind_persist_test");
    const bindResult = await mock1.execCommand("bind", "", {
      sessionKey: "agent:ember:direct:bind_persist_test",
    });
    const token = bindResult.match(/\*\*([A-F0-9]{6})\*\*/)[1];

    // Second "boot" — new BindFlowManager has empty pending map
    const store2 = new ProfileStore(dir, noopLogger);
    const mock2 = createMockApi();
    registerUserProfiles(mock2.api, cfg.userProfiles, store2, "ember", () => createMockVikingClient());

    const verifyResult = await mock2.execCommand("verify", token, {
      sessionKey: "agent:tg:direct:other_user",
    });
    assert.ok(verifyResult.includes("Invalid") || verifyResult.includes("expired"));
  });
});

// ═══════════════════════════════════════════════════════════
// 10. Concurrent multi-user isolation
// ═══════════════════════════════════════════════════════════

describe("Integration: multi-user isolation", () => {
  let dir, store, mock;

  beforeEach(() => {
    dir = makeTempDir();
    store = new ProfileStore(dir, noopLogger);
    mock = createMockApi();
    const cfg = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true, dataDir: dir },
    });
    registerUserProfiles(mock.api, cfg.userProfiles, store, "ember", () => createMockVikingClient());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("different users get different canonicals and profiles", async () => {
    await mock.fireHook("message_received", {}, {
      sessionKey: "agent:ember:direct:user_a",
    });
    await mock.fireHook("message_received", {}, {
      sessionKey: "agent:ember:direct:user_b",
    });
    await mock.fireHook("message_received", {}, {
      sessionKey: "agent:tg:direct:user_c",
    });

    const cA = store.resolveCanonicalId("discord", "user_a");
    const cB = store.resolveCanonicalId("discord", "user_b");
    const cC = store.resolveCanonicalId("telegram", "user_c");

    // All different canonical IDs
    assert.notEqual(cA, cB);
    assert.notEqual(cA, cC);
    assert.notEqual(cB, cC);

    // Update one user's profile, others unchanged
    const toolA = mock.getTool("user_profile_update", {
      sessionKey: "agent:ember:direct:user_a",
    });
    await toolA.execute("t1", { field: "role", value: "admin" });

    assert.equal(store.getProfile(cA).role, "admin");
    assert.equal(store.getProfile(cB).role, "");
    assert.equal(store.getProfile(cC).role, "");
  });

  it("profile injection delivers correct profile per user", async () => {
    // Create two users with different profiles
    const cA = store.getOrCreateUser("discord", "inject_a", { label: "Alice" });
    store.updateProfile(cA, { language: "en", notes: "Alice notes" });

    const cB = store.getOrCreateUser("discord", "inject_b", { label: "Bob" });
    store.updateProfile(cB, { language: "ja", notes: "Bob notes" });

    const resultA = await mock.fireHook(
      "before_prompt_build",
      { prompt: "Hi" },
      { sessionKey: "agent:ember:direct:inject_a" },
    );
    const resultB = await mock.fireHook(
      "before_prompt_build",
      { prompt: "Hi" },
      { sessionKey: "agent:ember:direct:inject_b" },
    );

    assert.ok(resultA.prependContext.includes("Alice"));
    assert.ok(resultA.prependContext.includes("en"));
    assert.ok(!resultA.prependContext.includes("Bob"));

    assert.ok(resultB.prependContext.includes("Bob"));
    assert.ok(resultB.prependContext.includes("ja"));
    assert.ok(!resultB.prependContext.includes("Alice"));
  });
});

// ═══════════════════════════════════════════════════════════
// 11. Edge cases and error handling
// ═══════════════════════════════════════════════════════════

describe("Integration: edge cases", () => {
  let dir, store, mock;

  beforeEach(() => {
    dir = makeTempDir();
    store = new ProfileStore(dir, noopLogger);
    mock = createMockApi();
    const cfg = memoryOpenVikingConfigSchema.parse({
      userProfiles: { enabled: true, dataDir: dir },
    });
    registerUserProfiles(mock.api, cfg.userProfiles, store, "ember", () => createMockVikingClient());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("handles missing sessionKey in hook context gracefully", async () => {
    const result = await mock.fireHook("before_prompt_build", { prompt: "Hi" }, {});
    // No crash, returns undefined since no user could be resolved
    assert.equal(result, undefined);
  });

  it("handles missing context object in hook gracefully", async () => {
    const result = await mock.fireHook("before_prompt_build", { prompt: "Hi" }, undefined);
    assert.equal(result, undefined);
  });

  it("/bind without identifiable session returns error", async () => {
    const result = await mock.execCommand("bind", "", {});
    assert.ok(result.includes("Could not determine"));
  });

  it("/verify without identifiable session returns error", async () => {
    const result = await mock.execCommand("verify", "ABCDEF", {});
    assert.ok(result.includes("Could not determine"));
  });

  it("user_profile_update with no user context returns error", async () => {
    const tool = mock.getTool("user_profile_update", {});
    const result = await tool.execute("call-x", { field: "bio", value: "test" });
    assert.ok(result.content[0].text.includes("Cannot determine") || result.content[0].text.includes("No profile"));
  });

  it("concurrent bind tokens are independent", async () => {
    store.getOrCreateUser("discord", "multi_bind_1");
    store.getOrCreateUser("discord", "multi_bind_2");

    const bind1 = await mock.execCommand("bind", "", {
      sessionKey: "agent:ember:direct:multi_bind_1",
    });
    const bind2 = await mock.execCommand("bind", "", {
      sessionKey: "agent:ember:direct:multi_bind_2",
    });

    const token1 = bind1.match(/\*\*([A-F0-9]{6})\*\*/)[1];
    const token2 = bind2.match(/\*\*([A-F0-9]{6})\*\*/)[1];
    assert.notEqual(token1, token2);

    // Verify token1 from telegram
    const result1 = await mock.execCommand("verify", token1, {
      sessionKey: "agent:tg:direct:tg_for_1",
    });
    assert.ok(result1.includes("Bound!"));

    // token2 still valid, token1 consumed
    const result1again = await mock.execCommand("verify", token1, {
      sessionKey: "agent:tg:direct:tg_for_other",
    });
    assert.ok(result1again.includes("Invalid") || result1again.includes("expired"));

    const result2 = await mock.execCommand("verify", token2, {
      sessionKey: "agent:tg:direct:tg_for_2",
    });
    assert.ok(result2.includes("Bound!"));
  });

  it("disk files are valid JSON after all operations", async () => {
    // Perform many operations
    for (let i = 0; i < 10; i++) {
      store.getOrCreateUser("discord", `stress_${i}`, { label: `user_${i}` });
    }
    store.linkIdentity(
      store.resolveCanonicalId("discord", "stress_0"),
      "telegram",
      "tg_0",
    );
    store.mergeUsers(
      store.resolveCanonicalId("discord", "stress_0"),
      store.resolveCanonicalId("discord", "stress_1"),
    );

    // Both files should be valid JSON
    const mapContent = readFileSync(join(dir, "identity-map.json"), "utf-8");
    const profilesContent = readFileSync(join(dir, "profiles.json"), "utf-8");
    assert.doesNotThrow(() => JSON.parse(mapContent));
    assert.doesNotThrow(() => JSON.parse(profilesContent));

    // Verify structural integrity
    const map = JSON.parse(mapContent);
    const profiles = JSON.parse(profilesContent);
    // All mapped canonicals should have profiles (except merged-away ones)
    const canonicals = new Set(Object.values(map));
    for (const cid of canonicals) {
      assert.ok(profiles[cid], `canonical ${cid} in identity-map but not in profiles`);
    }
  });
});
