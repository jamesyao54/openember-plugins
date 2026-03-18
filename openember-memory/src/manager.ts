/**
 * OpenViking Memory Manager
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { OpenVikingClient, OpenVikingHttpError } from "./client.js";
import { PathMapper } from "./mapper.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySyncProgressUpdate,
} from "./memory.js";
import type { OpenVikingMatchedContext, OpenVikingPluginConfig } from "./types.js";

export interface OpenVikingMemoryManagerOptions {
  config: OpenVikingPluginConfig;
  workspaceDir: string;
  agentId: string;
  logger?: {
    debug?: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export class OpenVikingMemoryManager implements MemorySearchManager {
  private readonly client: OpenVikingClient;
  private readonly mapper: PathMapper;
  private readonly config: OpenVikingPluginConfig;
  private readonly workspaceDir: string;
  private readonly agentId: string;
  private readonly logger?: OpenVikingMemoryManagerOptions["logger"];
  private closed = false;
  private lastSyncAt?: Date;

  constructor(options: OpenVikingMemoryManagerOptions) {
    this.config = options.config;
    this.workspaceDir = options.workspaceDir;
    this.agentId = options.agentId;
    this.logger = options.logger;
    this.client = new OpenVikingClient({
      baseUrl: options.config.baseUrl,
      apiKey: options.config.apiKey,
      timeoutMs: 30000,
    });
    this.mapper = new PathMapper({
      mappings: options.config.mappings,
      uriBase: options.config.uriBase,
      agentId: options.agentId,
    });
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string }
  ): Promise<MemorySearchResult[]> {
    this.ensureOpen();
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }

    const limit = Math.max(
      1,
      opts?.maxResults ?? this.config.search?.defaultLimit ?? 6
    );
    const threshold = opts?.minScore ?? this.config.search?.scoreThreshold ?? 0;
    const mode = this.config.search?.mode ?? "find";
    const targetUri =
      this.config.search?.targetUri ?? this.mapper.getRootPrefix();

    this.logger?.debug?.(
      `openviking search mode=${mode}, query="${cleaned}", target=${targetUri}, limit=${limit}`
    );

    const result =
      mode === "search"
        ? await this.client.search({
            query: cleaned,
            limit,
            score_threshold: threshold,
            target_uri: targetUri,
            session_id: opts?.sessionKey,
          })
        : await this.client.find({
            query: cleaned,
            limit,
            score_threshold: threshold,
            target_uri: targetUri,
          });

    const rows = [
      ...(result.memories ?? []),
      ...(result.resources ?? []),
      ...(result.skills ?? []),
    ];

    return rows
      .map((entry) => this.toMemorySearchResult(entry))
      .filter((entry) => entry.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Search with an explicit targetUri override.
   * Same logic as search() but uses the provided targetUri instead of config/mapper default.
   */
  async searchWithTargetUri(
    query: string,
    opts: {
      targetUri: string;
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
    }
  ): Promise<MemorySearchResult[]> {
    this.ensureOpen();
    const cleaned = query.trim();
    if (!cleaned) return [];

    const limit = Math.max(
      1,
      opts.maxResults ?? this.config.search?.defaultLimit ?? 6
    );
    const threshold = opts.minScore ?? this.config.search?.scoreThreshold ?? 0;
    const mode = this.config.search?.mode ?? "find";

    this.logger?.debug?.(
      `openviking searchWithTargetUri mode=${mode}, query="${cleaned}", target=${opts.targetUri}, limit=${limit}`
    );

    try {
      const result =
        mode === "search"
          ? await this.client.search({
              query: cleaned,
              limit,
              score_threshold: threshold,
              target_uri: opts.targetUri,
              session_id: opts.sessionKey,
            })
          : await this.client.find({
              query: cleaned,
              limit,
              score_threshold: threshold,
              target_uri: opts.targetUri,
            });

      const rows = [
        ...(result.memories ?? []),
        ...(result.resources ?? []),
        ...(result.skills ?? []),
      ]
        // Filter out OpenViking metadata files (overview/abstract placeholders)
        .filter((entry) => !entry.uri.endsWith("/.overview.md") && !entry.uri.endsWith("/.abstract.md"));

      // For entries with empty abstracts, fetch content as snippet
      const mapped = await Promise.all(
        rows.map(async (entry) => {
          const base = this.toMemorySearchResult(entry);
          // Use URI directly as path for per-user entries (mapper can't reverse these)
          base.path = entry.uri;
          base.citation = entry.uri;
          if (!entry.abstract?.trim() && !entry.match_reason?.trim()) {
            try {
              const content = await this.client.read(entry.uri);
              base.snippet = content.slice(0, 1200);
            } catch {
              // Read failed — keep URI as snippet
            }
          }
          return base;
        })
      );

      return mapped
        .filter((entry) => entry.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (error) {
      // Return empty results for 404 (namespace doesn't exist yet)
      if (error instanceof OpenVikingHttpError && error.status === 404) {
        this.logger?.debug?.(
          `openviking searchWithTargetUri: target not found (${opts.targetUri}), returning empty`
        );
        return [];
      }
      throw error;
    }
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    this.ensureOpen();
    const relPath = this.ensureSafeRelPath(params.relPath);
    const rootUri = this.mapper.toVikingUri(relPath);
    const contentUri = this.mapper.toContentUri(relPath);

    this.logger?.debug?.(
      `openviking read relPath=${relPath}, rootUri=${rootUri}, contentUri=${contentUri}`
    );

    try {
      let text = "";
      const requiresExactLines =
        params.from !== undefined || params.lines !== undefined;

      if (requiresExactLines || this.config.tieredLoading === false) {
        text = await this.client.read(contentUri);
      } else {
        try {
          text = await this.client.overview(rootUri);
        } catch {
          text = await this.client.read(contentUri);
        }
      }

      return {
        path: relPath,
        text: this.sliceLines(text, params.from, params.lines),
      };
    } catch (error) {
      this.logger?.warn(
        `OpenViking read failed for ${relPath}, fallback to local file: ${error}`
      );
      return await this.readLocalFile({
        relPath,
        from: params.from,
        lines: params.lines,
      });
    }
  }

  status(): MemoryProviderStatus {
    return {
      backend: "builtin",
      provider: "openviking",
      model: this.config.search?.mode ?? "find",
      workspaceDir: this.workspaceDir,
      custom: {
        baseUrl: this.config.baseUrl,
        agentId: this.agentId,
        rootPrefix: this.mapper.getRootPrefix(),
        tieredLoading: this.config.tieredLoading !== false,
        lastSyncAt: this.lastSyncAt?.toISOString(),
      },
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    this.ensureOpen();
    const files = await this.scanFiles();
    const total = files.length;
    let completed = 0;

    this.logger?.info(
      `openviking sync started: reason=${params?.reason ?? "manual"}, files=${total}`
    );
    params?.progress?.({ completed, total, label: "Scanning memory files..." });

    for (const relPath of files) {
      try {
        await this.syncFile(relPath);
      } catch (error) {
        this.logger?.error(`Failed to sync ${relPath}: ${String(error)}`);
      } finally {
        completed += 1;
        params?.progress?.({
          completed,
          total,
          label: `Syncing ${path.basename(relPath)}`,
        });
      }
    }

    if (this.config.sync?.waitForProcessing) {
      const timeout = this.config.sync.waitTimeoutSec;
      await this.client.waitProcessed(timeout);
    }

    this.lastSyncAt = new Date();
    params?.progress?.({ completed: total, total, label: "Sync completed" });
    this.logger?.info(`openviking sync finished: ${total} files`);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      const health = await this.client.health();
      if (health.status !== "ok") {
        return { ok: false, error: `health=${health.status}` };
      }
      const system = await this.client.systemStatus();
      if (!system.initialized) {
        return { ok: false, error: "OpenViking is not initialized" };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    try {
      const system = await this.client.systemStatus();
      return Boolean(system.initialized);
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.logger?.info("openviking manager closed");
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("OpenVikingMemoryManager is closed");
    }
  }

  private toMemorySearchResult(entry: OpenVikingMatchedContext): MemorySearchResult {
    const pathHint = this.mapper.fromVikingUri(entry.uri);
    const snippet = (
      entry.abstract?.trim() ||
      entry.match_reason?.trim() ||
      entry.uri
    ).slice(0, 1200);
    return {
      path: pathHint,
      startLine: 1,
      endLine: 1,
      score: Number.isFinite(entry.score) ? entry.score : 0,
      snippet,
      source: this.inferSource(entry.uri, entry.context_type),
      citation: `${pathHint}#L1`,
    };
  }

  private inferSource(
    uri: string,
    contextType: string
  ): "memory" | "sessions" {
    if (uri.includes("viking://session/")) {
      return "sessions";
    }
    if (contextType === "memory") {
      return "memory";
    }
    return "memory";
  }

  private async readLocalFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const fullPath = path.join(this.workspaceDir, params.relPath);
    const content = await fs.readFile(fullPath, "utf-8");
    return {
      path: params.relPath,
      text: this.sliceLines(content, params.from, params.lines),
    };
  }

  private sliceLines(
    content: string,
    from?: number,
    lines?: number
  ): string {
    if (from === undefined && lines === undefined) {
      return content;
    }
    const allLines = content.split("\n");
    const start = Math.max(0, (from ?? 1) - 1);
    const end =
      lines === undefined
        ? allLines.length
        : Math.max(start, Math.min(allLines.length, start + lines));
    return allLines.slice(start, end).join("\n");
  }

  private ensureSafeRelPath(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error("path required");
    }
    const normalized = trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
    const safe = path.posix.normalize(normalized);
    if (safe.startsWith("../") || safe.includes("/../") || safe === "..") {
      throw new Error(`invalid path: ${input}`);
    }
    return safe;
  }

  private async scanFiles(): Promise<string[]> {
    const files = new Set<string>();

    const addIfExists = async (relPath: string): Promise<void> => {
      try {
        await fs.access(path.join(this.workspaceDir, relPath));
        files.add(relPath);
      } catch {
        // ignore missing file
      }
    };

    // Root directory key memory files
    const rootFiles = [
      "MEMORY.md",
      "memory.md",
      "SOUL.md",
      "USER.md",
      "AGENTS.md",
      "TOOLS.md",
      "IDENTITY.md",
      "BOOTSTRAP.md",
    ];
    for (const relPath of rootFiles) {
      await addIfExists(relPath);
    }

    // memory/*.md
    const memoryDir = path.join(this.workspaceDir, "memory");
    try {
      const entries = await fs.readdir(memoryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          files.add(`memory/${entry.name}`);
        }
      }
    } catch {
      // ignore missing directory
    }

    // skills/*/SKILL.md
    const skillsDir = path.join(this.workspaceDir, "skills");
    try {
      const skillDirs = await fs.readdir(skillsDir, { withFileTypes: true });
      for (const entry of skillDirs) {
        if (!entry.isDirectory()) {
          continue;
        }
        const skillPath = path
          .join("skills", entry.name, "SKILL.md")
          .replace(/\\/g, "/");
        await addIfExists(skillPath);
      }
    } catch {
      // ignore missing directory
    }

    // Extra configured paths
    for (const extraPath of this.config.sync?.extraPaths ?? []) {
      await this.scanExtraPath(extraPath, files);
    }

    return [...files].sort((a, b) => a.localeCompare(b));
  }

  private async scanExtraPath(
    rawPath: string,
    files: Set<string>
  ): Promise<void> {
    const relPath = this.resolveExtraPath(rawPath);
    if (!relPath) {
      return;
    }

    const absPath =
      relPath === "." ? this.workspaceDir : path.join(this.workspaceDir, relPath);

    try {
      const stat = await fs.lstat(absPath);
      if (stat.isSymbolicLink()) {
        this.logger?.warn(`Skip symlink extra path: ${rawPath}`);
        return;
      }
      if (stat.isDirectory()) {
        await this.collectMarkdownFiles(absPath, files);
        return;
      }
      if (stat.isFile()) {
        if (absPath.toLowerCase().endsWith(".md")) {
          files.add(relPath);
        } else {
          this.logger?.warn(`Skip non-markdown extra file: ${rawPath}`);
        }
        return;
      }
      this.logger?.warn(`Skip unsupported extra path type: ${rawPath}`);
    } catch (error) {
      this.logger?.warn(
        `Skip missing/inaccessible extra path ${rawPath}: ${String(error)}`
      );
    }
  }

  private resolveExtraPath(rawPath: string): string | null {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      return null;
    }

    const absPath = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(this.workspaceDir, trimmed);

    const relPath = path.relative(this.workspaceDir, absPath);
    if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
      this.logger?.warn(`Skip extra path outside workspace: ${trimmed}`);
      return null;
    }

    const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    return normalized || ".";
  }

  private async collectMarkdownFiles(
    dir: string,
    files: Set<string>
  ): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await this.collectMarkdownFiles(entryPath, files);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }
      const relPath = path.relative(this.workspaceDir, entryPath);
      if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
        continue;
      }
      files.add(relPath.replace(/\\/g, "/"));
    }
  }

  private async syncFile(relPath: string): Promise<void> {
    const safeRelPath = this.ensureSafeRelPath(relPath);
    const fullPath = path.join(this.workspaceDir, safeRelPath);
    const desiredRootUri = this.mapper.toVikingUri(safeRelPath);
    const targetParentUri = this.mapper.toTargetParentUri(safeRelPath);

    this.logger?.debug?.(
      `openviking sync file relPath=${safeRelPath}, parent=${targetParentUri}, target=${desiredRootUri}`
    );

    await this.ensureTargetParent(targetParentUri);
    await this.tryRemove(desiredRootUri);

    const importResult = await this.client.addResource({
      path: fullPath,
      parent: targetParentUri,
      reason: `OpenClaw memory sync: ${safeRelPath}`,
      wait: false,
    });

    const importedRoot = importResult.root_uri;
    if (!importedRoot) {
      throw new Error(
        `OpenViking import result missing root_uri: ${safeRelPath}`
      );
    }

    if (this.normalizeUri(importedRoot) !== this.normalizeUri(desiredRootUri)) {
      this.logger?.warn(
        `openviking import root mismatch for ${safeRelPath}: imported=${importedRoot}, expected=${desiredRootUri}; move to expected path`
      );
      await this.tryRemove(desiredRootUri);
      await this.client.move(importedRoot, desiredRootUri);
    }
  }

  private async ensureTargetParent(uri: string): Promise<void> {
    if (await this.pathExists(uri)) {
      this.logger?.debug?.(`openviking mkdir skipped (already exists): ${uri}`);
      return;
    }
    try {
      await this.client.mkdir(uri);
    } catch (error) {
      if (this.shouldIgnoreExistingPathError(error)) {
        this.logger?.debug?.(
          `openviking mkdir skipped (already exists): ${uri}`
        );
        return;
      }
      throw error;
    }
  }

  private async tryRemove(uri: string): Promise<void> {
    if (!(await this.pathExists(uri))) {
      this.logger?.debug?.(`openviking remove skipped (missing path): ${uri}`);
      return;
    }
    try {
      await this.client.remove(uri, true);
    } catch (error) {
      if (this.shouldIgnoreMissingPathError(error)) {
        this.logger?.debug?.(
          `openviking remove skipped (missing path): ${uri}`
        );
        return;
      }
      throw error;
    }
  }

  private async pathExists(uri: string): Promise<boolean> {
    try {
      await this.client.stat(uri);
      return true;
    } catch (error) {
      if (this.shouldIgnoreMissingPathError(error)) {
        return false;
      }
      throw error;
    }
  }

  private normalizeUri(uri: string): string {
    return uri.replace(/\/+$/, "");
  }

  private shouldIgnoreMissingPathError(error: unknown): boolean {
    if (error instanceof OpenVikingHttpError) {
      if (error.status === 404) {
        return true;
      }
      if (typeof error.code === "string" && /not[_-]?found/i.test(error.code)) {
        return true;
      }
      const message = [
        error.message,
        error.details ? JSON.stringify(error.details) : "",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return this.looksLikeMissingPath(message);
    }
    if (error instanceof Error) {
      return this.looksLikeMissingPath(error.message.toLowerCase());
    }
    return false;
  }

  private shouldIgnoreExistingPathError(error: unknown): boolean {
    if (error instanceof OpenVikingHttpError) {
      if (error.status === 409) {
        return true;
      }
      if (
        typeof error.code === "string" &&
        /already[_-]?exists/i.test(error.code)
      ) {
        return true;
      }
      const message = [
        error.message,
        error.details ? JSON.stringify(error.details) : "",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return this.looksLikeExistingPath(message);
    }
    if (error instanceof Error) {
      return this.looksLikeExistingPath(error.message.toLowerCase());
    }
    return false;
  }

  private looksLikeMissingPath(text: string): boolean {
    return (
      text.includes("no such file or directory") ||
      text.includes("no such directory") ||
      text.includes("not found") ||
      text.includes("path not found")
    );
  }

  private looksLikeExistingPath(text: string): boolean {
    return (
      text.includes("already exists") ||
      text.includes("file exists") ||
      text.includes("directory exists")
    );
  }
}
