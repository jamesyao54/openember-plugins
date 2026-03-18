/**
 * OpenViking server process manager
 * Used to auto-start/stop the OpenViking server
 */
import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import type { ServerConfig } from "./types.js";

export interface ServerManagerOptions {
  config: ServerConfig;
  logger?: {
    debug?: (msg: string) => void;
    info: (msg: string) => void;
    warn?: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export class OpenVikingServerManager {
  private config: Required<
    Pick<ServerConfig, "host" | "port" | "startupTimeoutMs">
  > &
    ServerConfig;
  private logger: ServerManagerOptions["logger"];
  private process?: ChildProcess;
  private ready = false;
  private startupPromise?: Promise<void>;

  constructor(options: ServerManagerOptions) {
    this.config = {
      host: "127.0.0.1",
      port: 1933,
      startupTimeoutMs: 30000,
      ...options.config,
    };
    this.logger = options.logger;
  }

  /**
   * Start OpenViking server
   */
  async start(): Promise<void> {
    if (this.ready) return;
    if (this.startupPromise) return this.startupPromise;
    this.startupPromise = this.doStart();
    return this.startupPromise;
  }

  private async doStart(): Promise<void> {
    const { venvPath, dataDir, host, port, startupTimeoutMs, env } =
      this.config;

    // Check if server is already running
    try {
      const health = await this.checkHealth();
      if (health) {
        this.logger?.info(`OpenViking already running at ${host}:${port}`);
        this.ready = true;
        return;
      }
    } catch {
      // Not running, continue to start
    }

    this.logger?.info(`Starting OpenViking server on ${host}:${port}...`);

    // Build command
    const pythonPath = path.join(venvPath, "bin", "python");
    const args = [
      "-m",
      "openviking",
      "serve",
      "--host",
      host!,
      "--port",
      String(port),
    ];
    if (dataDir) {
      args.push("--data-dir", dataDir);
    }

    // Environment variables
    const childEnv: Record<string, string> = {
      ...process.env,
      ...env,
      PYTHONUNBUFFERED: "1",
    };

    // Start process
    this.process = spawn(pythonPath, args, {
      env: childEnv,
      cwd: path.dirname(venvPath),
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Forward logs
    this.process.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) this.logger?.debug?.(`[OpenViking] ${line}`);
    });
    this.process.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) this.logger?.info(`[OpenViking] ${line}`);
    });

    // Handle process exit
    this.process.on("exit", (code: number | null, signal: string | null) => {
      this.ready = false;
      if (code !== 0 && code !== null) {
        this.logger?.error(`OpenViking exited with code ${code}`);
      } else if (signal) {
        this.logger?.info(`OpenViking killed with signal ${signal}`);
      }
    });

    // Wait for readiness
    await this.waitForReady(startupTimeoutMs!);
    this.ready = true;
    this.logger?.info("OpenViking server is ready");
  }

  /**
   * Wait for server to be ready
   */
  private async waitForReady(timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 500;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const health = await this.checkHealth(2000);
        if (health) return;
      } catch {
        // Keep waiting
      }
      await new Promise((r) => setTimeout(r, checkInterval));
    }

    // Timeout, kill process
    this.kill();
    throw new Error(`OpenViking failed to start within ${timeoutMs}ms`);
  }

  /**
   * Health check
   */
  private async checkHealth(timeoutMs = 5000): Promise<boolean> {
    const { host, port } = this.config;
    const url = `http://${host}:${port}/health`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Stop server
   */
  async stop(): Promise<void> {
    if (!this.process) return;
    this.logger?.info("Stopping OpenViking server...");
    return new Promise((resolve) => {
      const proc = this.process!;

      // Graceful shutdown
      proc.kill("SIGTERM");

      // Force kill after 5 seconds
      const forceKillTimeout = setTimeout(() => {
        this.logger?.warn?.("Force killing OpenViking server...");
        proc.kill("SIGKILL");
      }, 5000);

      proc.on("exit", () => {
        clearTimeout(forceKillTimeout);
        this.ready = false;
        this.process = undefined;
        resolve();
      });
    });
  }

  /**
   * Force kill the process
   */
  private kill(): void {
    if (this.process) {
      this.process.kill("SIGKILL");
      this.process = undefined;
    }
    this.ready = false;
  }

  /**
   * Check if ready
   */
  isReady(): boolean {
    return this.ready;
  }
}
