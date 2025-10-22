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
import { VectorStore } from "./embeddings.js";

// Response format enum
enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

// Zod schemas for tool input validation
const SearchVaultInputSchema = z
  .object({
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
  vectorStore?: VectorStore
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

  console.error("[MCP] Obsidian handlers configured successfully");

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
      console.error(`[MCP] Executing tool: obsidian_search_vault`);
      console.error(
        `[MCP] Query: "${params.query}", Limit: ${params.limit}, Format: ${params.response_format}`
      );

      try {
        // Execute search
        const searchOptions: SearchOptions = {
          tags: params.tags,
          folders: params.folders,
          limit: params.limit,
          offset: params.offset,
          includePatterns: config.includePatterns,
          excludePatterns: config.excludePatterns,
          excerptLength: config.searchOptions.excerptLength,
        };

        const results = await searchVault(
          config.vaultPath,
          params.query,
          searchOptions
        );

        console.error(`[MCP] Search returned ${results.length} results`);

        // Handle empty results
        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No notes found matching '${params.query}'${params.tags ? ` with tags [${params.tags.join(", ")}]` : ""}${params.folders ? ` in folders [${params.folders.join(", ")}]` : ""}`,
              },
            ],
          };
        }

        // Format response based on requested format
        let responseText: string;

        if (params.response_format === ResponseFormat.MARKDOWN) {
          responseText = formatSearchResultsMarkdown(
            params.query,
            results,
            params.offset || 0
          );
        } else {
          responseText = formatSearchResultsJSON(results, params.offset || 0);
        }

        // Check character limit and truncate if needed
        const CHARACTER_LIMIT = 25000;
        if (responseText.length > CHARACTER_LIMIT) {
          const truncatedResults = results.slice(
            0,
            Math.max(1, Math.floor(results.length / 2))
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
            `\n\n⚠️ Response truncated from ${results.length} to ${truncatedResults.length} results due to character limit. ` +
            `Use 'limit' parameter (e.g., limit=10), add 'tags' or 'folders' filters, or use 'offset' for pagination to see more results.`;

          responseText += truncationMessage;
          console.error(
            `[MCP] Response truncated: ${results.length} -> ${truncatedResults.length} results`
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
        console.error(`[MCP] ERROR: Search failed:`, error);
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
      console.error(`[MCP] Executing tool: obsidian_create_note`);
      console.error(`[MCP] Path: "${params.path}"`);

      try {
        // Check if write operations are enabled
        if (!config.enableWrite) {
          throw new Error(
            "Write operations are disabled. Set enableWrite: true in configuration to allow note creation."
          );
        }

        // Create the note
        const absolutePath = await createNote(
          config.vaultPath,
          params.path,
          params.content,
          params.frontmatter
        );

        // Build response
        const relativePath = params.path.endsWith(".md")
          ? params.path
          : `${params.path}.md`;
        const uri = `obsidian://vault/${relativePath}`;

        let responseText: string;
        if (params.response_format === ResponseFormat.JSON) {
          responseText = JSON.stringify(
            {
              success: true,
              message: "Note created successfully",
              path: relativePath,
              uri: uri,
              absolutePath: absolutePath,
            },
            null,
            2
          );
        } else {
          responseText = `# ✅ Note Created Successfully

**Path**: \`${relativePath}\`
**URI**: \`${uri}\`
**Absolute Path**: \`${absolutePath}\`

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
        console.error(`[MCP] ERROR: Create note failed:`, error);
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
      console.error(`[MCP] Executing tool: obsidian_update_note`);
      console.error(`[MCP] Path: "${params.path}"`);

      try {
        // Check if write operations are enabled
        if (!config.enableWrite) {
          throw new Error(
            "Write operations are disabled. Set enableWrite: true in configuration to allow note updates."
          );
        }

        // Update the note
        const absolutePath = await updateNote(
          config.vaultPath,
          params.path,
          params.content,
          params.frontmatter,
          params.merge_frontmatter
        );

        // Build response
        const relativePath = params.path.endsWith(".md")
          ? params.path
          : `${params.path}.md`;
        const uri = `obsidian://vault/${relativePath}`;

        let responseText: string;
        if (params.response_format === ResponseFormat.JSON) {
          responseText = JSON.stringify(
            {
              success: true,
              message: "Note updated successfully",
              path: relativePath,
              uri: uri,
              absolutePath: absolutePath,
              frontmatter_merged: params.merge_frontmatter,
            },
            null,
            2
          );
        } else {
          responseText = `# ✅ Note Updated Successfully

**Path**: \`${relativePath}\`
**URI**: \`${uri}\`
**Absolute Path**: \`${absolutePath}\`
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
        console.error(`[MCP] ERROR: Update note failed:`, error);
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
      console.error(`[MCP] Executing tool: obsidian_delete_note`);
      console.error(`[MCP] Path: "${params.path}"`);

      try {
        // Check if write operations are enabled
        if (!config.enableWrite) {
          throw new Error(
            "Write operations are disabled. Set enableWrite: true in configuration to allow note deletion."
          );
        }

        // Require explicit confirmation
        if (!params.confirm) {
          throw new Error(
            "Deletion requires explicit confirmation. Set confirm: true to actually delete the note."
          );
        }

        // Delete the note
        const absolutePath = await deleteNote(config.vaultPath, params.path);

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
              path: relativePath,
              absolutePath: absolutePath,
            },
            null,
            2
          );
        } else {
          responseText = `# ✅ Note Deleted Successfully

**Path**: \`${relativePath}\`
**Absolute Path**: \`${absolutePath}\`

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
        console.error(`[MCP] ERROR: Delete note failed:`, error);
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
  // SEMANTIC SEARCH TOOL (Optional - requires vector store)
  // =====================================================================

  if (vectorStore) {
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
  - query (string): Natural language query (1-500 chars). Describe what you're looking for conceptually.
  - limit (number, optional): Max results (1-50, default: 10)
  - min_score (number, optional): Min similarity threshold (0-1, default: 0.5)
  - hybrid (boolean, optional): Combine with keyword search (default: false)
  - response_format ('markdown' | 'json', optional): Output format (default: 'markdown')

Returns:
  Similar structure to obsidian_search_vault, but with similarity scores instead of keyword scores.

Examples:
  - "What are my thoughts on machine learning ethics?" (semantic)
  - "Notes about project management best practices" (semantic)
  - "Ideas related to consciousness and AI" (semantic)

Note: Requires vector store to be initialized. First-time use may take a few moments.`,
        inputSchema: SemanticSearchInputSchema.shape,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (params: SemanticSearchInput) => {
        console.error(`[MCP] Executing tool: obsidian_semantic_search`);
        console.error(
          `[MCP] Query: "${params.query}", Limit: ${params.limit}, Hybrid: ${params.hybrid}`
        );

        try {
          let results;

          if (params.hybrid) {
            // Hybrid search: combine semantic + keyword
            const keywordResults = await searchVault(
              config.vaultPath,
              params.query,
              {
                limit: params.limit,
                includePatterns: config.includePatterns,
                excludePatterns: config.excludePatterns,
                excerptLength: config.searchOptions.excerptLength,
              }
            );

            // Convert keyword results to format expected by hybrid search
            const kwResults = keywordResults.map((r) => ({
              path: r.path,
              score: r.score / 100, // Normalize to 0-1
              excerpt: r.excerpt,
            }));

            results = await vectorStore.hybridSearch(params.query, kwResults, {
              limit: params.limit,
              minScore: params.min_score,
            });
          } else {
            // Pure semantic search
            results = await vectorStore.search(params.query, {
              limit: params.limit,
              minScore: params.min_score,
            });
          }

          console.error(
            `[MCP] Semantic search returned ${results.length} results`
          );

          // Handle empty results
          if (results.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No notes found matching '${params.query}' with min_score ${params.min_score}. Try lowering min_score or rephrasing your query.`,
                },
              ],
            };
          }

          // Format response
          let responseText: string;

          if (params.response_format === ResponseFormat.MARKDOWN) {
            responseText = formatSemanticResultsMarkdown(
              params.query,
              results,
              params.hybrid || false
            );
          } else {
            responseText = formatSemanticResultsJSON(
              results,
              params.hybrid || false
            );
          }

          // Check character limit
          const CHARACTER_LIMIT = 25000;
          if (responseText.length > CHARACTER_LIMIT) {
            const truncatedResults = results.slice(
              0,
              Math.max(1, Math.floor(results.length / 2))
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
              `\n\n⚠️ Response truncated from ${results.length} to ${truncatedResults.length} results. ` +
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
          console.error(`[MCP] ERROR: Semantic search failed:`, error);
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

    console.error("[MCP] Semantic search tool registered successfully");
  }

  console.error("[MCP] Obsidian handlers configured successfully");
}

/**
 * Format search results as Markdown (human-readable)
 */
function formatSearchResultsMarkdown(
  query: string,
  results: SearchResult[],
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
  results: SearchResult[],
  offset: number
): string {
  const response = {
    total: results.length,
    count: results.length,
    offset: offset,
    results: results.map((r) => ({
      title: r.title,
      path: r.path,
      excerpt: r.excerpt,
      score: r.score,
      tags: r.tags || [],
      uri: r.uri,
    })),
    has_more: false, // We don't know total count without doing full search
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
    lines.push(`**Path**: \`${result.path}\``);
    lines.push(`**Similarity**: ${(result.score * 100).toFixed(1)}%`);

    if (result.metadata.tags) {
      const tags = result.metadata.tags.split(",").filter((t: string) => t);
      if (tags.length > 0) {
        lines.push(`**Tags**: ${tags.map((t: string) => `#${t}`).join(", ")}`);
      }
    }

    lines.push(`**URI**: \`obsidian://vault/${result.path}\``);
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
  }>,
  hybrid: boolean
): string {
  const response = {
    total: results.length,
    count: results.length,
    search_type: hybrid ? "hybrid" : "semantic",
    results: results.map((r) => ({
      title: r.title,
      path: r.path,
      excerpt: r.excerpt,
      similarity_score: r.score,
      metadata: r.metadata,
      uri: `obsidian://vault/${r.path}`,
    })),
    truncated: false,
  };

  return JSON.stringify(response, null, 2);
}
