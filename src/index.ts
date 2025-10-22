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
import chokidar, { type FSWatcher } from "chokidar";
import * as path from "path";

async function main() {
  try {
    // Load configuration
    const config = await loadConfig();

    console.error("[MCP] Starting Obsidian MCP Server...");
    console.error(`[MCP] Vault path: ${config.vaultPath}`);
    console.error(
      `[MCP] Write operations: ${config.enableWrite ? "ENABLED" : "DISABLED"}`
    );

    // Initialize vector store if enabled
    let vectorStore: VectorStore | undefined;
    let watcher: FSWatcher | undefined;

    if (config.vectorSearch?.enabled) {
      console.error("[MCP] Initializing vector search...");
      console.error(`[MCP] Provider: ${config.vectorSearch.provider}`);

      try {
        vectorStore = new VectorStore(config.vaultPath, {
          provider: config.vectorSearch.provider,
          model: config.vectorSearch.model,
          anthropicApiKey: config.vectorSearch.anthropicApiKey,
        });

        await vectorStore.initialize();
        console.error("[MCP] Vector store initialized");

        // Index vault on startup if configured
        if (config.vectorSearch.indexOnStartup) {
          console.error(
            "[MCP] Auto-indexing vault (this may take a few moments)..."
          );
          const stats = await vectorStore.indexVault();
          console.error(
            `[MCP] Indexing complete: ${stats.indexed} indexed, ${stats.skipped} skipped, ${stats.failed} failed`
          );
        } else {
          const stats = await vectorStore.getStats();
          console.error(
            `[MCP] Vector store ready: ${stats.totalDocuments} documents indexed`
          );

          if (stats.totalDocuments === 0) {
            console.error(
              "[MCP] WARNING: Vector store is empty. Use indexOnStartup: true to index vault on startup."
            );
          }
        }

        // Setup file watcher for automatic index updates
        console.error(
          "[MCP] Setting up file system watcher for automatic index updates..."
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
            console.error(`[MCP] File added: ${relativePath}`);

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
            console.error(`[MCP] File changed: ${relativePath}`);

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
            console.error(`[MCP] File deleted: ${relativePath}`);

            // Cancel pending update if any
            if (updateQueue.has(relativePath)) {
              clearTimeout(updateQueue.get(relativePath)!);
              updateQueue.delete(relativePath);
            }

            // Remove from index immediately (no debounce needed for deletions)
            vectorStore!.removeNote(relativePath).catch((err) => {
              console.error(`[MCP] Failed to remove note: ${err}`);
            });
          })
          .on("error", (error: unknown) => {
            console.error("[MCP] File watcher error:", error);
          });

        console.error(
          "[MCP] File system watcher active - index will update automatically"
        );
      } catch (error) {
        console.error(
          "[MCP] WARNING: Failed to initialize vector search:",
          error
        );
        console.error("[MCP] Continuing without semantic search capability...");
        vectorStore = undefined;
      }
    } else {
      console.error(
        "[MCP] Vector search: DISABLED (enable in config for semantic search)"
      );
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

    console.error("[MCP] Server started successfully");
    console.error("[MCP] Listening on stdio transport...");
    console.error("[MCP] Ready for connections from Claude");

    // Store watcher in a way we can access it from signal handlers
    if (watcher) {
      (global as any).__fileWatcher = watcher;
    }
  } catch (error) {
    console.error("[MCP] FATAL: Failed to start server:", error);
    console.error(
      "[MCP] Stack trace:",
      error instanceof Error ? error.stack : "N/A"
    );
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.error("[MCP] Received SIGINT, shutting down gracefully...");
  const watcher = (global as any).__fileWatcher;
  if (watcher) {
    watcher.close();
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.error("[MCP] Received SIGTERM, shutting down gracefully...");
  const watcher = (global as any).__fileWatcher;
  if (watcher) {
    watcher.close();
  }
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  console.error("[MCP] Uncaught exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[MCP] Unhandled rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// Start the server
main();
