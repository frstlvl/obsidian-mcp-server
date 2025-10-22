/**
 * Utility Functions for Obsidian Vault Operations
 *
 * Provides core functionality:
 * - Configuration loading
 * - Frontmatter parsing
 * - Path normalization and security
 * - File system operations
 * - WikiLink and tag extraction
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import matter from "gray-matter";
import fg from "fast-glob";

// Get the directory where this script is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Character limit for MCP responses (25k tokens ≈ 100k characters, being conservative)
export const CHARACTER_LIMIT = 25000;

// Configuration interface
export interface Config {
  vaultPath: string;
  includePatterns: string[];
  excludePatterns: string[];
  enableWrite: boolean;
  vectorSearch?: {
    enabled: boolean;
    provider: "transformers" | "anthropic";
    model?: string;
    anthropicApiKey?: string;
    indexOnStartup?: boolean;
  };
  searchOptions: {
    maxResults: number;
    excerptLength: number;
    caseSensitive: boolean;
    includeMetadata: boolean;
  };
  logging: {
    level: string;
    file: string;
  };
}

// Note metadata from file listing
export interface NoteMetadata {
  name: string;
  relativePath: string;
  title?: string;
  frontmatter?: any;
}

// Full note content with parsed frontmatter
export interface NoteContent {
  content: string; // Content without frontmatter
  frontmatter?: any; // Parsed YAML frontmatter
  rawContent: string; // Full file content including frontmatter
}

/**
 * Load configuration from file or environment
 *
 * Priority order:
 * 1. Environment variable OBSIDIAN_VAULT_PATH
 * 2. Config file at ../_data/config.json
 * 3. Default configuration
 */
export async function loadConfig(): Promise<Config> {
  // Environment variable takes precedence
  const vaultPathEnv = process.env.OBSIDIAN_VAULT_PATH;

  // Try to load config file from the repo root (parent of dist/)
  // When compiled, this will be in dist/, so go up one level
  const repoRoot = path.join(__dirname, "..");
  const configPath = path.join(repoRoot, "config.json");

  let config: Config | null = null;

  try {
    const configFile = await fs.readFile(configPath, "utf-8");
    config = JSON.parse(configFile);
  } catch (error) {
    // Config file not found or invalid, will use defaults
    config = null;
  }

  if (config) {
    // Override vault path with env var if present
    if (vaultPathEnv) {
      console.error(
        "[Config] Using vault path from OBSIDIAN_VAULT_PATH environment variable"
      );
      config.vaultPath = vaultPathEnv;
    }

    // Validate vault path exists
    await validateVaultPath(config.vaultPath);

    console.error(`[Config] Configuration loaded from: ${configPath}`);
    return config;
  }

  // No config file found, use defaults
  console.error("[Config] Could not load config file, using defaults");

  // Determine vault path - require environment variable if no config
  const vaultPath = vaultPathEnv;

  if (!vaultPath) {
    throw new Error(
      "No vault path configured. Please set OBSIDIAN_VAULT_PATH environment variable or create config.json"
    );
  }

  // Validate vault path
  await validateVaultPath(vaultPath);

  // Return default config
  const defaultConfig: Config = {
    vaultPath: vaultPath,
    includePatterns: ["**/*.md"],
    excludePatterns: [
      "_archive/**",
      ".obsidian/**",
      ".trash/**",
      "node_modules/**",
      "**/node_modules/**",
    ],
    enableWrite: false,
    searchOptions: {
      maxResults: 20,
      excerptLength: 200,
      caseSensitive: false,
      includeMetadata: true,
    },
    logging: {
      level: "info",
      file: "_data/mcp-server.log",
    },
  };

  console.error("[Config] Using default configuration");
  return defaultConfig;
}

/**
 * Validate that vault path exists and is accessible
 */
async function validateVaultPath(vaultPath: string): Promise<void> {
  try {
    const stats = await fs.stat(vaultPath);

    if (!stats.isDirectory()) {
      throw new Error(`Vault path is not a directory: ${vaultPath}`);
    }

    // Try to read directory to verify permissions
    await fs.readdir(vaultPath);

    console.error(`[Config] Vault path validated: ${vaultPath}`);
  } catch (error) {
    throw new Error(
      `Invalid vault path: ${vaultPath}. ` +
        `Error: ${error instanceof Error ? error.message : String(error)}. ` +
        `Please set OBSIDIAN_VAULT_PATH environment variable or create config.json in the project root`
    );
  }
}

/**
 * Find all notes in vault matching include/exclude patterns
 *
 * Uses fast-glob for efficient file discovery.
 * Parses frontmatter from each file for metadata.
 */
export async function findAllNotes(
  vaultPath: string,
  includePatterns: string[] = ["**/*.md"],
  excludePatterns: string[] = []
): Promise<NoteMetadata[]> {
  const notes: NoteMetadata[] = [];

  // Normalize vault path
  const normalizedVaultPath = path.resolve(vaultPath);

  console.error(`[Utils] Scanning vault: ${normalizedVaultPath}`);
  console.error(`[Utils] Include patterns: ${includePatterns.join(", ")}`);
  console.error(`[Utils] Exclude patterns: ${excludePatterns.join(", ")}`);

  try {
    // Use fast-glob to find files
    const files = await fg(includePatterns, {
      cwd: normalizedVaultPath,
      ignore: excludePatterns,
      absolute: false,
      onlyFiles: true,
      dot: false, // Don't include hidden files
    });

    console.error(`[Utils] Found ${files.length} markdown files`);

    for (const file of files) {
      try {
        const fullPath = path.join(normalizedVaultPath, file);
        const content = await fs.readFile(fullPath, "utf-8");
        const parsed = matter(content);

        const name = path.basename(file, ".md");
        const relativePath = normalizePath(file);

        // Extract title from frontmatter or filename
        const title =
          parsed.data.title ||
          (parsed.data.aliases && parsed.data.aliases[0]) ||
          name;

        notes.push({
          name,
          relativePath,
          title,
          frontmatter: parsed.data,
        });
      } catch (error) {
        console.error(`[Utils] Error processing file ${file}:`, error);
        // Continue processing other files
        continue;
      }
    }

    console.error(`[Utils] Successfully processed ${notes.length} notes`);
    return notes;
  } catch (error) {
    console.error(`[Utils] Error scanning vault:`, error);
    throw new Error(
      `Failed to scan vault: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Read a specific note with frontmatter parsing
 *
 * Returns:
 * - content: markdown content without frontmatter
 * - frontmatter: parsed YAML frontmatter object
 * - rawContent: complete file content
 */
export async function readNote(fullPath: string): Promise<NoteContent> {
  try {
    const content = await fs.readFile(fullPath, "utf-8");
    const parsed = matter(content);

    return {
      content: parsed.content,
      frontmatter: parsed.data,
      rawContent: content,
    };
  } catch (error) {
    throw new Error(
      `Failed to read note: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Check if a path is safe (within vault boundaries)
 *
 * Security check to prevent path traversal attacks.
 * Ensures the requested path resolves to a location within the vault.
 */
export function isPathSafe(requestedPath: string, vaultPath: string): boolean {
  const normalized = path.resolve(vaultPath, requestedPath);
  const normalizedVaultPath = path.resolve(vaultPath);

  const isSafe = normalized.startsWith(normalizedVaultPath);

  if (!isSafe) {
    console.error(
      `[Security] Path traversal attempt blocked: ${requestedPath}`
    );
  }

  return isSafe;
}

/**
 * Normalize path to use forward slashes (for URIs and cross-platform)
 */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/**
 * Extract WikiLinks from content
 *
 * Pattern: [[Link]] or [[Link|Alias]]
 * Returns: Array of link targets (without aliases)
 */
export function extractWikiLinks(content: string): string[] {
  const wikiLinkPattern = /\[\[([^\]]+)\]\]/g;
  const links: string[] = [];

  let match;
  while ((match = wikiLinkPattern.exec(content)) !== null) {
    // Handle [[Link|Alias]] format - take only the link part
    const linkText = match[1].split("|")[0].trim();
    links.push(linkText);
  }

  return [...new Set(links)]; // Deduplicate
}

/**
 * Extract inline tags from content
 *
 * Pattern: #tag or #nested/tag
 * Returns: Array of tags (without # prefix)
 */
export function extractInlineTags(content: string): string[] {
  const tagPattern = /#([a-zA-Z0-9_/-]+)/g;
  const tags: string[] = [];

  let match;
  while ((match = tagPattern.exec(content)) !== null) {
    tags.push(match[1]);
  }

  return [...new Set(tags)]; // Deduplicate
}

/**
 * Get all tags from note (frontmatter + inline)
 *
 * Combines tags from:
 * 1. Frontmatter 'tags' field (array or comma-separated string)
 * 2. Inline tags in content (#tag)
 */
export function getAllTags(frontmatter: any, content: string): string[] {
  const frontmatterTags: string[] = [];

  // Handle frontmatter tags (can be array or string)
  if (frontmatter?.tags) {
    if (Array.isArray(frontmatter.tags)) {
      frontmatterTags.push(...frontmatter.tags);
    } else if (typeof frontmatter.tags === "string") {
      // Handle comma-separated or space-separated tags
      frontmatterTags.push(...frontmatter.tags.split(/[,\s]+/).filter(Boolean));
    }
  }

  const inlineTags = extractInlineTags(content);

  // Combine and deduplicate
  return [...new Set([...frontmatterTags, ...inlineTags])];
}

/**
 * Format timestamp to human-readable date
 */
export function formatDate(date: Date): string {
  return date.toISOString().replace("T", " ").split(".")[0] + " UTC";
}

/**
 * Truncate text to specified length with ellipsis
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return text.substring(0, maxLength - 3) + "...";
}

// =====================================================================
// WRITE OPERATIONS (Phase 2)
// =====================================================================

/**
 * Create a new note in the vault
 *
 * @param vaultPath - Absolute path to vault root
 * @param relativePath - Relative path within vault (e.g., "folder/note.md")
 * @param content - Note content (without frontmatter)
 * @param frontmatter - Optional frontmatter object
 * @returns Absolute path to created note
 * @throws Error if note already exists, path is unsafe, or write fails
 */
export async function createNote(
  vaultPath: string,
  relativePath: string,
  content: string,
  frontmatter?: Record<string, any>
): Promise<string> {
  // Validate path safety
  if (!isPathSafe(relativePath, vaultPath)) {
    throw new Error(
      `Unsafe path: ${relativePath}. Path must not contain traversal sequences.`
    );
  }

  // Normalize and resolve full path
  const normalizedRelativePath = normalizePath(relativePath);
  const absolutePath = path.resolve(vaultPath, normalizedRelativePath);

  // Verify path is within vault
  if (!absolutePath.startsWith(vaultPath)) {
    throw new Error(`Path outside vault: ${relativePath}`);
  }

  // Ensure .md extension
  const finalPath = absolutePath.endsWith(".md")
    ? absolutePath
    : `${absolutePath}.md`;

  // Check if file already exists
  try {
    await fs.access(finalPath);
    throw new Error(`Note already exists: ${relativePath}`);
  } catch (error) {
    // File doesn't exist, which is what we want
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error; // Re-throw if it's not a "file not found" error
    }
  }

  // Create parent directories if needed
  const dir = path.dirname(finalPath);
  await fs.mkdir(dir, { recursive: true });

  // Build file content with frontmatter
  let fileContent: string;
  if (frontmatter && Object.keys(frontmatter).length > 0) {
    // Use gray-matter to stringify frontmatter
    fileContent = matter.stringify(content, frontmatter);
  } else {
    fileContent = content;
  }

  // Write file
  await fs.writeFile(finalPath, fileContent, "utf-8");

  console.error(`[Write] Created note: ${relativePath}`);
  return finalPath;
}

/**
 * Update an existing note in the vault
 *
 * @param vaultPath - Absolute path to vault root
 * @param relativePath - Relative path within vault
 * @param content - New note content (without frontmatter)
 * @param frontmatter - Optional frontmatter object
 * @param mergeFrontmatter - If true, merge with existing frontmatter; if false, replace completely
 * @returns Absolute path to updated note
 * @throws Error if note doesn't exist, path is unsafe, or write fails
 */
export async function updateNote(
  vaultPath: string,
  relativePath: string,
  content: string,
  frontmatter?: Record<string, any>,
  mergeFrontmatter: boolean = true
): Promise<string> {
  // Validate path safety
  if (!isPathSafe(relativePath, vaultPath)) {
    throw new Error(
      `Unsafe path: ${relativePath}. Path must not contain traversal sequences.`
    );
  }

  // Normalize and resolve full path
  const normalizedRelativePath = normalizePath(relativePath);
  const absolutePath = path.resolve(vaultPath, normalizedRelativePath);

  // Verify path is within vault
  if (!absolutePath.startsWith(vaultPath)) {
    throw new Error(`Path outside vault: ${relativePath}`);
  }

  // Ensure .md extension
  const finalPath = absolutePath.endsWith(".md")
    ? absolutePath
    : `${absolutePath}.md`;

  // Check if file exists
  try {
    await fs.access(finalPath);
  } catch (error) {
    throw new Error(`Note not found: ${relativePath}`);
  }

  // Read existing note if we need to merge frontmatter
  let finalFrontmatter = frontmatter;

  if (mergeFrontmatter && frontmatter) {
    try {
      const existingContent = await fs.readFile(finalPath, "utf-8");
      const parsed = matter(existingContent);

      // Merge: new frontmatter takes precedence
      finalFrontmatter = {
        ...parsed.data,
        ...frontmatter,
      };
    } catch (error) {
      console.error(
        `[Write] Could not parse existing frontmatter, using new frontmatter only:`,
        error
      );
    }
  }

  // Build file content with frontmatter
  let fileContent: string;
  if (finalFrontmatter && Object.keys(finalFrontmatter).length > 0) {
    fileContent = matter.stringify(content, finalFrontmatter);
  } else {
    fileContent = content;
  }

  // Write file
  await fs.writeFile(finalPath, fileContent, "utf-8");

  console.error(`[Write] Updated note: ${relativePath}`);
  return finalPath;
}

/**
 * Delete a note from the vault
 *
 * @param vaultPath - Absolute path to vault root
 * @param relativePath - Relative path within vault
 * @returns Absolute path to deleted note
 * @throws Error if note doesn't exist, path is unsafe, or delete fails
 */
export async function deleteNote(
  vaultPath: string,
  relativePath: string
): Promise<string> {
  // Validate path safety
  if (!isPathSafe(relativePath, vaultPath)) {
    throw new Error(
      `Unsafe path: ${relativePath}. Path must not contain traversal sequences.`
    );
  }

  // Normalize and resolve full path
  const normalizedRelativePath = normalizePath(relativePath);
  const absolutePath = path.resolve(vaultPath, normalizedRelativePath);

  // Verify path is within vault
  if (!absolutePath.startsWith(vaultPath)) {
    throw new Error(`Path outside vault: ${relativePath}`);
  }

  // Ensure .md extension
  const finalPath = absolutePath.endsWith(".md")
    ? absolutePath
    : `${absolutePath}.md`;

  // Check if file exists
  try {
    await fs.access(finalPath);
  } catch (error) {
    throw new Error(`Note not found: ${relativePath}`);
  }

  // Delete file
  await fs.unlink(finalPath);

  console.error(`[Write] Deleted note: ${relativePath}`);
  return finalPath;
}
