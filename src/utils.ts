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
import { logInfo, logError, logWarn } from "./logger.js";

// Get the directory where this script is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Character limit for MCP responses (25k tokens ≈ 100k characters, being conservative)
export const CHARACTER_LIMIT = 25000;

// Vector search configuration (shared between server-level defaults and per-vault overrides)
export interface VectorSearchConfig {
  enabled: boolean;
  provider: "transformers" | "anthropic";
  model?: string;
  anthropicApiKey?: string;
  indexOnStartup?: boolean | "auto" | "always" | "never";
}

// Per-vault configuration
export interface VaultConfig {
  name: string; // Unique identifier used in tool params
  path: string; // Absolute path to vault root
  enableWrite: boolean;
  includePatterns?: string[]; // Per-vault override (inherits server default)
  excludePatterns?: string[]; // Per-vault override (inherits server default)
  vectorSearch?: Partial<VectorSearchConfig>; // Per-vault override (inherits server default)
}

// Configuration interface
export interface Config {
  vaultPath: string; // Legacy: single vault path (auto-migrates to vaults[])
  vaults: VaultConfig[]; // Multi-vault configuration
  includePatterns: string[];
  excludePatterns: string[];
  enableWrite: boolean;
  vectorSearch?: VectorSearchConfig;
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

// Resolved vault config with all defaults applied
export interface ResolvedVaultConfig {
  name: string;
  path: string;
  enableWrite: boolean;
  includePatterns: string[];
  excludePatterns: string[];
  vectorSearch: VectorSearchConfig;
}

/**
 * Resolve a VaultConfig by merging per-vault overrides with server-level defaults
 */
export function resolveVaultConfig(
  vault: VaultConfig,
  config: Config
): ResolvedVaultConfig {
  const defaultVectorSearch: VectorSearchConfig = config.vectorSearch ?? {
    enabled: false,
    provider: "transformers",
  };

  return {
    name: vault.name,
    path: vault.path,
    enableWrite: vault.enableWrite ?? config.enableWrite ?? false,
    includePatterns: vault.includePatterns ?? config.includePatterns,
    excludePatterns: vault.excludePatterns ?? config.excludePatterns,
    vectorSearch: {
      ...defaultVectorSearch,
      ...vault.vectorSearch,
    },
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
 * 1. Config file at ./config.json (relative to repo root)
 * 2. Environment variable OBSIDIAN_VAULT_PATH (legacy single-vault)
 * 3. Default configuration
 *
 * Multi-vault: If config has a `vaults` array, use it directly.
 * Legacy migration: If config has `vaultPath` but no `vaults`, auto-migrate
 * to a single-entry `vaults` array with name derived from folder name.
 */
export async function loadConfig(): Promise<Config> {
  // Environment variable takes precedence for vault path
  const vaultPathEnv = process.env.OBSIDIAN_VAULT_PATH;

  // Try to load config file from the repo root (parent of dist/)
  // When compiled, this will be in dist/, so go up one level
  const repoRoot = path.join(__dirname, "..");
  const configPath = process.env.OBSIDIAN_CONFIG_PATH || path.join(repoRoot, "config.json");

  let rawConfig: any = null;

  try {
    const configFile = await fs.readFile(configPath, "utf-8");
    rawConfig = JSON.parse(configFile);
  } catch (error) {
    // Config file not found or invalid, will use defaults
    rawConfig = null;
  }

  if (rawConfig) {
    const config = rawConfig as Config;

    // Override vault path with env var if present (legacy behavior)
    if (vaultPathEnv) {
      logInfo("Using vault path from OBSIDIAN_VAULT_PATH environment variable");
      config.vaultPath = vaultPathEnv;
    }

    // Apply defaults for missing fields
    config.includePatterns = config.includePatterns ?? ["**/*.md"];
    config.excludePatterns = config.excludePatterns ?? [
      "_archive/**",
      ".obsidian/**",
      ".trash/**",
      "node_modules/**",
      "**/node_modules/**",
    ];
    config.enableWrite = config.enableWrite ?? false;
    config.searchOptions = config.searchOptions ?? {
      maxResults: 20,
      excerptLength: 200,
      caseSensitive: false,
      includeMetadata: true,
    };
    config.logging = config.logging ?? {
      level: "info",
      file: "_data/mcp-server.log",
    };

    // Multi-vault migration: if no vaults array, create one from legacy vaultPath
    if (!config.vaults || config.vaults.length === 0) {
      if (!config.vaultPath) {
        throw new Error(
          "No vault configured. Add a 'vaults' array to config.json or set OBSIDIAN_VAULT_PATH environment variable."
        );
      }

      const vaultName = deriveVaultName(config.vaultPath);
      logInfo(
        `Legacy config detected: auto-migrating vaultPath to vaults array with name "${vaultName}"`
      );

      config.vaults = [
        {
          name: vaultName,
          path: config.vaultPath,
          enableWrite: config.enableWrite,
        },
      ];
    }

    // Validate vaults
    await validateVaults(config.vaults);

    // Set vaultPath to first vault for backward compatibility
    config.vaultPath = config.vaults[0].path;

    logInfo(`Configuration loaded from: ${configPath}`);
    logInfo(`Configured vaults: ${config.vaults.map((v) => v.name).join(", ")}`);
    return config;
  }

  // No config file found, use defaults
  logWarn("Could not load config file, using defaults");

  // Determine vault path - require environment variable if no config
  const vaultPath = vaultPathEnv;

  if (!vaultPath) {
    throw new Error(
      "No vault path configured. Please set OBSIDIAN_VAULT_PATH environment variable or create config.json"
    );
  }

  // Validate vault path
  await validateVaultPath(vaultPath);

  const vaultName = deriveVaultName(vaultPath);

  // Return default config with auto-migrated vault
  const defaultConfig: Config = {
    vaultPath: vaultPath,
    vaults: [
      {
        name: vaultName,
        path: vaultPath,
        enableWrite: false,
      },
    ],
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

  logInfo(`Using default configuration with vault "${vaultName}"`);
  return defaultConfig;
}

/**
 * Derive a vault name from its filesystem path
 *
 * Uses the last path segment, lowercased, with spaces replaced by hyphens.
 * e.g., "X:\Obsidian Vaults\Managed Knowledge" -> "managed-knowledge"
 */
function deriveVaultName(vaultPath: string): string {
  const basename = path.basename(vaultPath);
  return basename.toLowerCase().replace(/\s+/g, "-");
}

/**
 * Validate all configured vaults
 *
 * Checks:
 * - Names are unique
 * - Names are valid identifiers (alphanumeric, hyphens, underscores)
 * - Paths exist and are accessible directories
 */
async function validateVaults(vaults: VaultConfig[]): Promise<void> {
  // Check for unique names
  const names = vaults.map((v) => v.name);
  const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate vault names: ${[...new Set(duplicates)].join(", ")}. Each vault must have a unique name.`
    );
  }

  // Validate each vault name and path
  for (const vault of vaults) {
    if (!/^[a-zA-Z0-9_-]+$/.test(vault.name)) {
      throw new Error(
        `Invalid vault name: "${vault.name}". Use only letters, numbers, hyphens, and underscores.`
      );
    }
    await validateVaultPath(vault.path);
  }
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

    logInfo(`Vault path validated: ${vaultPath}`);
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

  logInfo(`Scanning vault: ${normalizedVaultPath}`);
  logInfo(`Include patterns: ${includePatterns.join(", ")}`);
  logInfo(`Exclude patterns: ${excludePatterns.join(", ")}`);

  try {
    // Use fast-glob to find files
    const files = await fg(includePatterns, {
      cwd: normalizedVaultPath,
      ignore: excludePatterns,
      absolute: false,
      onlyFiles: true,
      dot: false, // Don't include hidden files
    });

    logInfo(`Found ${files.length} markdown files`);

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
        logError(`Error processing file ${file}:`, error);
        // Continue processing other files
        continue;
      }
    }

    logInfo(`Successfully processed ${notes.length} notes`);
    return notes;
  } catch (error) {
    logError(`Error scanning vault:`, error);
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

  const isSafe =
    normalized === normalizedVaultPath ||
    normalized.startsWith(normalizedVaultPath + path.sep);

  if (!isSafe) {
    logWarn(`Path traversal attempt blocked: ${requestedPath}`);
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
      // Convert all array items to strings and filter out invalid values
      frontmatterTags.push(
        ...frontmatter.tags
          .filter((tag: any) => tag !== null && tag !== undefined)
          .map((tag: any) => String(tag))
      );
    } else if (typeof frontmatter.tags === "string") {
      // Handle comma-separated or space-separated tags
      frontmatterTags.push(...frontmatter.tags.split(/[,\s]+/).filter(Boolean));
    } else {
      // Handle single non-string tag value
      frontmatterTags.push(String(frontmatter.tags));
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

  // Verify path is within vault (normalize both for comparison - FIXED)
  const normalizedAbsolutePath = path.resolve(absolutePath);
  const normalizedVaultPath = path.resolve(vaultPath);
  if (!normalizedAbsolutePath.startsWith(normalizedVaultPath)) {
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

  logInfo(`Created note: ${relativePath}`);
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

  // Verify path is within vault (normalize both for comparison - FIXED)
  const normalizedAbsolutePath = path.resolve(absolutePath);
  const normalizedVaultPath = path.resolve(vaultPath);
  if (!normalizedAbsolutePath.startsWith(normalizedVaultPath)) {
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
      logWarn(
        "Could not parse existing frontmatter, using new frontmatter only:",
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

  logInfo(`Updated note: ${relativePath}`);
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

  // Verify path is within vault (normalize both for comparison - FIXED)
  const normalizedAbsolutePath = path.resolve(absolutePath);
  const normalizedVaultPath = path.resolve(vaultPath);
  if (!normalizedAbsolutePath.startsWith(normalizedVaultPath)) {
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

  logInfo(`Deleted note: ${relativePath}`);
  return finalPath;
}
