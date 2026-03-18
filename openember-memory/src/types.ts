/**
 * OpenViking plugin type definitions
 */

export interface OpenVikingPluginConfig {
  /** OpenViking HTTP service address */
  baseUrl: string;
  /** Optional API key */
  apiKey?: string;
  /** OpenViking resource URI prefix, default viking://resources/openclaw */
  uriBase?: string;
  /** Path mapping rules (local path -> Viking URI root) */
  mappings?: PathMappingConfig;
  /** Enable tiered loading (L1/L2) */
  tieredLoading?: boolean;
  /** Sync configuration */
  sync?: SyncConfig;
  /** Search configuration */
  search?: SearchConfig;
  /** Auto-start OpenViking server */
  server?: ServerConfig;
}

export interface ServerConfig {
  /** Whether to auto-start */
  enabled: boolean;
  /** Python venv path */
  venvPath: string;
  /** Data directory */
  dataDir?: string;
  /** Host address, default 127.0.0.1 */
  host?: string;
  /** Port, default 1933 */
  port?: number;
  /** Startup timeout, default 30000ms */
  startupTimeoutMs?: number;
  /** Extra environment variables */
  env?: Record<string, string>;
}

export interface PathMappingConfig {
  [localPath: string]: string;
}

export interface SyncConfig {
  /** Sync interval, default "5m" */
  interval?: string;
  /** Sync on boot, default true */
  onBoot?: boolean;
  /** Extra sync paths (relative to workspace) */
  extraPaths?: string[];
  /** Wait for queue processing after sync */
  waitForProcessing?: boolean;
  /** Wait timeout (seconds) */
  waitTimeoutSec?: number;
}

export interface SearchConfig {
  /** Search method: find (default) or search (with session semantics) */
  mode?: "find" | "search";
  /** Default result count */
  defaultLimit?: number;
  /** Minimum similarity threshold (0-1) */
  scoreThreshold?: number;
  /** Restrict search to URI prefix */
  targetUri?: string;
}

export type OpenVikingContextType = "memory" | "resource" | "skill";

export interface OpenVikingApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface OpenVikingApiResponse<T> {
  status: "ok" | "error";
  result?: T;
  error?: OpenVikingApiError;
  time?: number;
}

export interface OpenVikingFindRequest {
  query: string;
  target_uri?: string;
  limit?: number;
  score_threshold?: number;
  filter?: Record<string, unknown>;
  session_id?: string;
}

export interface OpenVikingMatchedContext {
  uri: string;
  context_type: OpenVikingContextType;
  is_leaf: boolean;
  abstract: string;
  category?: string;
  score: number;
  match_reason?: string;
  relations?: Array<Record<string, unknown>>;
}

export interface OpenVikingFindResult {
  memories: OpenVikingMatchedContext[];
  resources: OpenVikingMatchedContext[];
  skills: OpenVikingMatchedContext[];
  total: number;
  query_plan?: Record<string, unknown>;
  query_results?: Array<Record<string, unknown>>;
}

export interface OpenVikingAddResourceRequest {
  path?: string;
  temp_path?: string;
  to?: string;
  parent?: string;
  reason?: string;
  instruction?: string;
  wait?: boolean;
  timeout?: number;
}

export interface OpenVikingAddResourceResult {
  status: string;
  root_uri: string;
  source_path: string;
  errors?: string[];
  queue_status?: Record<string, unknown>;
}

export interface OpenVikingAddSkillRequest {
  data: unknown;
  wait?: boolean;
  timeout?: number;
}

export interface OpenVikingHealthStatus {
  status: "ok" | "error" | string;
}

export interface OpenVikingSystemStatus {
  initialized: boolean;
  user: string;
}

export interface OpenVikingFsStat {
  uri: string;
  isDir?: boolean;
  size?: number;
  modTime?: string;
  [key: string]: unknown;
}
