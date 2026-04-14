/**
 * Core MCP Server Request Handlers for Obsidian Vault Access
 *
 * Implements MCP protocol handlers for:
 * - Resources (list, read)
 * - Tools (search_vault)
 *
 * Following MCP best practices:
 * - Zod input validation
 * - Multiple response formats (JSON/Markdown)
 * - Character limits and truncation
 * - Proper error handling
 * - Tool annotations
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./utils.js";
import { searchVault, SearchOptions, SearchResult } from "./search.js";
import { createNote, updateNote, deleteNote } from "./utils.js";
import { VaultRegistry, VaultContext } from "./vault-registry.js";
import { logInfo, logError } from "./logger.js";
import * as fs from "fs/promises";
import * as path from "path";

// Response format enum
enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

// Common vault parameter for read tools (accepts "*" for cross-vault)
const vaultReadParam = z
  .string()
  .min(1, "Vault name must not be empty")
  .describe(
    'Required: Name of the vault to search. Use a specific vault name, or "*" to search all vaults. Call obsidian_list_vaults to see available vault names.'
  );

// Common vault parameter for write tools (rejects "*")
const vaultWriteParam = z
  .string()
  .min(1, "Vault name must not be empty")
  .refine((v) => v !== "*", {
    message:
      'Write operations require a specific vault name, not "*". Call obsidian_list_vaults to see available vault names.',
  })
  .describe(
    "Required: Name of the vault to write to. Must be a specific vault name (not \"*\"). Call obsidian_list_vaults to see available vault names."
  );

// Zod schemas for tool input validation
const SearchVaultInputSchema = z
  .object({
    vault: vaultReadParam,
    query: z
      .string()
      .min(1, "Query must not be empty")
      .max(500, "Query must not exceed 500 characters")
      .describe(
        "Search keywords to match against note titles, content, and tags. Supports multiple terms (space-separated)."
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        'Optional: Filter results to notes containing ALL specified tags (e.g., ["project", "active"])'
      ),
    folders: z
      .array(z.string())
      .optional()
      .describe(
        'Optional: Limit search to specific folder paths (e.g., ["Projects", "Work/Documents"])'
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("Maximum number of results to return (default: 20, max: 100)"),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .optional()
      .describe("Number of results to skip for pagination (default: 0)"),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe(
        'Output format: "markdown" for human-readable or "json" for machine-readable (default: markdown)'
      ),
  })
  .strict();

type SearchVaultInput = z.infer<typeof SearchVaultInputSchema>;

// Zod schema for semantic search (vector search)
const SemanticSearchInputSchema = z
  .object({
    vault: vaultReadParam,
    query: z
      .string()
      .min(1, "Query must not be empty")
      .max(500, "Query must not exceed 500 characters")
      .describe(
        "Natural language query describing what you're looking for. Uses semantic similarity instead of keyword matching."
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Maximum number of results to return (default: 10, max: 50)"),
    min_score: z
      .number()
      .min(0)
      .max(1)
      .default(0.5)
      .optional()
      .describe(
        "Minimum similarity score threshold (0-1, default: 0.5). Higher values = more relevant results."
      ),
    hybrid: z
      .boolean()
      .default(false)
      .describe(
        "If true, combines semantic search with keyword search for better results (default: false)"
      ),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe(
        'Output format: "markdown" for human-readable or "json" for machine-readable (default: markdown)'
      ),
  })
  .strict();

type SemanticSearchInput = z.infer<typeof SemanticSearchInputSchema>;

// Zod schemas for write operations (Phase 2)
const CreateNoteInputSchema = z
  .object({
    vault: vaultWriteParam,
    path: z
      .string()
      .min(1, "Path must not be empty")
      .max(500, "Path must not exceed 500 characters")
      .describe(
        "Relative path within vault where note should be created (e.g., 'Projects/NewNote.md' or 'Notes/Ideas/Idea.md'). .md extension is optional."
      ),
    content: z
      .string()
      .max(100000, "Content must not exceed 100,000 characters")
      .describe(
        "Note content (markdown text). Frontmatter will be added separately."
      ),
    frontmatter: z
      .record(z.any())
      .optional()
      .describe(
        "Optional frontmatter object (e.g., {title: 'My Note', tags: ['project', 'active'], date: '2025-01-20'})"
      ),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe(
        'Output format: "markdown" for human-readable or "json" for machine-readable (default: markdown)'
      ),
  })
  .strict();

type CreateNoteInput = z.infer<typeof CreateNoteInputSchema>;

const UpdateNoteInputSchema = z
  .object({
    vault: vaultWriteParam,
    path: z
      .string()
      .min(1, "Path must not be empty")
      .max(500, "Path must not exceed 500 characters")
      .describe(
        "Relative path within vault of note to update (e.g., 'Projects/MyNote.md'). Must be an existing note."
      ),
    content: z
      .string()
      .max(100000, "Content must not exceed 100,000 characters")
      .describe("New note content (markdown text). Replaces existing content."),
    frontmatter: z
      .record(z.any())
      .optional()
      .describe(
        "Optional frontmatter object to update. If merge_frontmatter is true, merges with existing; if false, replaces completely."
      ),
    merge_frontmatter: z
      .boolean()
      .default(true)
      .describe(
        "If true (default), merge provided frontmatter with existing. If false, replace completely."
      ),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe(
        'Output format: "markdown" for human-readable or "json" for machine-readable (default: markdown)'
      ),
  })
  .strict();

type UpdateNoteInput = z.infer<typeof UpdateNoteInputSchema>;

const DeleteNoteInputSchema = z
  .object({
    vault: vaultWriteParam,
    path: z
      .string()
      .min(1, "Path must not be empty")
      .max(500, "Path must not exceed 500 characters")
      .describe(
        "Relative path within vault of note to delete (e.g., 'Archive/OldNote.md'). Must be an existing note."
      ),
    confirm: z
      .boolean()
      .describe(
        "Safety confirmation. Must be set to true to actually delete the note."
      ),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe(
        'Output format: "markdown" for human-readable or "json" for machine-readable (default: markdown)'
      ),
  })
  .strict();

type DeleteNoteInput = z.infer<typeof DeleteNoteInputSchema>;

/**
 * Setup all MCP request handlers for Obsidian vault operations
 */
export function setupObsidianHandlers(
  server: McpServer,
  config: Config,
  registry: VaultRegistry
) {
  // =====================================================================
  // RESOURCE HANDLERS
  // =====================================================================

  /**
   * Note: We don't pre-register 5000+ individual resources.
   * Instead, Claude uses the search tool to find notes, which returns
   * obsidian:// URIs that can be accessed on-demand.
   *
   * This approach is more efficient and works better with the MCP protocol.
   */

  logInfo("Obsidian handlers configured successfully");

  // =====================================================================
  // LIST VAULTS TOOL
  // =====================================================================

  /**
   * Tool: obsidian_list_vaults
   *
   * List all configured vaults with metadata.
   */
  server.registerTool(
    "obsidian_list_vaults",
    {
      title: "List Obsidian Vaults",
      description: `List all configured Obsidian vaults with metadata.

Returns information about each vault including:
- name: Vault identifier (use this in other tool calls)
- path: Filesystem path
- readOnly: Whether write operations are disabled
- lastIndexedAt: When the semantic index was last updated (null if no index)
- model: Embedding model used for semantic search (null if no index)
- indexedNoteCount: Number of notes in the semantic index (null if no index)
- indexHealth: "healthy" | "stale" | "missing" | "model-mismatch"

Use this tool first to discover available vaults before calling other tools.`,
      inputSchema: z.object({}).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      logInfo("Executing tool: obsidian_list_vaults");

      const vaultInfos = [];

      for (const ctx of registry.getAllVaults()) {
        const info: Record<string, any> = {
          name: ctx.config.name,
          path: ctx.config.path,
          readOnly: !ctx.config.enableWrite,
          lastIndexedAt: null,
          model: null,
          indexedNoteCount: null,
          indexHealth: "missing" as string,
        };

        // Try to read index metadata
        if (ctx.config.vectorSearch.enabled) {
          const metadataPath = path.join(
            ctx.config.path,
            ".mcp-vector-store",
            "index-metadata.json"
          );

          try {
            const raw = await fs.readFile(metadataPath, "utf-8");
            const metadata = JSON.parse(raw);
            const meta = metadata.__meta__;

            if (meta) {
              info.lastIndexedAt = meta.lastIndexedAt
                ? new Date(meta.lastIndexedAt).toISOString()
                : null;
              info.model = meta.model || null;

              // Count indexed notes (keys minus __meta__)
              const noteKeys = Object.keys(metadata).filter(
                (k) => k !== "__meta__"
              );
              info.indexedNoteCount = noteKeys.length;

              // Determine health
              const configModel =
                ctx.config.vectorSearch.model || "Xenova/all-MiniLM-L6-v2";
              if (meta.model && meta.model !== configModel) {
                info.indexHealth = "model-mismatch";
              } else if (meta.lastIndexedAt) {
                const ageMs = Date.now() - meta.lastIndexedAt;
                const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
                info.indexHealth =
                  ageMs > sevenDaysMs ? "stale" : "healthy";
              }
            }
          } catch {
            // No metadata file — index is missing
            info.indexHealth = "missing";
          }
        }

        vaultInfos.push(info);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ vaults: vaultInfos }, null, 2),
          },
        ],
      };
    }
  );

  // =====================================================================
  // TOOL HANDLERS
  // =====================================================================

  /**
   * Tool: search_vault
   *
   * Search the Obsidian vault for notes matching a query.
   * Supports keyword search, tag filtering, folder filtering, and pagination.
   */
  server.registerTool(
    "obsidian_search_vault",
    {
      title: "Search Obsidian Vault",
      description: `Search for notes in the Obsidian vault by keywords, tags, or folders.

This tool searches across note titles, content, frontmatter, and tags. It supports:
- Keyword matching (case-insensitive, partial matches)
- Tag filtering (notes must have ALL specified tags)
- Folder filtering (notes must be in specified folders)
- Pagination for large result sets

Scoring algorithm:
- Title matches: 10 points per keyword
- Frontmatter description matches: 5 points per keyword
- Tag matches: 3 points per keyword
- Content matches: 1 point per keyword occurrence

Args:
  - query (string): Search keywords (space-separated, 1-500 chars)
  - tags (string[], optional): Filter by tags (must have ALL tags)
  - folders (string[], optional): Limit to specific folders
  - limit (number, optional): Max results (1-100, default: 20)
  - offset (number, optional): Skip N results for pagination (default: 0)
  - response_format ('markdown' | 'json', optional): Output format (default: 'markdown')

Returns:
  For JSON format: Structured data with schema:
  {
    "total": number,           // Total matches found
    "count": number,           // Results in this response
    "offset": number,          // Current pagination offset
    "results": [
      {
        "title": string,       // Note title
        "path": string,        // Relative path in vault
        "excerpt": string,     // Content excerpt with match context
        "score": number,       // Relevance score
        "tags": string[],      // Note tags
        "uri": string          // obsidian:// URI for reading full note
      }
    ],
    "has_more": boolean,       // Whether more results available
    "next_offset": number,     // Offset for next page (if has_more)
    "truncated": boolean,      // Whether results were truncated
    "truncation_message": string  // Guidance if truncated
  }

  For Markdown format: Human-readable formatted text with headers, lists, and excerpts.

Examples:
  - Use when: "Find notes about Azure security" -> query="Azure security"
  - Use when: "Search project notes" -> query="project", folders=["Projects"]
  - Use when: "Find active todos" -> query="todo", tags=["active"]
  - Don't use when: You need to read a specific note by path (use resources/read instead)

Error Handling:
  - Returns "No notes found matching '<query>'" if search returns empty
  - Returns "Error: Query too long" if query exceeds 500 characters
  - Truncates large result sets with guidance on using filters/pagination`,
      inputSchema: SearchVaultInputSchema.shape,
      annotations: {
        readOnlyHint: true, // Does not modify vault
        destructiveHint: false, // Non-destructive operation
        idempotentHint: true, // Same query always returns same results (at a point in time)
        openWorldHint: false, // Operates on closed vault filesystem
      },
    },
    async (params: SearchVaultInput) => {
      logInfo(`Executing tool: obsidian_search_vault`);
      logInfo(
        `Query: "${params.query}", Vault: "${params.vault}", Limit: ${params.limit}, Format: ${params.response_format}`
      );

      try {
        const vaultCtx = registry.resolveVault(params.vault);

        // Determine which vaults to search
        const vaultsToSearch: VaultContext[] = vaultCtx
          ? [vaultCtx]
          : registry.getAllVaults();

        // Search across target vaults
        let allResults: (SearchResult & { vault?: string })[] = [];

        for (const ctx of vaultsToSearch) {
          const searchOptions: SearchOptions = {
            tags: params.tags,
            folders: params.folders,
            limit: params.limit,
            offset: 0, // Always start at 0 per vault; global offset applied after merge
            includePatterns: ctx.config.includePatterns,
            excludePatterns: ctx.config.excludePatterns,
            excerptLength: config.searchOptions.excerptLength,
          };

          const results = await searchVault(
            ctx.config.path,
            params.query,
            searchOptions
          );

          // Tag results with vault name and update URI
          for (const r of results) {
            (r as any).vault = ctx.config.name;
            r.uri = `obsidian://vault/${ctx.config.name}/${r.path}`;
          }

          allResults.push(...(results as any[]));
        }

        // Sort by score descending (interleave cross-vault results)
        allResults.sort((a, b) => b.score - a.score);

        // Apply global offset and limit
        const globalOffset = params.offset || 0;
        if (globalOffset > 0) {
          allResults = allResults.slice(globalOffset);
        }
        if (allResults.length > params.limit) {
          allResults = allResults.slice(0, params.limit);
        }

        logInfo(`Search returned ${allResults.length} results`);

        // Handle empty results
        if (allResults.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No notes found matching '${params.query}'${params.tags ? ` with tags [${params.tags.join(", ")}]` : ""}${params.folders ? ` in folders [${params.folders.join(", ")}]` : ""} in vault "${params.vault}"`,
              },
            ],
          };
        }

        // Format response based on requested format
        let responseText: string;

        if (params.response_format === ResponseFormat.MARKDOWN) {
          responseText = formatSearchResultsMarkdown(
            params.query,
            allResults,
            params.offset || 0
          );
        } else {
          responseText = formatSearchResultsJSON(allResults, params.offset || 0);
        }

        // Check character limit and truncate if needed
        const CHARACTER_LIMIT = 25000;
        if (responseText.length > CHARACTER_LIMIT) {
          const truncatedResults = allResults.slice(
            0,
            Math.max(1, Math.floor(allResults.length / 2))
          );

          if (params.response_format === ResponseFormat.MARKDOWN) {
            responseText = formatSearchResultsMarkdown(
              params.query,
              truncatedResults,
              params.offset || 0
            );
          } else {
            responseText = formatSearchResultsJSON(
              truncatedResults,
              params.offset || 0
            );
          }

          const truncationMessage =
            `\n\n⚠️ Response truncated from ${allResults.length} to ${truncatedResults.length} results due to character limit. ` +
            `Use 'limit' parameter (e.g., limit=10), add 'tags' or 'folders' filters, or use 'offset' for pagination to see more results.`;

          responseText += truncationMessage;
          logInfo(
            `Response truncated: ${allResults.length} -> ${truncatedResults.length} results`
          );
        }

        return {
          content: [
            {
              type: "text",
              text: responseText,
            },
          ],
        };
      } catch (error) {
        logError(` Search failed:`, error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: Search failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // =====================================================================
  // WRITE OPERATION TOOLS (Phase 2)
  // =====================================================================

  /**
   * Tool: obsidian_create_note
   *
   * Create a new note in the Obsidian vault.
   * Requires enableWrite: true in configuration.
   */
  server.registerTool(
    "obsidian_create_note",
    {
      title: "Create Obsidian Note",
      description: `Create a new markdown note in the Obsidian vault.

This tool creates a new note at the specified path with the provided content and optional frontmatter.
It will create parent directories if they don't exist.

Security:
- Validates path safety (no traversal attacks)
- Checks that note doesn't already exist
- Requires enableWrite: true in configuration

Args:
  - path (string): Relative path within vault (e.g., "Projects/NewIdea.md")
  - content (string): Note content in markdown format
  - frontmatter (object, optional): Frontmatter metadata (e.g., {title: "Note", tags: ["project"]})
  - response_format ('markdown' | 'json', optional): Output format (default: 'markdown')

Returns:
  Success message with note URI (obsidian://vault/path) that can be used to read the note.

Example:
  {
    "path": "Projects/MyNewNote.md",
    "content": "# My New Note\\n\\nThis is the content.",
    "frontmatter": {"tags": ["project", "active"], "date": "2025-01-20"}
  }`,
      inputSchema: CreateNoteInputSchema.shape,
      annotations: {
        readOnlyHint: false, // This is a write operation
        destructiveHint: false, // Creates new, doesn't modify existing
        idempotentHint: false, // Running twice creates errors (file exists)
        openWorldHint: false, // Operates on closed vault filesystem
      },
    },
    async (params: CreateNoteInput) => {
      logInfo(`Executing tool: obsidian_create_note`);
      logInfo(`Path: "${params.path}", Vault: "${params.vault}"`);

      try {
        // Resolve vault (validates name, rejects "*", checks enableWrite)
        const ctx = registry.resolveWriteVault(params.vault);

        // Create the note
        await createNote(
          ctx.config.path,
          params.path,
          params.content,
          params.frontmatter
        );

        // Build response
        const relativePath = params.path.endsWith(".md")
          ? params.path
          : `${params.path}.md`;
        const uri = `obsidian://vault/${ctx.config.name}/${relativePath}`;

        let responseText: string;
        if (params.response_format === ResponseFormat.JSON) {
          responseText = JSON.stringify(
            {
              success: true,
              message: "Note created successfully",
              vault: ctx.config.name,
              path: relativePath,
              uri: uri,
            },
            null,
            2
          );
        } else {
          responseText = `# ✅ Note Created Successfully

**Vault**: ${ctx.config.name}
**Path**: \`${relativePath}\`
**URI**: \`${uri}\`

You can now read this note using the URI above or search for it by name.`;
        }

        return {
          content: [
            {
              type: "text",
              text: responseText,
            },
          ],
        };
      } catch (error) {
        logError(` Create note failed:`, error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: Failed to create note: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  /**
   * Tool: obsidian_update_note
   *
   * Update an existing note in the Obsidian vault.
   * Requires enableWrite: true in configuration.
   */
  server.registerTool(
    "obsidian_update_note",
    {
      title: "Update Obsidian Note",
      description: `Update an existing markdown note in the Obsidian vault.

This tool updates the content and optionally the frontmatter of an existing note.
By default, frontmatter is merged with existing metadata. Set merge_frontmatter: false to replace completely.

Security:
- Validates path safety (no traversal attacks)
- Checks that note exists before updating
- Requires enableWrite: true in configuration

Args:
  - path (string): Relative path to existing note (e.g., "Projects/MyNote.md")
  - content (string): New note content in markdown format
  - frontmatter (object, optional): Frontmatter to update
  - merge_frontmatter (boolean, optional): If true (default), merge with existing; if false, replace
  - response_format ('markdown' | 'json', optional): Output format (default: 'markdown')

Returns:
  Success message with note URI.

Example:
  {
    "path": "Projects/MyNote.md",
    "content": "# Updated Content\\n\\nThis is the new content.",
    "frontmatter": {"status": "in-progress"},
    "merge_frontmatter": true
  }`,
      inputSchema: UpdateNoteInputSchema.shape,
      annotations: {
        readOnlyHint: false, // This is a write operation
        destructiveHint: true, // Modifies existing content
        idempotentHint: false, // Running twice with same content is idempotent, but usually content differs
        openWorldHint: false, // Operates on closed vault filesystem
      },
    },
    async (params: UpdateNoteInput) => {
      logInfo(`Executing tool: obsidian_update_note`);
      logInfo(`Path: "${params.path}", Vault: "${params.vault}"`);

      try {
        // Resolve vault (validates name, rejects "*", checks enableWrite)
        const ctx = registry.resolveWriteVault(params.vault);

        // Update the note
        await updateNote(
          ctx.config.path,
          params.path,
          params.content,
          params.frontmatter,
          params.merge_frontmatter
        );

        // Build response
        const relativePath = params.path.endsWith(".md")
          ? params.path
          : `${params.path}.md`;
        const uri = `obsidian://vault/${ctx.config.name}/${relativePath}`;

        let responseText: string;
        if (params.response_format === ResponseFormat.JSON) {
          responseText = JSON.stringify(
            {
              success: true,
              message: "Note updated successfully",
              vault: ctx.config.name,
              path: relativePath,
              uri: uri,
              frontmatter_merged: params.merge_frontmatter,
            },
            null,
            2
          );
        } else {
          responseText = `# ✅ Note Updated Successfully

**Vault**: ${ctx.config.name}
**Path**: \`${relativePath}\`
**URI**: \`${uri}\`
**Frontmatter**: ${params.merge_frontmatter ? "Merged with existing" : "Replaced completely"}

The note has been updated with the new content.`;
        }

        return {
          content: [
            {
              type: "text",
              text: responseText,
            },
          ],
        };
      } catch (error) {
        logError(` Update note failed:`, error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: Failed to update note: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  /**
   * Tool: obsidian_delete_note
   *
   * Delete a note from the Obsidian vault.
   * Requires enableWrite: true in configuration and explicit confirmation.
   */
  server.registerTool(
    "obsidian_delete_note",
    {
      title: "Delete Obsidian Note",
      description: `Delete a note from the Obsidian vault.

⚠️ DESTRUCTIVE OPERATION ⚠️
This permanently deletes the note. It cannot be undone through the MCP server.
(Note: Obsidian's .trash folder may still have a copy if Obsidian is running)

Security:
- Validates path safety (no traversal attacks)
- Requires explicit confirmation (confirm: true)
- Requires enableWrite: true in configuration

Args:
  - path (string): Relative path to note to delete (e.g., "Archive/OldNote.md")
  - confirm (boolean): Must be true to actually delete
  - response_format ('markdown' | 'json', optional): Output format (default: 'markdown')

Returns:
  Success message confirming deletion.

Example:
  {
    "path": "Archive/OldNote.md",
    "confirm": true
  }`,
      inputSchema: DeleteNoteInputSchema.shape,
      annotations: {
        readOnlyHint: false, // This is a write operation
        destructiveHint: true, // Permanently deletes content
        idempotentHint: false, // Running twice fails (file not found)
        openWorldHint: false, // Operates on closed vault filesystem
      },
    },
    async (params: DeleteNoteInput) => {
      logInfo(`Executing tool: obsidian_delete_note`);
      logInfo(`Path: "${params.path}", Vault: "${params.vault}"`);

      try {
        // Resolve vault (validates name, rejects "*", checks enableWrite)
        const ctx = registry.resolveWriteVault(params.vault);

        // Require explicit confirmation
        if (!params.confirm) {
          throw new Error(
            "Deletion requires explicit confirmation. Set confirm: true to actually delete the note."
          );
        }

        // Delete the note
        await deleteNote(ctx.config.path, params.path);

        // Build response
        const relativePath = params.path.endsWith(".md")
          ? params.path
          : `${params.path}.md`;

        let responseText: string;
        if (params.response_format === ResponseFormat.JSON) {
          responseText = JSON.stringify(
            {
              success: true,
              message: "Note deleted successfully",
              vault: ctx.config.name,
              path: relativePath,
            },
            null,
            2
          );
        } else {
          responseText = `# ✅ Note Deleted Successfully

**Vault**: ${ctx.config.name}
**Path**: \`${relativePath}\`

⚠️ The note has been permanently deleted. This action cannot be undone through the MCP server.`;
        }

        return {
          content: [
            {
              type: "text",
              text: responseText,
            },
          ],
        };
      } catch (error) {
        logError(` Delete note failed:`, error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: Failed to delete note: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // =====================================================================
  // SEMANTIC SEARCH TOOL
  // =====================================================================

  // Register semantic search if any vault has vector search enabled
  const hasAnyVectorSearch = registry
    .getAllVaults()
    .some((ctx) => ctx.vectorStore);

  if (hasAnyVectorSearch) {
    server.registerTool(
      "obsidian_semantic_search",
      {
        title: "Semantic Search Obsidian Vault",
        description: `Search for notes using semantic similarity (meaning-based) instead of keyword matching.

This tool uses vector embeddings to find notes that are semantically similar to your query,
even if they don't contain the exact keywords. It's ideal for:
- Finding conceptually related notes
- Discovering connections between ideas
- Exploring your knowledge graph semantically
- Searching by meaning rather than exact words

The semantic search can optionally be combined with keyword search (hybrid mode) for best results.

Args:
  - vault (string): Vault name to search, or "*" for all vaults with semantic indexes
  - query (string): Natural language query (1-500 chars). Describe what you're looking for conceptually.
  - limit (number, optional): Max results (1-50, default: 10)
  - min_score (number, optional): Min similarity threshold (0-1, default: 0.5)
  - hybrid (boolean, optional): Combine with keyword search (default: false)
  - response_format ('markdown' | 'json', optional): Output format (default: 'markdown')

Returns:
  Similar structure to obsidian_search_vault, but with similarity scores instead of keyword scores.

Note: Requires vector store to be initialized for the target vault. Call obsidian_list_vaults to check index health.`,
        inputSchema: SemanticSearchInputSchema.shape,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (params: SemanticSearchInput) => {
        logInfo(`Executing tool: obsidian_semantic_search`);
        logInfo(
          `Query: "${params.query}", Vault: "${params.vault}", Limit: ${params.limit}, Hybrid: ${params.hybrid}`
        );

        try {
          const vaultCtx = registry.resolveVault(params.vault);

          // For single vault, verify vector store is available
          if (vaultCtx && !vaultCtx.vectorStore) {
            return {
              content: [
                {
                  type: "text",
                  text: `Semantic search is not enabled for vault "${params.vault}". Check vault configuration and index health with obsidian_list_vaults.`,
                },
              ],
            };
          }

          // Determine which vaults to search
          const vaultsToSearch: VaultContext[] = vaultCtx
            ? [vaultCtx]
            : registry.getAllVaults().filter((ctx) => ctx.vectorStore);

          if (vaultsToSearch.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No vaults with semantic search enabled. Check vault configuration and index health with obsidian_list_vaults.",
                },
              ],
            };
          }

          // Search across target vaults
          type SemanticResult = {
            title: string;
            path: string;
            score: number;
            excerpt: string;
            metadata: Record<string, any>;
            vault?: string;
          };

          let allResults: SemanticResult[] = [];

          for (const ctx of vaultsToSearch) {
            if (!ctx.vectorStore) {
              logInfo(
                `Skipping vault "${ctx.config.name}" - no vector store`
              );
              continue;
            }

            let results;

            if (params.hybrid) {
              const keywordResults = await searchVault(
                ctx.config.path,
                params.query,
                {
                  limit: params.limit,
                  includePatterns: ctx.config.includePatterns,
                  excludePatterns: ctx.config.excludePatterns,
                  excerptLength: config.searchOptions.excerptLength,
                }
              );

              const kwResults = keywordResults.map((r) => ({
                path: r.path,
                score: r.score / 100,
                excerpt: r.excerpt,
              }));

              results = await ctx.vectorStore.hybridSearch(
                params.query,
                kwResults,
                {
                  limit: params.limit,
                  minScore: params.min_score,
                }
              );
            } else {
              results = await ctx.vectorStore.search(params.query, {
                limit: params.limit,
                minScore: params.min_score,
              });
            }

            // Tag results with vault name
            for (const r of results) {
              (r as SemanticResult).vault = ctx.config.name;
            }

            allResults.push(...(results as SemanticResult[]));
          }

          // Sort by score descending
          allResults.sort((a, b) => b.score - a.score);

          // Apply limit
          if (allResults.length > params.limit) {
            allResults = allResults.slice(0, params.limit);
          }

          logInfo(`Semantic search returned ${allResults.length} results`);

          // Handle empty results
          if (allResults.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No notes found matching '${params.query}' with min_score ${params.min_score} in vault "${params.vault}". Try lowering min_score or rephrasing your query.`,
                },
              ],
            };
          }

          // Format response
          let responseText: string;

          if (params.response_format === ResponseFormat.MARKDOWN) {
            responseText = formatSemanticResultsMarkdown(
              params.query,
              allResults,
              params.hybrid || false
            );
          } else {
            responseText = formatSemanticResultsJSON(
              allResults,
              params.hybrid || false
            );
          }

          // Check character limit
          const CHARACTER_LIMIT = 25000;
          if (responseText.length > CHARACTER_LIMIT) {
            const truncatedResults = allResults.slice(
              0,
              Math.max(1, Math.floor(allResults.length / 2))
            );

            if (params.response_format === ResponseFormat.MARKDOWN) {
              responseText = formatSemanticResultsMarkdown(
                params.query,
                truncatedResults,
                params.hybrid || false
              );
            } else {
              responseText = formatSemanticResultsJSON(
                truncatedResults,
                params.hybrid || false
              );
            }

            responseText +=
              `\n\n⚠️ Response truncated from ${allResults.length} to ${truncatedResults.length} results. ` +
              `Use lower 'limit' parameter or higher 'min_score' to see more focused results.`;
          }

          return {
            content: [
              {
                type: "text",
                text: responseText,
              },
            ],
          };
        } catch (error) {
          logError(` Semantic search failed:`, error);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error: Semantic search failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      }
    );

    logInfo("Semantic search tool registered successfully");
  }

  logInfo("All Obsidian handlers configured successfully");
}

/**
 * Format search results as Markdown (human-readable)
 */
function formatSearchResultsMarkdown(
  query: string,
  results: (SearchResult & { vault?: string })[],
  offset: number
): string {
  const lines: string[] = [
    `# Search Results: "${query}"`,
    "",
    `Found **${results.length} notes** (offset: ${offset})`,
    "",
  ];

  for (const result of results) {
    lines.push(`## 📄 ${result.title}`);
    if (result.vault) {
      lines.push(`**Vault**: ${result.vault}`);
    }
    lines.push(`**Path**: \`${result.path}\``);
    lines.push(`**Score**: ${result.score.toFixed(1)}`);

    if (result.tags && result.tags.length > 0) {
      lines.push(`**Tags**: ${result.tags.map((t) => `#${t}`).join(", ")}`);
    }

    lines.push(`**URI**: \`${result.uri}\``);
    lines.push("");
    lines.push(`> ${result.excerpt}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format search results as JSON (machine-readable)
 */
function formatSearchResultsJSON(
  results: (SearchResult & { vault?: string })[],
  offset: number
): string {
  const response = {
    total: results.length,
    count: results.length,
    offset: offset,
    results: results.map((r) => ({
      title: r.title,
      vault: r.vault,
      path: r.path,
      excerpt: r.excerpt,
      score: r.score,
      tags: r.tags || [],
      uri: r.uri,
    })),
    has_more: false,
    truncated: false,
  };

  return JSON.stringify(response, null, 2);
}

/**
 * Format semantic search results as Markdown
 */
function formatSemanticResultsMarkdown(
  query: string,
  results: Array<{
    title: string;
    path: string;
    score: number;
    excerpt: string;
    metadata: Record<string, any>;
    vault?: string;
  }>,
  hybrid: boolean
): string {
  const lines: string[] = [
    `# ${hybrid ? "Hybrid" : "Semantic"} Search Results: "${query}"`,
    "",
    `Found **${results.length} semantically similar notes**`,
    "",
  ];

  for (const result of results) {
    lines.push(`## 🔍 ${result.title}`);
    if (result.vault) {
      lines.push(`**Vault**: ${result.vault}`);
    }
    lines.push(`**Path**: \`${result.path}\``);
    lines.push(`**Similarity**: ${(result.score * 100).toFixed(1)}%`);

    if (result.metadata.tags) {
      const tags = result.metadata.tags.split(",").filter((t: string) => t);
      if (tags.length > 0) {
        lines.push(`**Tags**: ${tags.map((t: string) => `#${t}`).join(", ")}`);
      }
    }

    const uriVault = result.vault ? `${result.vault}/` : "";
    lines.push(`**URI**: \`obsidian://vault/${uriVault}${result.path}\``);
    lines.push("");
    lines.push(`> ${result.excerpt}`);
    lines.push("");
  }

  if (hybrid) {
    lines.push(
      "_Note: Hybrid search combines semantic similarity (60%) with keyword matching (40%)_"
    );
  }

  return lines.join("\n");
}

/**
 * Format semantic search results as JSON
 */
function formatSemanticResultsJSON(
  results: Array<{
    title: string;
    path: string;
    score: number;
    excerpt: string;
    metadata: Record<string, any>;
    vault?: string;
  }>,
  hybrid: boolean
): string {
  const response = {
    total: results.length,
    count: results.length,
    search_type: hybrid ? "hybrid" : "semantic",
    results: results.map((r) => {
      const uriVault = r.vault ? `${r.vault}/` : "";
      return {
        title: r.title,
        vault: r.vault,
        path: r.path,
        excerpt: r.excerpt,
        similarity_score: r.score,
        metadata: r.metadata,
        uri: `obsidian://vault/${uriVault}${r.path}`,
      };
    }),
    truncated: false,
  };

  return JSON.stringify(response, null, 2);
}
