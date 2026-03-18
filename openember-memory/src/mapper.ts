/**
 * Path <-> OpenViking URI mapper
 */
import * as path from "path";
import type { PathMappingConfig } from "./types.js";

export interface PathMapping {
  localPath: string;
  vikingUriTemplate: string;
  pattern?: RegExp;
  extractParams?: (path: string) => Record<string, string> | null;
}

export interface PathMapperOptions {
  mappings?: PathMappingConfig;
  uriBase?: string;
  agentId?: string;
}

export class PathMapper {
  private mappings: PathMapping[] = [];
  private customMappings: Record<string, string> = {};
  private readonly uriBase: string;
  private readonly rootPrefix: string;
  private readonly stagingUri: string;

  constructor(options?: PathMapperOptions | PathMappingConfig) {
    const normalizedOptions = this.normalizeOptions(options);
    this.uriBase = this.resolveUriBase(
      normalizedOptions.uriBase,
      normalizedOptions.agentId
    );
    this.rootPrefix = `${this.uriBase}/memory-sync`;
    this.stagingUri = `${this.rootPrefix}/_staging`;
    this.setupDefaultMappings();
    if (normalizedOptions.mappings) {
      this.customMappings = normalizedOptions.mappings;
    }
  }

  /**
   * Set up default mapping rules
   */
  private setupDefaultMappings(): void {
    const root = this.rootPrefix;

    // Exact match
    this.mappings.push(
      { localPath: "MEMORY.md", vikingUriTemplate: `${root}/root/MEMORY` },
      { localPath: "SOUL.md", vikingUriTemplate: `${root}/root/SOUL` },
      { localPath: "USER.md", vikingUriTemplate: `${root}/root/USER` },
      { localPath: "AGENTS.md", vikingUriTemplate: `${root}/root/AGENTS` },
      { localPath: "TOOLS.md", vikingUriTemplate: `${root}/root/TOOLS` },
      { localPath: "IDENTITY.md", vikingUriTemplate: `${root}/root/IDENTITY` },
      {
        localPath: "BOOTSTRAP.md",
        vikingUriTemplate: `${root}/root/BOOTSTRAP`,
      }
    );

    // Date files: memory/2025-06-18.md -> .../memory/2025-06-18
    this.mappings.push({
      localPath: "memory/*.md",
      vikingUriTemplate: `${root}/memory/{date}`,
      pattern: /^memory\/(\d{4}-\d{2}-\d{2})\.md$/,
      extractParams: (p: string) => {
        const match = p.match(/^memory\/(\d{4}-\d{2}-\d{2})\.md$/);
        return match ? { date: match[1] } : null;
      },
    });

    // Skill files: skills/*/SKILL.md -> viking://agent/skills/{name}
    this.mappings.push({
      localPath: "skills/*/SKILL.md",
      vikingUriTemplate: `${root}/skills/{name}/SKILL`,
      pattern: /^skills\/([^/]+)\/SKILL\.md$/,
      extractParams: (p: string) => {
        const match = p.match(/^skills\/([^/]+)\/SKILL\.md$/);
        return match ? { name: match[1] } : null;
      },
    });

    // Generic memory files: memory/*.md -> viking://user/memories/misc/{filename}
    this.mappings.push({
      localPath: "memory/*",
      vikingUriTemplate: `${root}/memory/misc/{filename}`,
      pattern: /^memory\/(.+)\.md$/,
      extractParams: (p: string) => {
        const match = p.match(/^memory\/(.+)\.md$/);
        return match ? { filename: match[1] } : null;
      },
    });

    // Skills subdirectory: skills/*/data/* -> viking://agent/skills/{name}/data/{filename}
    this.mappings.push({
      localPath: "skills/*/data/*",
      vikingUriTemplate: `${root}/skills/{name}/data/{filename}`,
      pattern: /^skills\/([^/]+)\/data\/(.+)$/,
      extractParams: (p: string) => {
        const match = p.match(/^skills\/([^/]+)\/data\/(.+)$/);
        return match ? { name: match[1], filename: match[2] } : null;
      },
    });

    // Other files: * -> viking://user/files/{path}
    this.mappings.push({
      localPath: "*",
      vikingUriTemplate: `${root}/files/{path}`,
      pattern: /^(.+)$/,
      extractParams: (value: string) => {
        const clean = value.replace(/^\/+/, "").replace(/\.md$/i, "");
        return { path: clean };
      },
    });
  }

  /**
   * Local path -> Viking directory URI (root node)
   */
  toVikingUri(localPath: string): string {
    const normalizedPath = this.normalizeLocalPath(localPath);

    // Check custom mappings first
    if (this.customMappings[normalizedPath]) {
      return this.normalizeVikingUri(this.customMappings[normalizedPath]);
    }

    // Match rules in order
    for (const mapping of this.mappings) {
      if (mapping.pattern) {
        const params = mapping.extractParams?.(normalizedPath);
        if (params) {
          return this.replaceParams(mapping.vikingUriTemplate, params);
        }
      } else if (mapping.localPath === normalizedPath) {
        return mapping.vikingUriTemplate;
      }
    }

    // Fallback
    return `${this.rootPrefix}/files/${normalizedPath.replace(/\.md$/i, "")}`;
  }

  /**
   * Local path -> Viking file URI (actual read path)
   */
  toContentUri(localPath: string): string {
    const rootUri = this.toVikingUri(localPath);
    const stem = this.toStem(localPath);
    return `${rootUri}/${stem}.md`;
  }

  /**
   * Local path -> import target parent directory URI
   */
  toTargetParentUri(localPath: string): string {
    const rootUri = this.toVikingUri(localPath);
    const idx = rootUri.lastIndexOf("/");
    if (idx <= "viking://".length) {
      return rootUri;
    }
    return rootUri.slice(0, idx);
  }

  /**
   * Sync staging directory
   */
  getStagingUri(): string {
    return this.stagingUri;
  }

  /**
   * Sync root prefix
   */
  getRootPrefix(): string {
    return this.rootPrefix;
  }

  /**
   * Viking URI -> local path (approximate reverse mapping)
   */
  fromVikingUri(vikingUri: string): string {
    const normalizedUri = this.normalizeVikingUri(vikingUri);

    // Check reverse custom mappings first
    for (const [localPath, uri] of Object.entries(this.customMappings)) {
      const normalizedCustomUri = this.normalizeVikingUri(uri);
      if (
        normalizedCustomUri === normalizedUri ||
        normalizedUri.startsWith(`${normalizedCustomUri}/`)
      ) {
        return localPath;
      }
    }

    // Default mapping reverse-parse
    if (normalizedUri.startsWith(`${this.rootPrefix}/`)) {
      const rel = normalizedUri
        .slice(`${this.rootPrefix}/`.length)
        .replace(/^\/+/, "");
      if (!rel) {
        return "MEMORY.md";
      }
      const relNoLeaf = rel.replace(/\/([^/]+)\.md$/i, "");
      const parts = relNoLeaf.split("/").filter(Boolean);

      if (parts.length >= 2 && parts[0] === "root") {
        return `${parts[1]}.md`;
      }
      if (parts.length >= 2 && parts[0] === "memory") {
        if (parts[1] === "misc" && parts[2]) {
          return `memory/${parts.slice(2).join("/")}.md`;
        }
        return `memory/${parts[1]}.md`;
      }
      if (parts.length >= 3 && parts[0] === "skills") {
        const skillName = parts[1];
        if (parts[2] === "SKILL") {
          return `skills/${skillName}/SKILL.md`;
        }
        if (parts[2] === "data") {
          return `skills/${skillName}/data/${parts.slice(3).join("/")}`;
        }
      }
      if (parts.length >= 2 && parts[0] === "files") {
        const raw = parts.slice(1).join("/");
        return raw.endsWith(".md") ? raw : `${raw}.md`;
      }
    }

    // Fallback: strip prefix
    return normalizedUri.replace(/^viking:\/\//, "");
  }

  /**
   * Replace template parameters
   */
  private replaceParams(
    template: string,
    params: Record<string, string>
  ): string {
    return template.replace(/\{(\w+)\}/g, (match, key: string) => {
      return params[key] ?? match;
    });
  }

  /**
   * Get all mapping rules (for debugging)
   */
  getMappings(): PathMapping[] {
    return [...this.mappings];
  }

  /**
   * Add custom mapping
   */
  addCustomMapping(localPath: string, vikingUri: string): void {
    this.customMappings[this.normalizeLocalPath(localPath)] =
      this.normalizeVikingUri(vikingUri);
  }

  private normalizeOptions(
    options: PathMapperOptions | PathMappingConfig | undefined
  ): PathMapperOptions {
    if (!options) {
      return {};
    }
    const hasKnownField =
      typeof options === "object" &&
      options !== null &&
      ("mappings" in options || "uriBase" in options || "agentId" in options);
    if (hasKnownField) {
      return options as PathMapperOptions;
    }
    return { mappings: options as PathMappingConfig };
  }

  private resolveUriBase(uriBase?: string, agentId?: string): string {
    const raw = (uriBase ?? "viking://resources/openclaw/{agentId}")
      .trim()
      .replace(/\/+$/, "");
    const id = (agentId ?? "main").trim() || "main";
    if (raw.includes("{agentId}")) {
      return raw.replace(/\{agentId\}/g, encodeURIComponent(id));
    }
    return `${raw}/${encodeURIComponent(id)}`;
  }

  private normalizeLocalPath(input: string): string {
    return input.replace(/\\/g, "/").replace(/^\/+/, "");
  }

  private normalizeVikingUri(uri: string): string {
    return uri.replace(/\/+$/, "");
  }

  private toStem(localPath: string): string {
    const normalized = this.normalizeLocalPath(localPath);
    const ext = path.extname(normalized);
    const base = path.basename(normalized, ext || undefined);
    return this.sanitizeSegment(base);
  }

  private sanitizeSegment(value: string): string {
    const stripped = value.replace(/[^\w\u4e00-\u9fff\s-]/g, "");
    const collapsed = stripped
      .replace(/\s+/g, "_")
      .replace(/^_+|_+$/g, "");
    return collapsed || "content";
  }
}
