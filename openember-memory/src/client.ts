/**
 * OpenViking HTTP client
 */
import type {
  OpenVikingAddResourceRequest,
  OpenVikingAddResourceResult,
  OpenVikingAddSkillRequest,
  OpenVikingFindRequest,
  OpenVikingFindResult,
  OpenVikingFsStat,
  OpenVikingHealthStatus,
  OpenVikingPluginConfig,
  OpenVikingSystemStatus,
} from "./types.js";

export class OpenVikingHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(params: {
    message: string;
    status: number;
    code?: string;
    details?: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = "OpenVikingHttpError";
    this.status = params.status;
    this.code = params.code;
    this.details = params.details;
  }
}

export class OpenVikingClient {
  private baseUrl: string;
  private apiKey?: string;
  private timeoutMs: number;

  constructor(
    config: Pick<OpenVikingPluginConfig, "baseUrl" | "apiKey"> & {
      timeoutMs?: number;
    }
  ) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 10000;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["X-API-Key"] = this.apiKey;
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timeout after ${this.timeoutMs}ms`);
      }
      throw error;
    }
  }

  private async request<T = unknown>(params: {
    method: string;
    path: string;
    query?: Record<string, unknown>;
    body?: unknown;
    raw?: boolean;
  }): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params.query ?? {})) {
      if (value !== undefined) {
        query.append(key, String(value));
      }
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const url = `${this.baseUrl}${params.path}${suffix}`;
    const headers = this.getHeaders();
    let body: string | undefined;
    if (params.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(params.body);
    }

    const response = await this.fetchWithTimeout(url, {
      method: params.method,
      headers,
      body,
    });

    const rawText = await response.text();
    let parsed: unknown = undefined;
    if (rawText.trim()) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = rawText;
      }
    }

    if (!response.ok) {
      const payload = parsed as {
        error?: { message?: string; code?: string; details?: Record<string, unknown> };
      } | undefined;
      const message =
        payload?.error?.message ||
        (typeof parsed === "string" ? parsed : response.statusText) ||
        "Request failed";
      throw new OpenVikingHttpError({
        message: `OpenViking ${params.method} ${params.path} failed: ${message}`,
        status: response.status,
        code: payload?.error?.code,
        details: payload?.error?.details,
      });
    }

    if (params.raw) {
      return parsed as T;
    }

    const payload = parsed as {
      status: string;
      result?: T;
      error?: { message?: string; code?: string; details?: Record<string, unknown> };
    };
    if (!payload || typeof payload !== "object") {
      throw new OpenVikingHttpError({
        message: `OpenViking ${params.method} ${params.path} returned non-JSON payload`,
        status: response.status,
      });
    }
    if (payload.status !== "ok") {
      throw new OpenVikingHttpError({
        message: `OpenViking error: ${payload.error?.message ?? "Unknown error"}`,
        status: response.status,
        code: payload.error?.code,
        details: payload.error?.details,
      });
    }
    return payload.result as T;
  }

  /**
   * Basic semantic retrieval (no session context)
   */
  async find(request: OpenVikingFindRequest): Promise<OpenVikingFindResult> {
    return await this.request<OpenVikingFindResult>({
      method: "POST",
      path: "/api/v1/search/find",
      body: request,
    });
  }

  /**
   * Session-context-aware retrieval
   */
  async search(request: OpenVikingFindRequest): Promise<OpenVikingFindResult> {
    return await this.request<OpenVikingFindResult>({
      method: "POST",
      path: "/api/v1/search/search",
      body: request,
    });
  }

  /**
   * Read full content (L2)
   */
  async read(uri: string): Promise<string> {
    return await this.request<string>({
      method: "GET",
      path: "/api/v1/content/read",
      query: { uri },
    });
  }

  /**
   * Read directory overview (L1)
   */
  async overview(uri: string): Promise<string> {
    return await this.request<string>({
      method: "GET",
      path: "/api/v1/content/overview",
      query: { uri },
    });
  }

  /**
   * Read directory abstract (L0)
   */
  async abstract(uri: string): Promise<string> {
    return await this.request<string>({
      method: "GET",
      path: "/api/v1/content/abstract",
      query: { uri },
    });
  }

  /**
   * Import resource
   */
  async addResource(
    request: OpenVikingAddResourceRequest
  ): Promise<OpenVikingAddResourceResult> {
    return await this.request<OpenVikingAddResourceResult>({
      method: "POST",
      path: "/api/v1/resources",
      body: request,
    });
  }

  /**
   * Upload content to a temp file on the server, returning the temp_path.
   * Used before addResource when the client doesn't share a filesystem with the server.
   */
  async tempUpload(
    content: string,
    filename: string
  ): Promise<{ temp_path: string }> {
    const blob = new Blob([content], { type: "text/markdown" });
    const formData = new FormData();
    formData.append("file", blob, filename);

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["X-API-Key"] = this.apiKey;
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(
        `${this.baseUrl}/api/v1/resources/temp_upload`,
        { method: "POST", headers, body: formData, signal: controller.signal }
      );
      clearTimeout(timeoutId);
      const parsed = (await response.json()) as {
        status: string;
        result?: { temp_path: string };
        error?: { message?: string };
      };
      if (!response.ok || parsed.status !== "ok" || !parsed.result?.temp_path) {
        throw new OpenVikingHttpError({
          message: `temp_upload failed: ${parsed.error?.message ?? response.statusText}`,
          status: response.status,
        });
      }
      return parsed.result;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof OpenVikingHttpError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`temp_upload timeout after ${this.timeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Import skill
   */
  async addSkill(
    request: OpenVikingAddSkillRequest
  ): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>({
      method: "POST",
      path: "/api/v1/skills",
      body: request,
    });
  }

  /**
   * Create directory
   */
  async mkdir(uri: string): Promise<void> {
    await this.request<void>({
      method: "POST",
      path: "/api/v1/fs/mkdir",
      body: { uri },
    });
  }

  /**
   * Read resource status
   */
  async stat(uri: string): Promise<OpenVikingFsStat> {
    return await this.request<OpenVikingFsStat>({
      method: "GET",
      path: "/api/v1/fs/stat",
      query: { uri },
    });
  }

  /**
   * Delete resource
   */
  async remove(uri: string, recursive = false): Promise<void> {
    await this.request<void>({
      method: "DELETE",
      path: "/api/v1/fs",
      query: { uri, recursive },
    });
  }

  /**
   * Move resource
   */
  async move(fromUri: string, toUri: string): Promise<void> {
    await this.request<void>({
      method: "POST",
      path: "/api/v1/fs/mv",
      body: { from_uri: fromUri, to_uri: toUri },
    });
  }

  /**
   * Wait for queue processing to complete
   */
  async waitProcessed(timeoutSec?: number): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>({
      method: "POST",
      path: "/api/v1/system/wait",
      body: { timeout: timeoutSec },
    });
  }

  /**
   * System status
   */
  async systemStatus(): Promise<OpenVikingSystemStatus> {
    return await this.request<OpenVikingSystemStatus>({
      method: "GET",
      path: "/api/v1/system/status",
    });
  }

  /**
   * Health check (this endpoint does not use the unified result wrapper)
   */
  async health(): Promise<OpenVikingHealthStatus> {
    return await this.request<OpenVikingHealthStatus>({
      method: "GET",
      path: "/health",
      raw: true,
    });
  }
}
