/**
 * Search Engine Implementation for Obsidian Vault
 *
 * Provides comprehensive keyword-based search with:
 * - Multi-term keyword matching
 * - Frontmatter filtering
 * - Tag-based queries
 * - Folder filtering
 * - Excerpt extraction with context
 * - Relevance scoring
 * - Pagination support
 */

import { findAllNotes, readNote, getAllTags } from "./utils.js";
import { logInfo, logError } from "./logger.js";
import * as path from "path";

export interface SearchOptions {
  tags?: string[];
  folders?: string[];
  limit?: number;
  offset?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
  excerptLength?: number;
}

export interface SearchResult {
  title: string;
  path: string;
  excerpt: string;
  score: number;
  tags?: string[];
  uri: string;
}

/**
 * Search vault for notes matching query
 *
 * Algorithm:
 * 1. Find all notes matching include/exclude patterns
 * 2. Filter by folders and tags if specified
 * 3. Read each note and calculate relevance score
 * 4. Extract excerpt around first match
 * 5. Sort by score (descending)
 * 6. Apply pagination (offset + limit)
 *
 * Scoring:
 * - Title match: 10 points per keyword
 * - Frontmatter description: 5 points per keyword
 * - Tag match: 3 points per keyword
 * - Content match: 1 point per occurrence
 */
export async function searchVault(
  vaultPath: string,
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const {
    tags,
    folders,
    limit = 20,
    offset = 0,
    includePatterns = ["**/*.md"],
    excludePatterns = [],
    excerptLength = 200,
  } = options;

  logInfo(
    `Starting search: query="${query}", tags=${tags?.join(",")}, folders=${folders?.join(",")}`
  );

  // Find all notes
  const notes = await findAllNotes(vaultPath, includePatterns, excludePatterns);
  logInfo(`Found ${notes.length} total notes`);

  const results: SearchResult[] = [];
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 0);

  logInfo(`Query terms: [${queryTerms.join(", ")}]`);

  let processedCount = 0;
  let matchedCount = 0;

  for (const note of notes) {
    try {
      processedCount++;

      // Filter by folder if specified
      if (folders && folders.length > 0) {
        const noteFolder = path.dirname(note.relativePath);
        const matchesFolder = folders.some((f) => {
          // Normalize folder paths for comparison
          const normalizedFolder = f.replace(/\\/g, "/").replace(/\/$/, "");
          const normalizedNoteFolder = noteFolder.replace(/\\/g, "/");

          return (
            normalizedNoteFolder.startsWith(normalizedFolder) ||
            normalizedNoteFolder === normalizedFolder
          );
        });

        if (!matchesFolder) {
          continue;
        }
      }

      // Read full note content
      const fullPath = path.join(vaultPath, note.relativePath);
      const noteData = await readNote(fullPath);

      // Get all tags (frontmatter + inline)
      const noteTags = getAllTags(note.frontmatter, noteData.content);

      // Filter by tags if specified (must have ALL specified tags)
      if (tags && tags.length > 0) {
        const hasAllTags = tags.every((requiredTag) =>
          noteTags.some((noteTag) =>
            noteTag.toLowerCase().includes(requiredTag.toLowerCase())
          )
        );

        if (!hasAllTags) {
          continue;
        }
      }

      const contentLower = noteData.content.toLowerCase();
      const titleLower = (note.title || note.name).toLowerCase();
      const descriptionLower = (
        note.frontmatter?.description || ""
      ).toLowerCase();

      // Calculate match score
      let score = 0;
      let matchPositions: number[] = [];

      for (const term of queryTerms) {
        // Title match (highest weight: 10 points)
        const titleMatches = (titleLower.match(new RegExp(term, "g")) || [])
          .length;
        if (titleMatches > 0) {
          score += titleMatches * 10;
        }

        // Frontmatter description match (5 points)
        const descMatches = (
          descriptionLower.match(new RegExp(term, "g")) || []
        ).length;
        if (descMatches > 0) {
          score += descMatches * 5;
        }

        // Tag match (3 points)
        const tagMatches = noteTags.filter((t) =>
          t.toLowerCase().includes(term)
        ).length;
        if (tagMatches > 0) {
          score += tagMatches * 3;
        }

        // Content matches (1 point each)
        let pos = contentLower.indexOf(term);
        while (pos !== -1) {
          score += 1;
          matchPositions.push(pos);
          pos = contentLower.indexOf(term, pos + 1);
        }
      }

      // Skip if no matches
      if (score === 0) {
        continue;
      }

      matchedCount++;

      // Extract excerpt around first match
      const excerptPosition =
        matchPositions.length > 0 ? Math.min(...matchPositions) : 0;

      const excerpt = extractExcerpt(
        noteData.content,
        excerptPosition,
        queryTerms[0],
        excerptLength
      );

      results.push({
        title: note.title || note.name,
        path: note.relativePath,
        excerpt,
        score,
        tags: noteTags.length > 0 ? noteTags : undefined,
        uri: `obsidian://vault/${note.relativePath}`,
      });
    } catch (error) {
      logError(`Error processing note ${note.name}:`, error);
      // Continue processing other notes
      continue;
    }
  }

  logInfo(`Processed ${processedCount} notes, found ${matchedCount} matches`);

  // Sort by score (descending)
  results.sort((a, b) => b.score - a.score);

  // Apply pagination
  const paginatedResults = results.slice(offset, offset + limit);

  logInfo(
    `Returning ${paginatedResults.length} results (offset: ${offset}, limit: ${limit})`
  );

  return paginatedResults;
}

/**
 * Extract excerpt from content around match position
 *
 * Tries to:
 * 1. Center excerpt around match
 * 2. Start/end at word boundaries
 * 3. Add ellipsis when truncated
 * 4. Clean up whitespace
 */
function extractExcerpt(
  content: string,
  position: number,
  query: string,
  maxLength: number
): string {
  const halfLength = Math.floor(maxLength / 2);

  // Find start position (try to start at word boundary)
  let start = Math.max(0, position - halfLength);
  if (start > 0) {
    // Move to next space or newline to avoid cutting words
    const nextSpace = content.indexOf(" ", start);
    const nextNewline = content.indexOf("\n", start);

    if (nextSpace !== -1 && (nextNewline === -1 || nextSpace < nextNewline)) {
      start = nextSpace + 1;
    } else if (nextNewline !== -1) {
      start = nextNewline + 1;
    }
  }

  // Find end position (try to end at word boundary)
  let end = Math.min(content.length, position + query.length + halfLength);
  if (end < content.length) {
    // Move to previous space or newline to avoid cutting words
    const prevSpace = content.lastIndexOf(" ", end);
    const prevNewline = content.lastIndexOf("\n", end);

    if (prevSpace !== -1 && prevSpace > start) {
      end = prevSpace;
    } else if (prevNewline !== -1 && prevNewline > start) {
      end = prevNewline;
    }
  }

  let excerpt = content.slice(start, end).trim();

  // Add ellipsis
  if (start > 0) excerpt = "..." + excerpt;
  if (end < content.length) excerpt = excerpt + "...";

  // Clean up multiple spaces and newlines
  excerpt = excerpt.replace(/\s+/g, " ").replace(/\n+/g, " ").trim();

  return excerpt;
}

/**
 * Calculate relevance score for a note against query terms
 *
 * This is a helper that could be used for more advanced scoring.
 * Currently the scoring is inlined in searchVault for clarity.
 */
export function calculateScore(
  title: string,
  content: string,
  tags: string[],
  queryTerms: string[]
): number {
  let score = 0;

  const titleLower = title.toLowerCase();
  const contentLower = content.toLowerCase();

  for (const term of queryTerms) {
    // Title matches
    if (titleLower.includes(term)) {
      score += 10;
    }

    // Tag matches
    if (tags.some((t) => t.toLowerCase().includes(term))) {
      score += 3;
    }

    // Content matches
    const matches = (contentLower.match(new RegExp(term, "g")) || []).length;
    score += matches;
  }

  return score;
}
