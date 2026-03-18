import { createHash } from "node:crypto";
import type { spawn } from "node:child_process";

export type FindResultItem = {
  uri: string;
  level?: number;
  abstract?: string;
  overview?: string;
  category?: string;
  score?: number;
  match_reason?: string;
};

export type FindResult = {
  memories?: FindResultItem[];
  resources?: FindResultItem[];
  skills?: FindResultItem[];
  total?: number;
};

export type CaptureMode = "semantic" | "keyword";
export type LocalClientCacheEntry = {
  client: OpenVikingClient;
  process: ReturnType<typeof spawn> | null;
};

export type PendingClientEntry = {
  promise: Promise<OpenVikingClient>;
  resolve: (c: OpenVikingClient) => void;
  reject: (err: unknown) => void;
};

export const localClientCache = new Map<string, LocalClientCacheEntry>();

// Module-level pending promise map: shared across all plugin registrations so
// that both [gateway] and [plugins] contexts await the same promise and
// don't create duplicate pending promises that never resolve.
export const localClientPendingPromises = new Map<string, PendingClientEntry>();

const MEMORY_URI_PATTERNS = [
  /^viking:\/\/user\/(?:[^/]+\/)?memories(?:\/|$)/,
  /^viking:\/\/agent\/(?:[^/]+\/)?memories(?:\/|$)/,
];

export function md5Short(input: string): string {
  return createHash("md5").update(input).digest("hex").slice(0, 12);
}

export function isMemoryUri(uri: string): boolean {
  return MEMORY_URI_PATTERNS.some((pattern) => pattern.test(uri));
}

/** Matches viking://user/ followed by a known structure dir (memories, skills, etc.) */
const USER_STRUCTURE_URI_RE = /^viking:\/\/user\/(memories|skills|instructions|workspaces)(\/|$)/;

export class OpenVikingClient {
  /**
   * Current user ID for multi-user routing.
   * null = no user identified, use agent shared space only.
   */
  private userId: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private agentId: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Set the current user ID for multi-user memory routing.
   * - userId set: viking://user/memories → viking://user/{md5(userId:agentId)}/memories
   * - userId null: URIs pass through without space prefix
   */
  setUserId(userId: string | null): void {
    this.userId = userId;
  }

  /**
   * Dynamically switch the agent identity for multi-agent memory isolation.
   */
  setAgentId(newAgentId: string): void {
    if (newAgentId && newAgentId !== this.agentId) {
      this.agentId = newAgentId;
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = new Headers(init.headers ?? {});
      if (this.apiKey) {
        headers.set("X-API-Key", this.apiKey);
      }
      if (this.agentId) {
        headers.set("X-OpenViking-Agent", this.agentId);
      }
      if (this.userId) {
        // Encode userId+agentId into X-OpenViking-User for per-user-per-agent isolation.
        // Uses md5 hash to avoid special character issues (OpenViking requires alphanumeric).
        // e.g. userId="1112318905768231003", agentId="ember" → md5("1112318905768231003:ember")[:12]
        headers.set("X-OpenViking-User", md5Short(`${this.userId}:${this.agentId}`));
      }
      if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }

      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => ({}))) as {
        status?: string;
        result?: T;
        error?: { code?: string; message?: string };
      };

      if (!response.ok || payload.status === "error") {
        const code = payload.error?.code ? ` [${payload.error.code}]` : "";
        const message = payload.error?.message ?? `HTTP ${response.status}`;
        throw new Error(`OpenViking request failed${code}: ${message}`);
      }

      return (payload.result ?? payload) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<void> {
    await this.request<{ status: string }>("/health");
  }

  /**
   * Normalize a target URI with multi-user routing.
   *
   * With userId set:
   *   viking://user/memories  → viking://user/{md5(userId:agentId)}/memories
   *   viking://agent/memories → unchanged (agent shared, no user prefix)
   *
   * Without userId (null):
   *   All URIs pass through unchanged.
   */
  normalizeTargetUri(targetUri: string): string {
    const trimmed = targetUri.trim().replace(/\/+$/, "");
    if (!this.userId) {
      return trimmed;
    }

    const match = trimmed.match(USER_STRUCTURE_URI_RE);
    if (!match) {
      return trimmed;
    }

    // viking://user/{md5(userId:agentId)}/memories — matches X-OpenViking-User header
    const space = md5Short(`${this.userId}:${this.agentId}`);
    const rest = trimmed.slice("viking://user/".length);
    return `viking://user/${space}/${rest}`;
  }

  async find(
    query: string,
    options: {
      targetUri: string;
      limit: number;
      scoreThreshold?: number;
    },
  ): Promise<FindResult> {
    const normalizedTargetUri = this.normalizeTargetUri(options.targetUri);
    const body = {
      query,
      target_uri: normalizedTargetUri,
      limit: options.limit,
      score_threshold: options.scoreThreshold,
    };
    return this.request<FindResult>("/api/v1/search/find", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async read(uri: string): Promise<string> {
    return this.request<string>(
      `/api/v1/content/read?uri=${encodeURIComponent(uri)}`,
    );
  }

  async createSession(): Promise<string> {
    const result = await this.request<{ session_id: string }>("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({}),
    });
    return result.session_id;
  }

  async addSessionMessage(sessionId: string, role: string, content: string): Promise<void> {
    await this.request<{ session_id: string }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ role, content }),
      },
    );
  }

  /** GET session so server loads messages from storage before extract (workaround for AGFS visibility). */
  async getSession(sessionId: string): Promise<{ message_count?: number }> {
    return this.request<{ message_count?: number }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      { method: "GET" },
    );
  }

  async extractSessionMemories(sessionId: string): Promise<Array<Record<string, unknown>>> {
    return this.request<Array<Record<string, unknown>>>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/extract`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }

  async deleteUri(uri: string): Promise<void> {
    await this.request(`/api/v1/fs?uri=${encodeURIComponent(uri)}&recursive=false`, {
      method: "DELETE",
    });
  }
}
