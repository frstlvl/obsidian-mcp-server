/**
 * Standalone Indexing Worker
 *
 * Runs as a detached background process to index the vault.
 * Survives Claude Desktop restarts and can be monitored independently.
 */

import { VectorStore } from "./embeddings.js";
import { logInfo, logError, logWarn, initLogger } from "./logger.js";
import * as fs from "fs/promises";
import * as path from "path";

interface WorkerConfig {
  vaultPath: string;
  configPath: string;
  vectorStorePath: string;
  model: string;
  pidFile: string;
}

async function loadConfig(): Promise<WorkerConfig> {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  const configPath = process.env.OBSIDIAN_CONFIG_PATH;

  if (!vaultPath) {
    throw new Error("OBSIDIAN_VAULT_PATH environment variable not set");
  }

  let config: any = {};
  if (configPath) {
    const configContent = await fs.readFile(configPath, "utf-8");
    config = JSON.parse(configContent);
  }

  const vectorStorePath =
    config.vectorSearch?.vectorStorePath ||
    path.join(vaultPath, ".mcp-vector-store");

  const model = config.vectorSearch?.model || "Xenova/all-MiniLM-L6-v2";

  const pidFile = path.join(vectorStorePath, "indexing-worker.pid");

  return {
    vaultPath,
    configPath: configPath || "",
    vectorStorePath,
    model,
    pidFile,
  };
}

async function writePidFile(pidFile: string): Promise<void> {
  const pidDir = path.dirname(pidFile);
  await fs.mkdir(pidDir, { recursive: true });
  await fs.writeFile(pidFile, process.pid.toString(), "utf-8");
  logInfo(`Worker PID ${process.pid} written to ${pidFile}`);
}

async function removePidFile(pidFile: string): Promise<void> {
  try {
    await fs.unlink(pidFile);
    logInfo("Worker PID file removed");
  } catch (error) {
    // Ignore errors (file might not exist)
  }
}

async function isAnotherWorkerRunning(pidFile: string): Promise<boolean> {
  try {
    const pidStr = await fs.readFile(pidFile, "utf-8");
    const pid = parseInt(pidStr.trim());

    // Check if process is running
    try {
      process.kill(pid, 0); // Signal 0 checks if process exists
      logWarn(`Another indexing worker (PID ${pid}) is already running`);
      return true;
    } catch {
      // Process doesn't exist, remove stale PID file
      await removePidFile(pidFile);
      return false;
    }
  } catch {
    // PID file doesn't exist
    return false;
  }
}

async function main() {
  try {
    // Initialize logger
    initLogger({ level: "debug", file: "" });

    logInfo("=== Indexing Worker Starting ===");

    const config = await loadConfig();

    // Check if another worker is already running
    if (await isAnotherWorkerRunning(config.pidFile)) {
      logWarn("Exiting: Another worker is already running");
      process.exit(0);
    }

    // Write PID file
    await writePidFile(config.pidFile);

    // Setup cleanup on exit
    const cleanup = async () => {
      await removePidFile(config.pidFile);
    };

    process.on("SIGINT", async () => {
      logInfo("Worker interrupted (SIGINT)");
      await cleanup();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      logInfo("Worker terminated (SIGTERM)");
      await cleanup();
      process.exit(0);
    });

    // Create vector store
    const vectorStore = new VectorStore(config.vaultPath, {
      provider: "transformers",
      model: config.model,
      vectorStorePath: config.vectorStorePath,
    });

    await vectorStore.initialize();

    logInfo(`Starting vault indexing: ${config.vaultPath}`);
    logInfo(`Model: ${config.model}`);
    logInfo(`Vector store: ${config.vectorStorePath}`);

    // Run indexing
    const stats = await vectorStore.indexVault(false);

    logInfo("=== Indexing Complete ===");
    logInfo(`Indexed: ${stats.indexed}`);
    logInfo(`Skipped: ${stats.skipped}`);
    logInfo(`Failed: ${stats.failed}`);

    // Cleanup and exit
    await cleanup();
    process.exit(0);
  } catch (error) {
    logError("Worker failed:", error);
    process.exit(1);
  }
}

// Run worker
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
