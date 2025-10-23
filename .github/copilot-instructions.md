# Obsidian MCP Server - AI Instructions

## Project Overview

This is a **Model Context Protocol (MCP) server** that provides real-time Claude AI access to Obsidian vaults. The server enables dynamic querying, searching, and reading of notes without token limitations through JSON-RPC 2.0 over stdio.

**Key Purpose**: Bridge Claude AI with Obsidian knowledge bases through efficient, secure, real-time vault access.

## Critical Project Context

### MCP Architecture (CRITICAL)

- **Protocol**: JSON-RPC 2.0 over stdio (stdin/stdout), NOT REST/HTTP
- **Server Model**: Long-running process with structured message communication
- **Resources**: Vault notes exposed as `obsidian://vault/[path]` URIs
- **Tools**: Functions callable by Claude (search_vault, create_note, read_note, etc.)
- **Implementation**: TypeScript using @modelcontextprotocol/sdk

### Technology Stack

**Runtime & Build**:
- Node.js 18+ (recommended 20+)
- TypeScript 5.7+ with strict mode
- ES Modules (type: "module" in package.json)

**Core Dependencies**:
- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `@xenova/transformers` - Local embedding generation (Transformers.js)
- `vectra` - Local vector database for semantic search
- `chokidar` - File system watcher for automatic index updates
- `winston` - Structured logging system
- `gray-matter` - YAML frontmatter parsing
- `zod` - Runtime type validation

**Development**:
- `tsx` - TypeScript execution and hot reload
- `prettier` - Code formatting
- `eslint` - Code linting

### Project Structure

```text
obsidian-mcp-server/
├── src/
│   ├── index.ts              # Entry point, server initialization
│   ├── obsidian-server.ts    # MCP request handlers (resources, tools)
│   ├── embeddings.ts         # Vector store and embedding generation
│   ├── search.ts             # Keyword search implementation
│   ├── utils.ts              # Config loading, path helpers
│   ├── logger.ts             # Winston logging configuration
│   └── indexing-worker.ts    # Background indexing worker process
├── docs/
│   ├── configuration.md      # Configuration options
│   ├── indexing-workflow.md  # Indexing procedures and troubleshooting
│   ├── semantic-search.md    # Search implementation details
│   └── vector-search.md      # Vector search architecture
├── scripts/
│   └── inspect-yaml-issues.ps1  # YAML frontmatter debugging
├── .github/
│   ├── copilot-instructions.md  # This file
│   ├── obsidian-mcp-server.code-workspace  # VS Code workspace
│   └── README.md             # GitHub folder documentation
├── config.json               # Runtime configuration (gitignored)
├── config.example.json       # Configuration template
└── package.json              # Dependencies and scripts
```

### Obsidian Vault Structure

**File Format**:
- Primary: Markdown files (.md extension)
- Frontmatter: YAML metadata (optional) at file top
- WikiLinks: `[[Note Name]]` for internal references
- Tags: Both frontmatter (`tags: [tag1, tag2]`) and inline (`#tag`)

**Frontmatter Example**:

```yaml
---
title: Example Note
aliases: [alt-name-1, alt-name-2]
tags: [project, important]
created: 2025-10-23
modified: 2025-10-23T10:30:00
---
```

**Conventions**:
- Folders can have any structure (user-defined hierarchy)
- Special folders often prefixed with `.` or `_` (e.g., `.obsidian`, `_archive`)
- File names can contain spaces and Unicode characters

## Development Workflows

### TypeScript Development Pattern

**MCP Server Handler Pattern**:

```typescript
// Resource handler (list notes)
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const notes = await findAllNotes(vaultPath);
  return {
    resources: notes.map(note => ({
      uri: `obsidian://vault/${note.relativePath}`,
      name: note.name,
      description: note.frontmatter?.description || '',
      mimeType: 'text/markdown',
    })),
  };
});

// Tool handler (search)
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'search_vault') {
    const { query, searchMode } = request.params.arguments;
    const results = await searchVault(vaultPath, query, searchMode);
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(results, null, 2),
      }],
    };
  }
});
```

### File Path Handling (CRITICAL)

**Windows/WSL Compatibility**:

```typescript
import * as path from 'path';
import * as fs from 'fs/promises';

// ALWAYS normalize paths
const vaultPath = process.env.OBSIDIAN_VAULT_PATH || '';
const normalizedPath = path.resolve(vaultPath);

// Handle both forward and backslashes
const relativePath = path.relative(normalizedPath, filePath);
const uriPath = relativePath.replace(/\\/g, '/');  // URIs always use forward slashes

// Safe path validation
function isWithinVault(filePath: string, vaultPath: string): boolean {
  const resolved = path.resolve(vaultPath, filePath);
  return resolved.startsWith(path.resolve(vaultPath));
}
```

### Async/Error Handling Pattern

```typescript
// Preferred pattern: try-catch with meaningful errors
async function processNote(notePath: string): Promise<NoteData> {
  try {
    const content = await fs.readFile(notePath, 'utf-8');
    const { data: frontmatter, content: markdown } = matter(content);
    
    return {
      path: notePath,
      frontmatter,
      content: markdown,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Note not found: ${notePath}`);
    }
    throw new Error(`Failed to read note: ${error.message}`);
  }
}
```

## Project-Specific Conventions

### MCP Protocol Standards

- **JSON-RPC 2.0**: All requests/responses follow specification
- **URI format**: `obsidian://vault/[relative-path]` for note resources
- **Error codes**: Standard JSON-RPC codes (-32700 to -32603)
- **Tool naming**: snake_case (search_vault, create_note, read_note)
- **Response format**: Text content in `content` array with `type: 'text'`

### TypeScript Code Standards

**Style**:
- Strict mode enabled (all strict TypeScript checks)
- Explicit return types for functions
- Named exports preferred over default exports
- File naming: kebab-case for files, PascalCase for classes
- Use `async/await` over promise chains

**Formatting**:
- 2-space indentation
- Double quotes for strings
- Trailing commas in ES5-compatible structures
- Line length: 80-120 characters (soft limit)

**Error Handling**:
- All async operations wrapped in try-catch
- Meaningful error messages with context
- Log errors with appropriate severity (logError, logWarn)

### Obsidian-Specific Handling

**Frontmatter**:
- Parse with `gray-matter` library
- Handle missing/invalid frontmatter gracefully
- Common fields: title, aliases, tags, created, modified

**WikiLinks**:
- Pattern: `\[\[([^\]]+)\]\]`
- Can include display text: `[[Target|Display]]`
- Used for relationship mapping

**Tags**:
- Frontmatter tags: `tags: [tag1, tag2]` (array or string)
- Inline tags: `#tag` or `#nested/tag`
- Normalize for comparison (lowercase, trim)

**Special Characters**:
- Handle spaces in file names (URL encode for URIs)
- Support Unicode in file names
- Case sensitivity: Windows insensitive, Linux/macOS sensitive

### Logging Standards

**Log Levels**:

```typescript
import { logInfo, logWarn, logError, logDebug } from './logger.js';

logInfo('Normal operation message');        // General information
logWarn('Non-critical issue occurred');     // Warning, but continues
logError('Critical error happened', error); // Errors requiring attention
logDebug('Detailed diagnostic info');       // Verbose debugging
```

**When to Log**:
- Server startup/shutdown
- Configuration loading
- Index creation/updates
- Search operations (with query and result count)
- File watcher events
- Errors and warnings

**Log Format**:
- Winston structured logging (JSON in file, formatted in console)
- File: `logs/mcp-server.log`
- Rotation: Daily, keep 14 days

## Documentation Standards

### Markdown Formatting

**Required**:
- No trailing spaces (remove with regex: `\s+$`)
- Single trailing newline at end of file
- Blank lines before/after tables and code blocks
- Language specified for all code blocks

**Code Blocks**:

```markdown
<!-- Correct -->
\`\`\`typescript
const example = 'code';
\`\`\`

<!-- For non-code content -->
\`\`\`text
folder/
  subfolder/
    file.txt
\`\`\`
```

**Tables**:

```markdown
<!-- Blank line before table -->

| Column 1 | Column 2 |
| -------- | -------- |
| Value 1  | Value 2  |

<!-- Blank line after table -->
```

### File Naming Conventions

- **Documentation**: kebab-case (e.g., `indexing-workflow.md`)
- **Source files**: kebab-case (e.g., `obsidian-server.ts`)
- **Config files**: kebab-case (e.g., `config.example.json`)

### Documentation Structure

**Headers**:
- H1 (`#`): File title
- H2 (`##`): Major sections
- H3 (`###`): Subsections
- H4 (`####`): Detailed subsections (use sparingly)

**Code Examples**:
- Include both Windows (PowerShell) and Linux/macOS (Bash) versions
- Show complete, runnable examples
- Include expected output when relevant

## Key Integration Points

### Claude Desktop Configuration

**Windows**:
- Config file: `%APPDATA%\Claude\claude_desktop_config.json`
- Full path: `C:\Users\[USERNAME]\AppData\Roaming\Claude\claude_desktop_config.json`

**macOS**:
- Config file: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Config Structure**:

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "node",
      "args": [
        "--expose-gc",
        "--max-old-space-size=16384",
        "D:\\repos\\obsidian-mcp-server\\dist\\index.js"
      ],
      "env": {
        "OBSIDIAN_VAULT_PATH": "X:\\Path\\To\\Vault",
        "OBSIDIAN_CONFIG_PATH": "D:\\repos\\obsidian-mcp-server\\config.json"
      }
    }
  }
}
```

**Important Notes**:
- Windows paths require double backslashes in JSON
- Use absolute paths for reliability
- Node.js memory flags recommended for large vaults

### Vector Search Architecture

**Embedding Models** (Transformers.js):
- `Xenova/all-MiniLM-L6-v2` - 384 dims, fast, good quality (default)
- `Xenova/bge-base-en-v1.5` - 768 dims, best quality, slower
- `Xenova/bge-small-en-v1.5` - 384 dims, balanced

**Index Structure**:
- Location: `[VAULT_PATH]/.mcp-vector-store/`
- Format: Vectra LocalIndex
- Metadata: `index-metadata.json` with model info
- Checkpoints: Progress saved every 50 notes

**Indexing Modes** (`indexOnStartup`):
- `"always"` - Re-index on every startup (slow, use for testing)
- `"auto"` - Auto-detect if indexing needed (model mismatch, missing index)
- `false` - Never auto-index (recommended for production)

### File Watcher System

**Implementation**:

```typescript
import chokidar from 'chokidar';

const watcher = chokidar.watch(vaultPath, {
  ignored: /(^|[\/\\])\../, // Ignore dotfiles
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 1000, // Wait 1s after last change
    pollInterval: 100,
  },
  depth: 99,
});

watcher
  .on('add', async (filePath) => {
    if (filePath.endsWith('.md')) {
      await vectorStore.indexNote(filePath);
    }
  })
  .on('change', async (filePath) => {
    if (filePath.endsWith('.md')) {
      await vectorStore.updateNote(filePath);
    }
  })
  .on('unlink', async (filePath) => {
    if (filePath.endsWith('.md')) {
      await vectorStore.removeNote(filePath);
    }
  });
```

**Characteristics**:
- Debounce: 2-second delay for stability
- Auto-indexing: Creates/updates/deletes in real-time
- Status: ✅ Validated production-ready (Oct 23, 2025)

## Critical Implementation Details

### Memory Management

**Large Vault Handling**:
- Use `--expose-gc --max-old-space-size=16384` for indexing
- Checkpoint system saves progress every 50 notes
- Background worker for indexing to avoid blocking MCP server

**Garbage Collection**:

```typescript
// Explicit GC after batch operations
if (global.gc && noteCount % 100 === 0) {
  global.gc();
}
```

### Search Implementation

**Hybrid Search** (combines keyword + semantic):
1. Keyword search with TF-IDF scoring
2. Semantic search with cosine similarity
3. Merge results with weighted scoring
4. Deduplicate and sort by relevance

**Keyword Search**:
- Tokenization with stop word removal
- Case-insensitive matching
- Frontmatter field boosting (title, aliases)

**Vector Search**:
- Generate query embedding
- Cosine similarity against indexed notes
- Configurable top-k results (default: 10)

### Configuration System

**Loading Priority**:
1. Environment variable: `OBSIDIAN_CONFIG_PATH`
2. Default location: `./config.json`
3. Fallback: Built-in defaults

**Config Validation**:
- Zod schemas for runtime validation
- Type-safe configuration objects
- Meaningful error messages for invalid config

## Common Pitfalls to Avoid

**MCP Protocol**:
- ❌ Don't use REST/HTTP - MCP is JSON-RPC over stdio
- ❌ Don't assume synchronous operations - all I/O is async
- ❌ Don't return raw objects - wrap in proper MCP response format

**File Paths**:
- ❌ Don't hardcode paths - use environment variables
- ❌ Don't assume Unix paths - handle Windows backslashes
- ❌ Don't skip path validation - always check paths are within vault

**Vector Search**:
- ❌ Don't load entire vault into memory - use streaming/batching
- ❌ Don't skip error handling - embedding generation can fail
- ❌ Don't ignore model mismatches - index must match model

**Obsidian Specifics**:
- ❌ Don't assume all files have frontmatter - handle missing gracefully
- ❌ Don't ignore special characters - properly escape for URIs
- ❌ Don't hardcode folder structures - user vaults vary widely

## Testing Strategy

### Manual Testing

**MCP Server**:
1. Run standalone: `node dist/index.js`
2. Check logs: `logs/mcp-server.log`
3. Verify initialization messages

**Vector Search**:
1. Create test note with unique token
2. Search for token via Claude
3. Verify result score and content

**File Watcher**:
1. CREATE: Add new note, search immediately
2. MODIFY: Edit note, search for new content
3. DELETE: Remove note, verify no results

### Validation Procedures

**Index Metadata** (PowerShell):

```powershell
Get-Content "X:\Vault\.mcp-vector-store\index-metadata.json" | ConvertFrom-Json | Select-Object -First 5
```

**Search via Claude**:

```text
Search for "UNIQUE-TOKEN-12345" in the vault
```

**File Watcher Status**:
- Check logs for "File system watcher started" message
- Verify add/change/unlink events logged

## Build and Deployment

### Development Workflow

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Development with hot reload
npm run dev

# Run tests
npm test

# Format code
npm run format

# Lint code
npm run lint
```

### Production Build

```bash
# Clean previous build
npm run clean

# Build with type checking
npm run build

# Verify output
ls dist/

# Test standalone
node dist/index.js
```

### Release Process

1. Update version in `package.json`
2. Build and test: `npm run build && npm test`
3. Commit: `git commit -am "chore: release v1.x.x"`
4. Tag: `git tag v1.x.x`
5. Push: `git push && git push --tags`

## References & Standards

- [MCP Specification](https://spec.modelcontextprotocol.io/) - Protocol specification
- [JSON-RPC 2.0](https://www.jsonrpc.org/specification) - RPC protocol
- [TypeScript Handbook](https://www.typescriptlang.org/docs/) - Language reference
- [Transformers.js](https://huggingface.co/docs/transformers.js) - Embedding generation
- [Vectra Documentation](https://github.com/Stevenic/vectra) - Vector database
- [Obsidian API](https://docs.obsidian.md/) - Vault structure and conventions

## Version History

- **v1.4.0** (Oct 2025) - File watcher auto-indexing, model logging, comprehensive documentation
- **v1.3.0** - Vector search with local embeddings, hybrid search
- **v1.2.0** - Write operations, configuration system
- **v1.1.0** - Keyword search, tag filtering
- **v1.0.0** - Initial MCP server with resource listing
