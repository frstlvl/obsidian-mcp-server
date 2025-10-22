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
import { loadConfig } from "./utils.js";
import { setupObsidianHandlers } from "./obsidian-server.js";
import { VectorStore } from "./embeddings.js";
import { initLogger, logInfo, logError, logWarn } from "./logger.js";
import chokidar, { type FSWatcher } from "chokidar";
import * as path from "path";

async function main() {
  try {
    // Load configuration
    const config = await loadConfig();

    // Initialize logger with config
    initLogger(config.logging);

    logInfo("Starting Obsidian MCP Server...");
    logInfo(`Vault path: ${config.vaultPath}`);
    logInfo(`Write operations: ${config.enableWrite ? "ENABLED" : "DISABLED"}`);

    // Initialize vector store if enabled
    let vectorStore: VectorStore | undefined;
    let watcher: FSWatcher | undefined;

    if (config.vectorSearch?.enabled) {
      logInfo("Initializing vector search...");
      logInfo(`Provider: ${config.vectorSearch.provider}`);

      try {
        vectorStore = new VectorStore(config.vaultPath, {
          provider: config.vectorSearch.provider,
          model: config.vectorSearch.model,
          anthropicApiKey: config.vectorSearch.anthropicApiKey,
        });

        await vectorStore.initialize();
        logInfo("Vector store initialized");

        // Determine if indexing is needed
        const indexOnStartup = config.vectorSearch.indexOnStartup;
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

        logInfo(indexReason);

        if (shouldIndex) {
          logInfo("Indexing vault (this may take a few moments)...");
          const stats = await vectorStore.indexVault();
          logInfo(
            `Indexing complete: ${stats.indexed} indexed, ${stats.skipped} skipped, ${stats.failed} failed`
          );
        } else {
          const stats = await vectorStore.getStats();
          logInfo(
            `Vector store ready: ${stats.totalDocuments} documents indexed`
          );
        }

        // Setup file watcher for automatic index updates
        logInfo(
          "Setting up file system watcher for automatic index updates..."
        );
        watcher = chokidar.watch(config.vaultPath, {
          ignored: [
            /(^|[\/\\])\../, // dot files/folders
            /node_modules/,
            /.obsidian/,
            /_data/,
          ],
          persistent: true,
          ignoreInitial: true, // Don't trigger for existing files
          awaitWriteFinish: {
            stabilityThreshold: 1000, // Wait 1s for file writes to finish
            pollInterval: 100,
          },
        });

        // Debounce map to prevent rapid successive updates
        const updateQueue = new Map<string, NodeJS.Timeout>();
        const DEBOUNCE_DELAY = 2000; // 2 seconds

        watcher
          .on("add", (filePath: string) => {
            if (!filePath.endsWith(".md")) return;

            const relativePath = path.relative(config.vaultPath, filePath);
            logInfo(`File added: ${relativePath}`);

            // Debounce: clear existing timeout and set new one
            if (updateQueue.has(relativePath)) {
              clearTimeout(updateQueue.get(relativePath)!);
            }
            updateQueue.set(
              relativePath,
              setTimeout(async () => {
                await vectorStore!.indexSingleNote(relativePath);
                updateQueue.delete(relativePath);
              }, DEBOUNCE_DELAY)
            );
          })
          .on("change", (filePath: string) => {
            if (!filePath.endsWith(".md")) return;

            const relativePath = path.relative(config.vaultPath, filePath);
            logInfo(`File changed: ${relativePath}`);

            // Debounce: clear existing timeout and set new one
            if (updateQueue.has(relativePath)) {
              clearTimeout(updateQueue.get(relativePath)!);
            }
            updateQueue.set(
              relativePath,
              setTimeout(async () => {
                await vectorStore!.indexSingleNote(relativePath);
                updateQueue.delete(relativePath);
              }, DEBOUNCE_DELAY)
            );
          })
          .on("unlink", (filePath: string) => {
            if (!filePath.endsWith(".md")) return;

            const relativePath = path.relative(config.vaultPath, filePath);
            logInfo(`File deleted: ${relativePath}`);

            // Cancel pending update if any
            if (updateQueue.has(relativePath)) {
              clearTimeout(updateQueue.get(relativePath)!);
              updateQueue.delete(relativePath);
            }

            // Remove from index immediately (no debounce needed for deletions)
            vectorStore!.removeNote(relativePath).catch((err) => {
              logError(`Failed to remove note: ${err}`);
            });
          })
          .on("error", (error: unknown) => {
            logError("File watcher error:", error);
          });

        logInfo("File system watcher active - index will update automatically");
      } catch (error) {
        logWarn("WARNING: Failed to initialize vector search:", error);
        logWarn("Continuing without semantic search capability...");
        vectorStore = undefined;
      }
    } else {
      logInfo("Vector search: DISABLED (enable in config for semantic search)");
    }

    // Create MCP server instance
    const server = new McpServer({
      name: "obsidian-mcp-server",
      version: "1.0.0",
    });

    // Setup Obsidian-specific request handlers
    setupObsidianHandlers(server, config, vectorStore);

    // Create stdio transport
    const transport = new StdioServerTransport();

    // Connect server to transport
    await server.connect(transport);

    logInfo("Server started successfully");
    logInfo("Listening on stdio transport...");
    logInfo("Ready for connections from Claude");

    // Store watcher in a way we can access it from signal handlers
    if (watcher) {
      (global as any).__fileWatcher = watcher;
    }
  } catch (error) {
    logError("FATAL: Failed to start server:", error);
    logError("Stack trace:", error instanceof Error ? error.stack : "N/A");
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  logInfo("Received SIGINT, shutting down gracefully...");
  const watcher = (global as any).__fileWatcher;
  if (watcher) {
    watcher.close();
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  logInfo("Received SIGTERM, shutting down gracefully...");
  const watcher = (global as any).__fileWatcher;
  if (watcher) {
    watcher.close();
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
