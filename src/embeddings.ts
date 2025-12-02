/**
 * Vector Embeddings Module for Semantic Search
 *
 * Provides:
 * - Embedding generation with Transformers.js (local)
 * - Vector storage with Vectra (local vector database)
 * - Semantic similarity search
 * - Hybrid search (keyword + semantic)
 * - Incremental indexing (only changed notes)
 */

import { LocalIndex } from "vectra";
import { pipeline } from "@xenova/transformers";
import { findAllNotes, readNote } from "./utils.js";
import { logInfo, logError, logWarn, logDebug } from "./logger.js";
import * as path from "path";
import * as fs from "fs/promises";

const EMBEDDING_TIMEOUT_MS = 30000; // 30 second timeout for embedding generation

/**
 * Wraps a promise with a timeout
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    ),
  ]);
}

export interface EmbeddingConfig {
  provider: "anthropic" | "transformers";
  anthropicApiKey?: string;
  model?: string;
  vectorStorePath?: string;
}

export interface VectorSearchResult {
  id: string;
  path: string;
  title: string;
  score: number;
  excerpt: string;
  metadata: Record<string, any>;
}

export interface VectorSearchOptions {
  limit?: number;
  minScore?: number;
  filter?: Record<string, any>;
}

export interface IndexMetadataMeta {
  model: string;
  modelDimensions?: number;
  provider: string;
  createdAt: number;
  lastIndexedAt: number;
  version: string;
}

export interface IndexMetadata {
  __meta__?: IndexMetadataMeta;
  [notePath: string]:
    | {
        lastModified: number;
        lastIndexed: number;
      }
    | IndexMetadataMeta
    | undefined;
}

/**
 * Helper function to safely convert tags to a comma-separated string
 */
function tagsToString(tags: any): string {
  if (!tags) return "";
  if (Array.isArray(tags)) return tags.join(",");
  if (typeof tags === "string") return tags;
  return String(tags);
}

/**
 * Vector Store Manager
 * Handles embedding generation and semantic search using Vectra
 */
export class VectorStore {
  private index: LocalIndex;
  private transformerPipeline: any = null;
  private config: EmbeddingConfig;
  private vaultPath: string;
  private indexPath: string;

  constructor(vaultPath: string, config: EmbeddingConfig) {
    this.vaultPath = vaultPath;
    this.config = {
      ...config,
      provider: config.provider || "transformers",
      model: config.model || "Xenova/all-MiniLM-L6-v2",
      vectorStorePath:
        config.vectorStorePath || path.join(vaultPath, ".mcp-vector-store"),
    };

    this.indexPath = path.join(
      this.config.vectorStorePath!,
      "index-metadata.json"
    );

    // Initialize Vectra local index
    this.index = new LocalIndex(this.config.vectorStorePath!);
  }

  /**
   * Initialize vector store
   */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.config.vectorStorePath!, { recursive: true });

      const indexExists = await this.index.isIndexCreated();

      if (!indexExists) {
        logInfo("Creating new index...");
        await this.index.createIndex();
      }

      logInfo(`Vector store initialized at: ${this.config.vectorStorePath}`);
    } catch (error) {
      logError("Failed to initialize:", error);
      throw error;
    }
  }

  /**
   * Generate embedding for text
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    if (this.config.provider === "transformers") {
      return this.generateTransformerEmbedding(text);
    } else {
      throw new Error(
        `Anthropic embeddings not yet available. Use transformers provider.`
      );
    }
  }

  /**
   * Generate embedding using Transformers.js
   */
  private async generateTransformerEmbedding(text: string): Promise<number[]> {
    try {
      if (!this.transformerPipeline) {
        logInfo("Initializing transformer model...");
        this.transformerPipeline = await pipeline(
          "feature-extraction",
          this.config.model
        );
        logInfo("Transformer model loaded");
      }

      const output = await this.transformerPipeline(text, {
        pooling: "mean",
        normalize: true,
      });

      return Array.from(output.data as Float32Array);
    } catch (error) {
      logError("Transformer embedding failed:", error);
      throw new Error(`Failed to generate embedding: ${error}`);
    }
  }

  /**
   * Dispose of the transformer pipeline to free resources
   */
  private async disposeTransformerPipeline(): Promise<void> {
    if (this.transformerPipeline) {
      logDebug("Disposing transformer pipeline to free resources...");
      // @ts-ignore - dispose method may not be typed
      if (typeof this.transformerPipeline.dispose === "function") {
        await this.transformerPipeline.dispose();
      }
      this.transformerPipeline = null;

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }
    }
  }

  /**
   * Process a batch of notes in parallel
   */
  private async processBatch(
    batch: Array<{ title?: string; relativePath: string }>,
    existingIndex: IndexMetadata,
    forceReindex: boolean
  ): Promise<{
    results: Array<{
      relativePath: string;
      embedding: number[];
      noteData: any;
      fileStat: any;
    } | null>;
    skipped: number;
    failed: number;
  }> {
    let skipped = 0;
    let failed = 0;

    const results = await Promise.all(
      batch.map(async (note) => {
        try {
          const relativePath = note.relativePath;
          const fullPath = path.join(this.vaultPath, relativePath);

          // Skip if already indexed and not changed
          if (!forceReindex && existingIndex[relativePath]) {
            const entry = existingIndex[relativePath];
            if (entry && "lastModified" in entry) {
              const stat = await fs.stat(fullPath);
              if (stat.mtimeMs === entry.lastModified) {
                skipped++;
                return null;
              }
            }
          }

          const noteData = await readNote(fullPath);
          const embeddingText = this.prepareTextForEmbedding({
            content: noteData.content,
            frontmatter: noteData.frontmatter || {},
          });

          // Generate embedding with timeout
          const embedding = await withTimeout(
            this.generateEmbedding(embeddingText),
            EMBEDDING_TIMEOUT_MS,
            `Embedding generation timed out after ${EMBEDDING_TIMEOUT_MS}ms`
          );

          const fileStat = await fs.stat(fullPath);

          return {
            relativePath,
            embedding,
            noteData,
            fileStat,
          };
        } catch (error) {
          logError(`Failed to process ${note.relativePath}:`, error);
          failed++;
          return null;
        }
      })
    );

    return { results, skipped, failed };
  }

  /**
   * Index entire vault with batch processing
   */
  async indexVault(forceReindex: boolean = false): Promise<{
    indexed: number;
    skipped: number;
    failed: number;
  }> {
    const notes = await findAllNotes(this.vaultPath);
    const stats = { indexed: 0, skipped: 0, failed: 0 };

    const existingIndex = await this.loadIndexMetadata();

    logInfo(`Starting batch indexing: ${notes.length} notes`);

    // Begin Vectra transaction for batch updates
    await this.index.beginUpdate();

    // Process notes in batches for parallel embedding generation
    const BATCH_SIZE = 10; // Process 10 notes in parallel
    const CHECKPOINT_INTERVAL = 50; // Save checkpoint every 50 notes

    for (let i = 0; i < notes.length; i += BATCH_SIZE) {
      const batch = notes.slice(i, i + BATCH_SIZE);

      logDebug(
        `Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(notes.length / BATCH_SIZE)} (notes ${i + 1}-${Math.min(i + BATCH_SIZE, notes.length)})`
      );

      // Process batch in parallel
      const { results, skipped, failed } = await this.processBatch(
        batch,
        existingIndex,
        forceReindex
      );

      stats.skipped += skipped;
      stats.failed += failed;

      // Insert successfully processed notes into index
      for (const result of results) {
        if (!result) continue;

        try {
          const { relativePath, embedding, noteData, fileStat } = result;

          logDebug(`Inserting into index: ${relativePath}`);

          // Add to Vectra index
          await this.index.insertItem({
            id: relativePath,
            vector: embedding,
            metadata: {
              title:
                noteData.frontmatter?.title ||
                path.basename(relativePath, ".md"),
              path: relativePath,
              tags: tagsToString(noteData.frontmatter?.tags),
              lastIndexed: Date.now(),
              excerpt: noteData.content.substring(0, 1000),
            },
          });

          // Update metadata
          existingIndex[relativePath] = {
            lastModified: fileStat.mtimeMs,
            lastIndexed: Date.now(),
          };

          stats.indexed++;
        } catch (error) {
          logError(`Failed to insert ${result.relativePath}:`, error);
          stats.failed++;
        }
      }

      if (stats.indexed % 10 === 0) {
        logInfo(
          `Indexed ${stats.indexed}/${notes.length} notes (${stats.failed} failed, ${stats.skipped} skipped)`
        );
      }

      // Periodically save progress and trigger garbage collection
      if (stats.indexed > 0 && stats.indexed % CHECKPOINT_INTERVAL === 0) {
        logInfo(`Saving progress checkpoint at ${stats.indexed} notes...`);
        // End current transaction to persist to disk
        await this.index.endUpdate();
        await this.saveIndexMetadata(existingIndex);
        // Begin new transaction for next batch
        await this.index.beginUpdate();
        // Force garbage collection if available
        if (global.gc) {
          logDebug("Running garbage collection...");
          global.gc();
        }
      }

      // Periodically dispose and recreate transformer pipeline to prevent memory leaks
      if (stats.indexed > 0 && stats.indexed % 500 === 0) {
        logInfo(
          `Refreshing transformer pipeline at ${stats.indexed} notes to prevent memory buildup...`
        );
        await this.disposeTransformerPipeline();
        // Give system time to fully clean up before recreating
        await new Promise((resolve) => setTimeout(resolve, 1000));
        logInfo("Pipeline disposed, will recreate on next embedding...");
      }

      // Small delay between batches to prevent overwhelming the system
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Update metadata with model info
    existingIndex.__meta__ = {
      model: this.config.model!,
      provider: this.config.provider,
      createdAt: existingIndex.__meta__?.createdAt || Date.now(),
      lastIndexedAt: Date.now(),
      version: "1.4.0", // Update this with actual version
    };

    // End Vectra transaction to persist final batch
    await this.index.endUpdate();
    await this.saveIndexMetadata(existingIndex);

    logInfo(
      `Indexing completed: indexed=${stats.indexed}, skipped=${stats.skipped}, failed=${stats.failed}`
    );

    if (stats.failed > 0) {
      logWarn(
        `⚠️  ${stats.failed} notes failed to index. Check logs for details on which notes were skipped.`
      );
    }

    return stats;
  }

  /**
   * Prepare note text for embedding
   */
  private prepareTextForEmbedding(noteData: {
    content: string;
    frontmatter: any;
  }): string {
    const parts: string[] = [];

    if (noteData.frontmatter?.title) {
      parts.push(`Title: ${noteData.frontmatter.title}`);
    }

    if (noteData.frontmatter?.description) {
      parts.push(`Description: ${noteData.frontmatter.description}`);
    }

    if (noteData.frontmatter?.tags) {
      const tags = Array.isArray(noteData.frontmatter.tags)
        ? noteData.frontmatter.tags
        : [noteData.frontmatter.tags];
      if (tags.length > 0) {
        parts.push(`Tags: ${tags.join(", ")}`);
      }
    }

    const contentPreview = noteData.content
      .replace(/^---[\s\S]*?---/, "")
      .substring(0, 2000)
      .trim();

    parts.push(contentPreview);

    return parts.join("\n\n");
  }

  /**
   * Search for similar notes
   */
  async search(
    query: string,
    options: VectorSearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const limit = options.limit || 10;
    const minScore = options.minScore || 0.0;

    const queryEmbedding = await this.generateEmbedding(query);

    // Vectra's queryItems expects: vector, query string, topK
    // Since we're doing vector search, query string can be empty
    const results = await this.index.queryItems(queryEmbedding, "", limit + 10);

    const searchResults: VectorSearchResult[] = [];

    for (const result of results) {
      if (result.score >= minScore) {
        const item = result.item as any; // Type assertion for Vectra item
        searchResults.push({
          id: item.id,
          path: String(item._metadata?.path || item.id),
          title: String(item._metadata?.title || path.basename(item.id, ".md")),
          score: result.score,
          excerpt:
            String(item._metadata?.excerpt || "").substring(0, 200) + "...",
          metadata: item._metadata || {},
        });
      }

      if (searchResults.length >= limit) break;
    }

    return searchResults;
  }

  /**
   * Hybrid search
   */
  async hybridSearch(
    query: string,
    keywordResults: Array<{ path: string; score: number; excerpt: string }>,
    options: VectorSearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const semanticResults = await this.search(query, options);

    const combinedMap = new Map<string, VectorSearchResult>();

    // Add semantic results (weight: 0.6)
    for (const result of semanticResults) {
      combinedMap.set(result.path, {
        ...result,
        score: result.score * 0.6,
      });
    }

    // Add/merge keyword results (weight: 0.4)
    for (const kwResult of keywordResults) {
      const existing = combinedMap.get(kwResult.path);
      if (existing) {
        existing.score += kwResult.score * 0.4;
        if (kwResult.score > 0.5) {
          existing.excerpt = kwResult.excerpt;
        }
      } else {
        combinedMap.set(kwResult.path, {
          id: kwResult.path,
          path: kwResult.path,
          title: path.basename(kwResult.path, ".md"),
          score: kwResult.score * 0.4,
          excerpt: kwResult.excerpt,
          metadata: {},
        });
      }
    }

    const results = Array.from(combinedMap.values());
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, options.limit || 10);
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{
    totalDocuments: number;
    lastIndexed?: number;
  }> {
    const items = await this.index.listItems();
    const metadata = await this.loadIndexMetadata();

    const lastIndexedTimes = Object.entries(metadata)
      .filter(([key]) => key !== "__meta__")
      .map(([, value]) => value)
      .filter(
        (m): m is { lastModified: number; lastIndexed: number } =>
          m !== undefined && "lastIndexed" in m
      )
      .map((m) => m.lastIndexed)
      .filter((t) => t > 0);

    return {
      totalDocuments: items.length,
      lastIndexed:
        lastIndexedTimes.length > 0 ? Math.max(...lastIndexedTimes) : undefined,
    };
  }

  /**
   * Check if re-indexing is needed (auto mode)
   */
  async shouldReindex(): Promise<{
    reindex: boolean;
    reason: string;
  }> {
    try {
      // Check if index directory exists
      const indexExists = await this.index.isIndexCreated();
      if (!indexExists) {
        return {
          reindex: true,
          reason: "No existing index found (first-time setup)",
        };
      }

      // Load metadata
      const metadata = await this.loadIndexMetadata();

      // Check if metadata has model info
      if (!metadata.__meta__) {
        return {
          reindex: true,
          reason: "Legacy index detected (no model metadata), upgrading",
        };
      }

      // Check model compatibility
      const currentModel = this.config.model || "Xenova/all-MiniLM-L6-v2";
      const storedModel = metadata.__meta__.model;

      if (storedModel !== currentModel) {
        return {
          reindex: true,
          reason: `Model changed: ${storedModel} → ${currentModel}`,
        };
      }

      // Check index health
      const stats = await this.getStats();
      if (stats.totalDocuments === 0) {
        return {
          reindex: true,
          reason: "Index exists but is empty",
        };
      }

      // All checks passed
      return {
        reindex: false,
        reason: "Index valid and up-to-date",
      };
    } catch (error) {
      return {
        reindex: true,
        reason: `Index validation failed: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  }

  /**
   * Load index metadata
   */
  private async loadIndexMetadata(): Promise<IndexMetadata> {
    try {
      const data = await fs.readFile(this.indexPath, "utf-8");
      return JSON.parse(data) as IndexMetadata;
    } catch (error) {
      return {};
    }
  }

  /**
   * Save index metadata
   */
  private async saveIndexMetadata(metadata: IndexMetadata): Promise<void> {
    await fs.writeFile(
      this.indexPath,
      JSON.stringify(metadata, null, 2),
      "utf-8"
    );
  }

  /**
   * Index a single note (for file watcher updates)
   */
  async indexSingleNote(relativePath: string): Promise<void> {
    try {
      const fullPath = path.join(this.vaultPath, relativePath);

      // Check if file exists and is a markdown file
      try {
        await fs.access(fullPath);
      } catch {
        logWarn(`File not found: ${relativePath}`);
        return;
      }

      if (!relativePath.endsWith(".md")) {
        return;
      }

      const noteData = await readNote(fullPath);
      const embeddingText = this.prepareTextForEmbedding({
        content: noteData.content,
        frontmatter: noteData.frontmatter || {},
      });

      const embedding = await this.generateEmbedding(embeddingText);

      // Check if document already exists and remove it
      const existingItems = await this.index.listItems();
      const existingItem = existingItems.find(
        (item) => item.id === relativePath
      );
      if (existingItem) {
        await this.index.deleteItem(relativePath);
      }

      // Add to Vectra index
      await this.index.insertItem({
        id: relativePath,
        vector: embedding,
        metadata: {
          title:
            noteData.frontmatter?.title || path.basename(relativePath, ".md"),
          path: relativePath,
          tags: tagsToString(noteData.frontmatter?.tags),
          lastIndexed: Date.now(),
          excerpt: noteData.content.substring(0, 1000),
        },
      });

      // Update metadata
      const metadata = await this.loadIndexMetadata();
      const fileStat = await fs.stat(fullPath);
      metadata[relativePath] = {
        lastModified: fileStat.mtimeMs,
        lastIndexed: Date.now(),
      };
      await this.saveIndexMetadata(metadata);

      logInfo(`Indexed note: ${relativePath}`);
    } catch (error) {
      logError(
        `Failed to index ${relativePath}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Remove a note from the index (for file deletion)
   */
  async removeNote(relativePath: string): Promise<void> {
    try {
      const existingItems = await this.index.listItems();
      const existingItem = existingItems.find(
        (item) => item.id === relativePath
      );
      if (existingItem) {
        await this.index.deleteItem(relativePath);

        // Update metadata
        const metadata = await this.loadIndexMetadata();
        delete metadata[relativePath];
        await this.saveIndexMetadata(metadata);

        logInfo(`Removed note from index: ${relativePath}`);
      }
    } catch (error) {
      logError(
        `Failed to remove ${relativePath}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Clear vector store
   */
  async clear(): Promise<void> {
    await this.index.deleteIndex();

    try {
      await fs.unlink(this.indexPath);
    } catch (error) {
      // Ignore if doesn't exist
    }
  }
}
