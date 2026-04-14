/**
 * Vault Registry - Multi-Vault Context Manager
 *
 * Manages a collection of vault contexts, each holding:
 * - Vault configuration (resolved with server defaults)
 * - VectorStore instance (for semantic search)
 * - File watcher reference (chokidar)
 *
 * Provides lookup by vault name, cross-vault iteration,
 * and vault name validation with helpful error messages.
 */

import type { VectorStore } from "./embeddings.js";
import type { FSWatcher } from "chokidar";
import type { ResolvedVaultConfig } from "./utils.js";
import { logInfo } from "./logger.js";

export interface VaultContext {
  config: ResolvedVaultConfig;
  vectorStore?: VectorStore;
  watcher?: FSWatcher;
}

/**
 * Registry holding all configured vault contexts.
 *
 * Usage:
 *   const registry = new VaultRegistry();
 *   registry.register({ config, vectorStore, watcher });
 *   const ctx = registry.getVault("work");
 */
export class VaultRegistry {
  private vaults: Map<string, VaultContext> = new Map();

  /**
   * Register a vault context. Throws if a vault with the same name exists.
   */
  register(ctx: VaultContext): void {
    const name = ctx.config.name;
    if (this.vaults.has(name)) {
      throw new Error(`Vault already registered: "${name}"`);
    }
    this.vaults.set(name, ctx);
    logInfo(`Vault registered: "${name}" -> ${ctx.config.path}`);
  }

  /**
   * Get a vault context by name. Returns undefined if not found.
   */
  getVault(name: string): VaultContext | undefined {
    return this.vaults.get(name);
  }

  /**
   * Get all registered vault contexts.
   */
  getAllVaults(): VaultContext[] {
    return Array.from(this.vaults.values());
  }

  /**
   * Get all registered vault names.
   */
  getVaultNames(): string[] {
    return Array.from(this.vaults.keys());
  }

  /**
   * Number of registered vaults.
   */
  get size(): number {
    return this.vaults.size;
  }

  /**
   * Resolve a vault name from a tool parameter.
   *
   * - If name is "*", returns null (caller handles cross-vault fan-out).
   * - If name matches a registered vault, returns that context.
   * - Otherwise, throws an error listing available vault names.
   */
  resolveVault(name: string): VaultContext | null {
    if (name === "*") {
      return null; // Cross-vault sentinel
    }

    const ctx = this.vaults.get(name);
    if (!ctx) {
      const available = this.getVaultNames();
      throw new Error(
        `Unknown vault: "${name}". Available vaults: ${available.join(", ")}`
      );
    }
    return ctx;
  }

  /**
   * Resolve a vault name for write operations.
   *
   * Same as resolveVault but rejects "*" since writes must target a single vault.
   */
  resolveWriteVault(name: string): VaultContext {
    if (name === "*") {
      const available = this.getVaultNames();
      throw new Error(
        `Write operations require a specific vault name, not "*". Available vaults: ${available.join(", ")}`
      );
    }

    const ctx = this.resolveVault(name);
    if (!ctx) {
      // Should not happen since "*" is handled above, but TypeScript safety
      throw new Error(`Could not resolve vault: "${name}"`);
    }

    if (!ctx.config.enableWrite) {
      throw new Error(
        `Vault "${name}" is read-only. Set enableWrite: true in config to allow write operations.`
      );
    }

    return ctx;
  }

  /**
   * Close all watchers and clean up resources.
   */
  async shutdown(): Promise<void> {
    for (const [name, ctx] of this.vaults) {
      if (ctx.watcher) {
        await ctx.watcher.close();
        logInfo(`File watcher closed for vault: "${name}"`);
      }
    }
  }
}
