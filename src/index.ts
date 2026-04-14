#!/usr/bin/env node
/**
 * Obsidian MCP Server - Main Entry Point
 *
 * This MCP server provides real-time access to Obsidian vaults for Claude AI.
 * It enables dynamic querying and reading of notes without token limitations.
 *
 * Features:
 * - Resource listing and reading (all notes as URIs)
 * - Search tool with keyword, tag, and folder filtering
 * - Multiple response formats (JSON and Markdown)
 * - Safe path validation and security checks
 *
 * Usage:
 *   node dist/index.js
 *
 * Environment Variables:
 *   OBSIDIAN_VAULT_PATH - Path to Obsidian vault (required)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, resolveVaultConfig } from "./utils.js";
import type { ResolvedVaultConfig } from "./utils.js";
import { setupObsidianHandlers } from "./obsidian-server.js";
import { VectorStore } from "./embeddings.js";
import { VaultRegistry } from "./vault-registry.js";
import { initLogger, logInfo, logError, logWarn } from "./logger.js";
import chokidar, { type FSWatcher } from "chokidar";
import * as path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Module-scope registry for access from signal handlers
let vaultRegistry: VaultRegistry | undefined;

/**
 * Spawn a detached background worker to handle indexing for a specific vault.
 * The worker survives Claude Desktop restarts.
 */
function spawnIndexingWorker(vaultPath: string, vaultName: string): void {
  const workerScript = path.join(__dirname, "indexing-worker.js");
  const configPath = process.env.OBSIDIAN_CONFIG_PATH || "";

  const worker = spawn(
    process.execPath,
    ["--expose-gc", "--max-old-space-size=16384", workerScript],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        OBSIDIAN_VAULT_PATH: vaultPath,
        OBSIDIAN_CONFIG_PATH: configPath,
      },
    }
  );

  // Unref so the parent can exit without waiting
  worker.unref();

  logInfo(
    `Spawned indexing worker for vault "${vaultName}" (PID: ${worker.pid}) - runs independently`
  );
}

/**
 * Initialize vector store and file watcher for a single vault.
 * Returns the VectorStore and FSWatcher instances (or undefined if disabled).
 */
async function initializeVaultSearch(
  resolvedConfig: ResolvedVaultConfig
): Promise<{ vectorStore?: VectorStore; watcher?: FSWatcher }> {
  if (!resolvedConfig.vectorSearch.enabled) {
    logInfo(`Vector search DISABLED for vault "${resolvedConfig.name}"`);
    return {};
  }

  logInfo(`Initializing vector search for vault "${resolvedConfig.name}"...`);
  logInfo(`  Provider: ${resolvedConfig.vectorSearch.provider}`);
  logInfo(
    `  Model: ${resolvedConfig.vectorSearch.model || "Xenova/all-MiniLM-L6-v2 (default)"}`
  );

  const vectorStore = new VectorStore(resolvedConfig.path, {
    provider: resolvedConfig.vectorSearch.provider,
    model: resolvedConfig.vectorSearch.model,
    anthropicApiKey: resolvedConfig.vectorSearch.anthropicApiKey,
  });

  await vectorStore.initialize();
  logInfo(`Vector store initialized for vault "${resolvedConfig.name}"`);

  // Determine if indexing is needed
  const indexOnStartup = resolvedConfig.vectorSearch.indexOnStartup;
  let shouldIndex = false;
  let indexReason = "";

  if (indexOnStartup === true || indexOnStartup === "always") {
    shouldIndex = true;
    indexReason = "indexOnStartup set to always";
  } else if (indexOnStartup === false || indexOnStartup === "never") {
    shouldIndex = false;
    indexReason = "indexOnStartup disabled";
  } else {
    // "auto" mode (or undefined = default to auto)
    const decision = await vectorStore.shouldReindex();
    shouldIndex = decision.reindex;
    indexReason = decision.reason;
  }

  logInfo(`Vault "${resolvedConfig.name}": ${indexReason}`);

  if (shouldIndex) {
    logInfo(
      `Starting background indexing worker for vault "${resolvedConfig.name}"...`
    );
    spawnIndexingWorker(resolvedConfig.path, resolvedConfig.name);
  } else {
    const stats = await vectorStore.getStats();
    logInfo(
      `Vault "${resolvedConfig.name}" vector store ready: ${stats.totalDocuments} documents indexed`
    );
  }

  // Setup file watcher for automatic index updates
  logInfo(`Setting up file watcher for vault "${resolvedConfig.name}"...`);
  const watcher = chokidar.watch(resolvedConfig.path, {
    ignored: [
      /(^|[\/\\])\../, // dot files/folders
      /node_modules/,
      /.obsidian/,
      /_data/,
    ],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 100,
    },
  });

  // Debounce map to prevent rapid successive updates
  const updateQueue = new Map<string, NodeJS.Timeout>();
  const DEBOUNCE_DELAY = 2000;

  watcher
    .on("add", (filePath: string) => {
      if (!filePath.endsWith(".md")) return;

      const relativePath = path.relative(resolvedConfig.path, filePath);
      logInfo(`[${resolvedConfig.name}] File added: ${relativePath}`);

      if (updateQueue.has(relativePath)) {
        clearTimeout(updateQueue.get(relativePath)!);
      }
      updateQueue.set(
        relativePath,
        setTimeout(() => {
          vectorStore
            .indexSingleNote(relativePath)
            .then(() => updateQueue.delete(relativePath))
            .catch((err) => {
              logError(
                `[${resolvedConfig.name}] Failed to index added note: ${err}`
              );
              updateQueue.delete(relativePath);
            });
        }, DEBOUNCE_DELAY)
      );
    })
    .on("change", (filePath: string) => {
      if (!filePath.endsWith(".md")) return;

      const relativePath = path.relative(resolvedConfig.path, filePath);
      logInfo(`[${resolvedConfig.name}] File changed: ${relativePath}`);

      if (updateQueue.has(relativePath)) {
        clearTimeout(updateQueue.get(relativePath)!);
      }
      updateQueue.set(
        relativePath,
        setTimeout(() => {
          vectorStore
            .indexSingleNote(relativePath)
            .then(() => updateQueue.delete(relativePath))
            .catch((err) => {
              logError(
                `[${resolvedConfig.name}] Failed to index changed note: ${err}`
              );
              updateQueue.delete(relativePath);
            });
        }, DEBOUNCE_DELAY)
      );
    })
    .on("unlink", (filePath: string) => {
      if (!filePath.endsWith(".md")) return;

      const relativePath = path.relative(resolvedConfig.path, filePath);
      logInfo(`[${resolvedConfig.name}] File deleted: ${relativePath}`);

      if (updateQueue.has(relativePath)) {
        clearTimeout(updateQueue.get(relativePath)!);
        updateQueue.delete(relativePath);
      }

      vectorStore.removeNote(relativePath).catch((err) => {
        logError(`[${resolvedConfig.name}] Failed to remove note: ${err}`);
      });
    })
    .on("error", (error: unknown) => {
      logError(`[${resolvedConfig.name}] File watcher error:`, error);
    });

  logInfo(`File system watcher active for vault "${resolvedConfig.name}"`);

  return { vectorStore, watcher };
}

async function main() {
  try {
    // Load configuration
    const config = await loadConfig();

    // Initialize logger with config
    initLogger(config.logging);

    logInfo("Starting Obsidian MCP Server...");
    logInfo(
      `Configured vaults: ${config.vaults.map((v) => v.name).join(", ")}`
    );

    // Initialize vault registry
    const registry = new VaultRegistry();

    // Initialize each vault
    for (const vaultConfig of config.vaults) {
      const resolved = resolveVaultConfig(vaultConfig, config);

      logInfo(`Initializing vault "${resolved.name}" at ${resolved.path}`);
      logInfo(
        `  Write operations: ${resolved.enableWrite ? "ENABLED" : "DISABLED"}`
      );

      try {
        const { vectorStore, watcher } = await initializeVaultSearch(resolved);

        registry.register({
          config: resolved,
          vectorStore,
          watcher,
        });
      } catch (error) {
        logWarn(
          `WARNING: Failed to initialize vault "${resolved.name}":`,
          error
        );
        logWarn(
          `Registering vault "${resolved.name}" without vector search...`
        );
        // Register without vector search so the vault is still available for keyword search
        registry.register({ config: resolved });
      }
    }

    logInfo(`${registry.size} vault(s) initialized`);

    // Create MCP server instance
    const server = new McpServer({
      name: "obsidian-mcp-server",
      version: "2.0.0",
    });

    // Setup Obsidian-specific request handlers with vault registry
    setupObsidianHandlers(server, config, registry);

    // Create stdio transport
    const transport = new StdioServerTransport();

    // Connect server to transport
    await server.connect(transport);

    logInfo("Server started successfully");
    logInfo("Listening on stdio transport...");
    logInfo("Ready for connections from Claude");

    // Store registry at module scope for signal handlers
    vaultRegistry = registry;
  } catch (error) {
    logError("FATAL: Failed to start server:", error);
    logError("Stack trace:", error instanceof Error ? error.stack : "N/A");
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGINT", async () => {
  logInfo("Received SIGINT, shutting down gracefully...");
  if (vaultRegistry) {
    await vaultRegistry.shutdown();
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logInfo("Received SIGTERM, shutting down gracefully...");
  if (vaultRegistry) {
    await vaultRegistry.shutdown();
  }
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  logError("Uncaught exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  logError("Unhandled rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// Start the server
main();
