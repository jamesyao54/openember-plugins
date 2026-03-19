/**
 * Unit tests for openember-memory context-engine upgrade.
 * Run with: node --test test/unit.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ─── text-utils ───
import {
  getCaptureDecision,
  extractNewTurnTexts,
  extractLatestUserText,
  sanitizeUserTextForCapture,
  normalizeCaptureDedupeText,
  pickRecentUniqueTexts,
  CAPTURE_LIMIT,
} from "../dist/text-utils.js";

// ─── client ───
import { sanitizeUserId, agentSpaceName, isMemoryUri, OpenVikingClient } from "../dist/client.js";

// ─── config ───
import { DEFAULT_MEMORY_OPENVIKING_DATA_DIR, memoryOpenVikingConfigSchema } from "../dist/config.js";

// ─── user-resolve ───
import {
  extractPeerIdFromSessionKey,
  extractSenderFromPrompt,
  resolveUserId,
  resolveUserIdFromMessages,
} from "../dist/user-resolve.js";

// ─── memory-ranking ───
import { clampScore, postProcessMemories, pickMemoriesForInjection } from "../dist/memory-ranking.js";

// ─── context-engine ───
import { createOpenEmberContextEngine } from "../dist/context-engine.js";

// ════════════════════════════════════════
// text-utils
// ════════════════════════════════════════

describe("text-utils", () => {
  it("CAPTURE_LIMIT is exported and is a number", () => {
    assert.equal(typeof CAPTURE_LIMIT, "number");
    assert.ok(CAPTURE_LIMIT > 0);
  });

  it("normalizeCaptureDedupeText lowercases and collapses whitespace", () => {
    assert.equal(normalizeCaptureDedupeText("  Hello   World  "), "hello world");
    assert.equal(normalizeCaptureDedupeText("FOO\n\tBAR"), "foo bar");
  });

  it("pickRecentUniqueTexts deduplicates and respects limit", () => {
    const texts = ["Hello world", "foo bar", "Hello world", "baz qux"];
    const result = pickRecentUniqueTexts(texts, 100);
    // Walks backwards: picks baz qux, Hello world (index 2), foo bar; skips Hello world (index 0, dupe)
    assert.equal(result.length, 3);
    assert.deepEqual(result, ["foo bar", "Hello world", "baz qux"]);
  });

  it("pickRecentUniqueTexts respects character limit", () => {
    // Walks backwards: "longer..." (36 chars > 10 limit) → break immediately, returns empty
    const texts = ["short", "this is a longer string that we test"];
    const result = pickRecentUniqueTexts(texts, 10);
    assert.equal(result.length, 0);
  });

  it("getCaptureDecision accepts semantic text", () => {
    // Text must not trigger question-only detection (avoid "is", "are", "?" etc.)
    const decision = getCaptureDecision(
      "记住我喜欢寿司，我的生日在三月",
      "semantic",
      24000,
    );
    assert.ok(decision.shouldCapture);
    assert.ok(decision.reason.includes("semantic"));
  });

  it("getCaptureDecision rejects empty text", () => {
    const decision = getCaptureDecision("", "semantic", 24000);
    assert.equal(decision.shouldCapture, false);
    assert.equal(decision.reason, "empty_text");
  });

  it("getCaptureDecision rejects command text", () => {
    // "/help me" is too short (compact length < 10), gets rejected as length_out_of_range before command check
    // Use a longer command to test command_text rejection
    const decision = getCaptureDecision("/start the long process now please", "semantic", 24000);
    assert.equal(decision.shouldCapture, false);
    assert.equal(decision.reason, "command_text");
  });

  it("extractNewTurnTexts extracts from startIndex", () => {
    const messages = [
      { role: "user", content: "old message" },
      { role: "assistant", content: "old response" },
      { role: "user", content: "new question" },
      { role: "assistant", content: "new answer" },
    ];
    const { texts, newCount } = extractNewTurnTexts(messages, 2);
    assert.equal(newCount, 2);
    assert.equal(texts.length, 2);
    assert.ok(texts[0].includes("new question"));
    assert.ok(texts[1].includes("new answer"));
  });

  it("extractLatestUserText returns latest sanitized user text", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "response" },
      { role: "user", content: "latest question here" },
    ];
    const result = extractLatestUserText(messages);
    assert.equal(result, "latest question here");
  });

  it("sanitizeUserTextForCapture strips relevant-memories blocks", () => {
    const text = "Hello <relevant-memories>some injected data</relevant-memories> world";
    const result = sanitizeUserTextForCapture(text);
    assert.ok(!result.includes("relevant-memories"));
    assert.ok(result.includes("Hello"));
    assert.ok(result.includes("world"));
  });
});

// ════════════════════════════════════════
// client
// ════════════════════════════════════════

describe("client", () => {
  it("sanitizeUserId replaces colons with underscores", () => {
    assert.equal(sanitizeUserId("discord:12345"), "discord_12345");
    assert.equal(sanitizeUserId("alice"), "alice");
  });

  it("agentSpaceName returns 12-char hex hash", () => {
    const result = agentSpaceName("alice", "ember");
    assert.equal(result.length, 12);
    assert.ok(/^[0-9a-f]{12}$/.test(result));
  });

  it("agentSpaceName is deterministic", () => {
    const a = agentSpaceName("alice", "ember");
    const b = agentSpaceName("alice", "ember");
    assert.equal(a, b);
  });

  it("agentSpaceName differs for different users", () => {
    const a = agentSpaceName("alice", "ember");
    const b = agentSpaceName("bob", "ember");
    assert.notEqual(a, b);
  });

  it("isMemoryUri matches valid memory URIs", () => {
    assert.ok(isMemoryUri("viking://user/memories/abc"));
    assert.ok(isMemoryUri("viking://agent/memories/xyz"));
    assert.ok(isMemoryUri("viking://user/alice/memories/item1"));
    assert.ok(!isMemoryUri("viking://other/stuff"));
    assert.ok(!isMemoryUri("https://example.com"));
  });

  it("OpenVikingClient getAgentId returns the agent ID", () => {
    const client = new OpenVikingClient("http://localhost:1933", "", "test-agent", 5000);
    assert.equal(client.getAgentId(), "test-agent");
  });

  it("OpenVikingClient setAgentId updates the agent ID", () => {
    const client = new OpenVikingClient("http://localhost:1933", "", "agent1", 5000);
    client.setAgentId("agent2");
    assert.equal(client.getAgentId(), "agent2");
  });

  it("OpenVikingClient setAgentId ignores empty string", () => {
    const client = new OpenVikingClient("http://localhost:1933", "", "agent1", 5000);
    client.setAgentId("");
    assert.equal(client.getAgentId(), "agent1");
  });
});

// ════════════════════════════════════════
// config
// ════════════════════════════════════════

describe("config", () => {
  it("DEFAULT_MEMORY_OPENVIKING_DATA_DIR is exported", () => {
    assert.equal(typeof DEFAULT_MEMORY_OPENVIKING_DATA_DIR, "string");
    assert.ok(DEFAULT_MEMORY_OPENVIKING_DATA_DIR.includes(".openviking"));
  });

  it("memoryOpenVikingConfigSchema.parse returns defaults for empty object", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({});
    assert.equal(cfg.mode, "local");
    assert.equal(cfg.autoCapture, true);
    assert.equal(cfg.autoRecall, true);
    assert.equal(cfg.captureMode, "semantic");
    assert.equal(cfg.recallLimit, 6);
    assert.equal(typeof cfg.recallScoreThreshold, "number");
  });

  it("memoryOpenVikingConfigSchema.parse handles remote mode", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({
      mode: "remote",
      baseUrl: "http://10.0.0.1:1933",
    });
    assert.equal(cfg.mode, "remote");
    assert.equal(cfg.baseUrl, "http://10.0.0.1:1933");
  });
});

// ════════════════════════════════════════
// user-resolve
// ════════════════════════════════════════

describe("user-resolve", () => {
  it("extractPeerIdFromSessionKey extracts from direct chat key", () => {
    assert.equal(extractPeerIdFromSessionKey("agent:ember:direct:alice"), "alice");
  });

  it("extractPeerIdFromSessionKey returns null for group chat key", () => {
    assert.equal(extractPeerIdFromSessionKey("agent:ember:group:room1"), null);
  });

  it("extractPeerIdFromSessionKey returns null for undefined", () => {
    assert.equal(extractPeerIdFromSessionKey(undefined), null);
  });

  it("extractSenderFromPrompt parses Sender metadata block", () => {
    const prompt = 'Hello\nSender (untrusted metadata): ```json\n{"userId": "bob"}\n```\nHow are you?';
    assert.equal(extractSenderFromPrompt(prompt), "bob");
  });

  it("extractSenderFromPrompt parses Conversation info block", () => {
    const prompt = 'Hi\nConversation info (untrusted metadata): ```json\n{"sender_id": "carol"}\n```';
    assert.equal(extractSenderFromPrompt(prompt), "carol");
  });

  it("resolveUserId prefers sessionKey over prompt", () => {
    const result = resolveUserId(
      "agent:ember:direct:alice",
      'Sender (untrusted metadata): ```json\n{"userId": "bob"}\n```',
    );
    assert.equal(result, "alice");
  });

  it("resolveUserIdFromMessages falls back to message metadata", () => {
    const messages = [
      { role: "user", content: 'Sender (untrusted metadata): ```json\n{"userId": "dave"}\n```\nHello' },
    ];
    const result = resolveUserIdFromMessages(undefined, messages);
    assert.equal(result, "dave");
  });
});

// ════════════════════════════════════════
// memory-ranking
// ════════════════════════════════════════

describe("memory-ranking", () => {
  it("clampScore clamps to 0-1", () => {
    assert.equal(clampScore(1.5), 1);
    assert.equal(clampScore(-0.5), 0);
    assert.equal(clampScore(0.5), 0.5);
    assert.equal(clampScore(undefined), 0);
    assert.equal(clampScore(NaN), 0);
  });

  it("postProcessMemories deduplicates and filters by score", () => {
    const items = [
      { uri: "viking://user/memories/a", abstract: "fact A", score: 0.8, level: 2, category: "preferences" },
      { uri: "viking://user/memories/b", abstract: "fact A", score: 0.7, level: 2, category: "preferences" },
      { uri: "viking://user/memories/c", abstract: "fact C", score: 0.3, level: 2, category: "events" },
    ];
    const result = postProcessMemories(items, { limit: 10, scoreThreshold: 0.5 });
    assert.equal(result.length, 1);
    assert.equal(result[0].uri, "viking://user/memories/a");
  });
});

// ════════════════════════════════════════
// context-engine
// ════════════════════════════════════════

describe("context-engine", () => {
  function makeEngine(opts) {
    const logs = [];
    const capturedSessions = [];

    const cfg = memoryOpenVikingConfigSchema.parse({
      mode: "remote",
      baseUrl: "http://localhost:1933",
      autoCapture: opts?.autoCapture ?? true,
    });

    const mockClient = {
      createSession: async () => "session-123",
      addSessionMessage: async () => {},
      getSession: async () => ({ message_count: 1 }),
      extractSessionMemories: async () => opts?.extractedMemories ?? [{ uri: "viking://user/memories/new1", abstract: "test memory" }],
      deleteSession: async () => {},
      setUserId: () => {},
      setAgentId: () => {},
      getAgentId: () => "ember",
    };

    const engine = createOpenEmberContextEngine({
      cfg,
      logger: {
        info: (msg) => logs.push(msg),
        warn: (msg) => logs.push(`WARN: ${msg}`),
        debug: (msg) => logs.push(`DEBUG: ${msg}`),
      },
      getClient: async () => mockClient,
      resolveAgentId: () => "ember",
      createConfiguredClient: (userId, agentId) => {
        const client = { ...mockClient };
        client.addSessionMessage = async (_sid, _role, text) => {
          capturedSessions.push({ userId, agentId, text });
        };
        return client;
      },
      resolveUserIdFromMessages: (sessionKey) => {
        if (sessionKey === "agent:ember:direct:alice") return "alice";
        return null;
      },
    });

    return { engine, logs, capturedSessions };
  }

  it("ingest is a no-op", async () => {
    const { engine } = makeEngine();
    await engine.ingest({ data: "test" });
  });

  it("ingestBatch is a no-op", async () => {
    const { engine } = makeEngine();
    await engine.ingestBatch([{ data: "a" }, { data: "b" }]);
  });

  it("assemble passes through context", async () => {
    const { engine } = makeEngine();
    const ctx = { foo: "bar" };
    const result = await engine.assemble(ctx);
    assert.deepEqual(result, ctx);
  });

  it("afterTurn skips when autoCapture is false", async () => {
    const { engine, capturedSessions } = makeEngine({ autoCapture: false });
    await engine.afterTurn({
      messages: [
        { role: "user", content: "I love sushi" },
        { role: "assistant", content: "Good to know!" },
      ],
      prePromptMessageCount: 0,
      success: true,
    });
    assert.equal(capturedSessions.length, 0);
  });

  it("afterTurn skips when success is false", async () => {
    const { engine, capturedSessions } = makeEngine();
    await engine.afterTurn({
      messages: [{ role: "user", content: "test" }],
      prePromptMessageCount: 0,
      success: false,
    });
    assert.equal(capturedSessions.length, 0);
  });

  it("afterTurn treats success=undefined as success (OpenClaw may omit it)", async () => {
    const { engine, capturedSessions } = makeEngine();
    await engine.afterTurn({
      messages: [
        { role: "user", content: "记住我喜欢寿司，偏好深色模式" },
        { role: "assistant", content: "好的，已记住" },
      ],
      prePromptMessageCount: 0,
      // success is intentionally omitted (undefined)
    });
    assert.equal(capturedSessions.length, 1);
  });

  it("afterTurn captures new messages with correct userId", async () => {
    const { engine, capturedSessions } = makeEngine();
    await engine.afterTurn({
      messages: [
        { role: "user", content: "old context" },
        { role: "assistant", content: "old reply" },
        // Use text that passes capture decision (not question-like, contains memory trigger)
        { role: "user", content: "记住我喜欢寿司，我的生日在三月，偏好深色模式" },
        { role: "assistant", content: "好的，已记住你的偏好" },
      ],
      prePromptMessageCount: 2,
      sessionId: "agent:ember:direct:alice",
      success: true,
    });
    assert.equal(capturedSessions.length, 1);
    assert.equal(capturedSessions[0].userId, "alice");
    assert.ok(capturedSessions[0].text.includes("寿司"));
  });

  it("afterTurn uses null userId when session is not direct", async () => {
    const { engine, capturedSessions } = makeEngine();
    await engine.afterTurn({
      messages: [
        // Use text that passes capture decision
        { role: "user", content: "记住团队偏好用深色主题来编辑代码，这很重要" },
        { role: "assistant", content: "好的，已记下团队偏好" },
      ],
      prePromptMessageCount: 0,
      sessionId: "agent:ember:group:room1",
      success: true,
    });
    assert.equal(capturedSessions.length, 1);
    assert.equal(capturedSessions[0].userId, null);
  });

  it("afterTurn skips when no new messages after prePromptMessageCount", async () => {
    const { engine, capturedSessions } = makeEngine();
    await engine.afterTurn({
      messages: [
        { role: "user", content: "old" },
        { role: "assistant", content: "old reply" },
      ],
      prePromptMessageCount: 2,
      success: true,
    });
    assert.equal(capturedSessions.length, 0);
  });

  it("compact returns empty object", async () => {
    const { engine } = makeEngine();
    const result = await engine.compact({ messages: [] });
    assert.deepEqual(result, {});
  });
});
