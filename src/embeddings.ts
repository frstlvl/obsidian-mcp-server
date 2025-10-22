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
import * as path from "path";
import * as fs from "fs/promises";

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
        console.error("[MCP Vector] Creating new index...");
        await this.index.createIndex();
      }

      console.error(
        `[MCP Vector] Vector store initialized at: ${this.config.vectorStorePath}`
      );
    } catch (error) {
      console.error("[MCP Vector] Failed to initialize:", error);
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
        console.error("[MCP Vector] Initializing transformer model...");
        this.transformerPipeline = await pipeline(
          "feature-extraction",
          this.config.model
        );
        console.error("[MCP Vector] Transformer model loaded");
      }

      const output = await this.transformerPipeline(text, {
        pooling: "mean",
        normalize: true,
      });

      return Array.from(output.data as Float32Array);
    } catch (error) {
      console.error("[MCP Vector] Transformer embedding failed:", error);
      throw new Error(`Failed to generate embedding: ${error}`);
    }
  }

  /**
   * Index entire vault
   */
  async indexVault(forceReindex: boolean = false): Promise<{
    indexed: number;
    skipped: number;
    failed: number;
  }> {
    const notes = await findAllNotes(this.vaultPath);
    const stats = { indexed: 0, skipped: 0, failed: 0 };

    const existingIndex = await this.loadIndexMetadata();

    console.error(`[MCP Vector] Starting indexing: ${notes.length} notes`);

    for (const note of notes) {
      try {
        const relativePath = note.relativePath;
        const fullPath = path.join(this.vaultPath, relativePath);

        // Skip if already indexed and not changed
        if (!forceReindex && existingIndex[relativePath]) {
          const stat = await fs.stat(fullPath);
          if (stat.mtimeMs === existingIndex[relativePath].lastModified) {
            stats.skipped++;
            continue;
          }
        }

        const noteData = await readNote(fullPath);
        const embeddingText = this.prepareTextForEmbedding({
          content: noteData.content,
          frontmatter: noteData.frontmatter || {},
        });

        const embedding = await this.generateEmbedding(embeddingText);

        // Add to Vectra index using insertItem API
        await this.index.insertItem({
          id: relativePath,
          vector: embedding,
          metadata: {
            title:
              noteData.frontmatter?.title ||
              note.title ||
              path.basename(relativePath, ".md"),
            path: relativePath,
            tags: noteData.frontmatter?.tags?.join(",") || "",
            lastIndexed: Date.now(),
            excerpt: noteData.content.substring(0, 1000),
          },
        });

        // Update metadata
        const fileStat = await fs.stat(fullPath);
        existingIndex[relativePath] = {
          lastModified: fileStat.mtimeMs,
          lastIndexed: Date.now(),
        };

        stats.indexed++;

        if (stats.indexed % 10 === 0) {
          console.error(
            `[MCP Vector] Indexed ${stats.indexed}/${notes.length} notes`
          );
        }
      } catch (error) {
        console.error(
          `[MCP Vector] Failed to index ${note.relativePath}:`,
          error
        );
        stats.failed++;
      }
    }

    await this.saveIndexMetadata(existingIndex);

    console.error(`[MCP Vector] Indexing complete:`, stats);
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

    const lastIndexedTimes = Object.values(metadata)
      .map((m) => m.lastIndexed)
      .filter((t) => t > 0);

    return {
      totalDocuments: items.length,
      lastIndexed:
        lastIndexedTimes.length > 0 ? Math.max(...lastIndexedTimes) : undefined,
    };
  }

  /**
   * Load index metadata
   */
  private async loadIndexMetadata(): Promise<
    Record<
      string,
      {
        lastModified: number;
        lastIndexed: number;
      }
    >
  > {
    try {
      const data = await fs.readFile(this.indexPath, "utf-8");
      return JSON.parse(data);
    } catch (error) {
      return {};
    }
  }

  /**
   * Save index metadata
   */
  private async saveIndexMetadata(
    metadata: Record<string, any>
  ): Promise<void> {
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
        console.error(`[MCP Vector] File not found: ${relativePath}`);
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
          tags: noteData.frontmatter?.tags?.join(",") || "",
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

      console.error(`[MCP Vector] Indexed note: ${relativePath}`);
    } catch (error) {
      console.error(
        `[MCP Vector] Failed to index ${relativePath}:`,
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

        console.error(`[MCP Vector] Removed note from index: ${relativePath}`);
      }
    } catch (error) {
      console.error(
        `[MCP Vector] Failed to remove ${relativePath}:`,
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
