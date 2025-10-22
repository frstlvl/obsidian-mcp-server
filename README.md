# Obsidian MCP Server

> Provides real-time Claude AI access to Obsidian vaults via Model Context Protocol (MCP)

## Overview

This MCP server enables Claude to query, search, and read notes from Obsidian vaults **without token limitations**. Unlike Claude Projects which load all documents into context, this server provides dynamic, on-demand access to your knowledge base.

## Features

- **Real-time Vault Access**: Query and read notes dynamically without pre-uploading
- **Automatic Index Updates**: File system watcher automatically updates vector index when notes change (v1.3.0)
- **Vector Search**: Semantic search using local embeddings (Transformers.js) or Anthropic API
- **Hybrid Search**: Combines keyword and semantic search for optimal results
- **Write Operations**: Create, update, and delete notes programmatically
- **Search Tools**: Keyword, tag, and folder-based filtering
- **Multiple Formats**: JSON and Markdown response formats
- **Secure**: Path validation and security checks prevent unauthorized access
- **Token Efficient**: No vault size limitations or token constraints

## Quick Start

### Prerequisites

- **Node.js** 18+ (recommended: 20+)
- **TypeScript** 5.7+
- **Obsidian vault** with markdown notes
- **Claude Desktop** or MCP-compatible client

### Installation

**Windows (PowerShell):**

```powershell
# 1. Clone or navigate to repository
cd /path/to/obsidian-mcp

# 2. Install dependencies
npm install

# 3. Build TypeScript
npm run build

# 4. Verify build succeeded
Test-Path dist\index.js  # Should return True
```

**macOS/Linux (Bash):**

```bash
# 1. Clone or navigate to repository
cd ~/obsidian-mcp

# 2. Install dependencies
npm install

# 3. Build TypeScript
npm run build

# 4. Verify build succeeded
ls dist/index.js  # Should exist
```

### Configuration

#### Option 1: Environment Variable (Recommended)

**Windows (PowerShell):**

```powershell
# Set vault path (replace with your vault location)
$env:OBSIDIAN_VAULT_PATH = "C:\Users\YourName\Documents\ObsidianVault"

# Test server
node dist\index.js
```

**macOS/Linux (Bash):**

```bash
# Set vault path (replace with your vault location)
export OBSIDIAN_VAULT_PATH="/Users/YourName/Documents/ObsidianVault"

# Test server
node dist/index.js
```

#### Option 2: Configuration File

Create `config.json` in the project root:

```json
{
  "includePatterns": ["**/*.md"],
  "excludePatterns": [".obsidian/**", ".trash/**", "node_modules/**"],
  "enableWrite": true,
  "vectorSearch": {
    "enabled": true,
    "provider": "transformers",
    "model": "Xenova/all-MiniLM-L6-v2",
    "autoIndex": false
  },
  "searchOptions": {
    "maxResults": 20,
    "excerptLength": 200,
    "caseSensitive": false,
    "includeMetadata": true
  },
  "logging": {
    "level": "info",
    "file": "logs/mcp-server.log"
  }
}
```

> > **Note:** This still keeps the repo history on GitHub until you force-push.

### Claude Desktop Integration

#### Windows

Edit Claude Desktop configuration:

```powershell
# Config location: %APPDATA%\Claude\claude_desktop_config.json
notepad "$env:APPDATA\Claude\claude_desktop_config.json"
```

Add this configuration:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": [
        "/path/to/obsidian-mcp-server/dist/index.js"
      ],
      "env": {
        "OBSIDIAN_VAULT_PATH": "C:\\Users\\YourName\\Documents\\ObsidianVault"
      }
    }
  }
}
```

#### macOS

Edit Claude Desktop configuration:

```bash
# Config location: ~/Library/Application Support/Claude/claude_desktop_config.json
vi ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

Add this configuration:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": [
        "/path/to/obsidian-mcp/dist/index.js"
      ],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/vault"
      }
    }
  }
}
```

#### Restart Claude Desktop

After configuration, **completely quit and restart Claude Desktop** for changes to take effect.

## Documentation

- **[Configuration Guide](docs/configuration.md)** - Complete configuration reference
- **[Semantic Search Guide](docs/semantic-search.md)** - Semantic search setup and usage

## Usage

### In Claude Conversations

Once configured, Claude can automatically access your vault:

```text
User: "Search my vault for notes about Python debugging"

Claude will use: obsidian_search_vault(query="Python debugging")
Returns: Matching notes with excerpts and URIs

User: "Show me the full Getting-Started note"

Claude will read: obsidian://vault/Guides/Getting-Started.md
Returns: Complete note content
```

### Available Tools

#### obsidian_search_vault

Search vault by keywords, tags, or folders.

**Parameters:**
- `query` (required): Search keywords (space-separated)
- `tags` (optional): Filter by tags (must have ALL)
- `folders` (optional): Limit to specific folders
- `limit` (optional): Max results (1-100, default: 20)
- `offset` (optional): Pagination offset (default: 0)
- `response_format` (optional): "markdown" or "json" (default: "markdown")

**Examples:**

```typescript
// Find notes about a specific topic
obsidian_search_vault(query="JavaScript testing")

// Find active project notes
obsidian_search_vault(
  query="project",
  tags=["active"],
  folders=["Projects"]
)
```

#### obsidian_semantic_search

Search vault using semantic similarity (meaning-based) instead of keyword matching.

**Parameters:**
- `query` (required): Natural language query (1-500 chars)
- `limit` (optional): Max results (1-50, default: 10)
- `min_score` (optional): Similarity threshold (0-1, default: 0.5)
- `hybrid` (optional): Combine with keyword search (default: false)
- `response_format` (optional): "markdown" or "json" (default: "markdown")

**Examples:**

```typescript
// Find conceptually related notes
obsidian_semantic_search(query="machine learning ethics")

// Hybrid search (semantic + keyword)
obsidian_semantic_search(
  query="web development best practices",
  hybrid=true,
  limit=15
)
```

#### obsidian_create_note

Create a new note in the vault.

**Parameters:**
- `path` (required): Relative path for new note (e.g., "Projects/NewNote.md")
- `content` (required): Note content (markdown)
- `frontmatter` (optional): YAML frontmatter object

#### obsidian_update_note

Update an existing note's content or frontmatter.

**Parameters:**
- `path` (required): Relative path to note
- `content` (optional): New content (replaces existing)
- `frontmatter` (optional): New frontmatter (merges with existing)
- `append` (optional): Append content instead of replace (default: false)

#### obsidian_delete_note

Delete a note from the vault.

**Parameters:**
- `path` (required): Relative path to note
- `confirm` (required): Must be `true` to confirm deletion

### Available Resources

Every note in your vault is exposed as a resource with URI:

```text
obsidian://vault/[relative-path]
```

Claude can list all available notes and read specific notes by URI.

## Architecture

### Design Philosophy

This server uses a **search-tool-only** approach rather than pre-registering thousands of individual resources:

- **Efficient**: Claude uses `obsidian_search_vault` to find notes dynamically
- **Scalable**: Works with vaults of any size (tested with 5,000+ notes)
- **Fast**: No startup delay from resource registration
- **MCP-compliant**: Follows best practices for large datasets

Claude discovers notes through search, receives `obsidian://vault/` URIs, and can then read specific notes on demand.

### Component Diagram

```mermaid
graph LR
    A[Claude AI] -->|MCP Protocol| B[MCP Server]
    B -->|stdio| A
    B --> C[Vault Manager]
    C --> D[Search Engine]
    C --> E[File Reader]
    D --> F[Obsidian Vault]
    E --> F
```

### Components

- **index.ts** - Server initialization and transport setup
- **obsidian-server.ts** - MCP request handlers (resources, tools)
- **search.ts** - Search engine with scoring and filtering
- **utils.ts** - Configuration, file operations, security

## Security

### Path Validation

All file paths are validated to prevent directory traversal attacks:

```typescript
// Checks that requested path is within vault boundaries
if (!isPathSafe(notePath, vaultPath)) {
  throw new Error('Access denied: path outside vault');
}
```

### Read-Only Mode

By default, server is **read-only**. To enable write operations (future feature):

```json
{
  "enableWrite": true
}
```

### Input Sanitization

- **Zod schemas** validate all tool inputs
- **Path normalization** prevents Windows/Unix path issues
- **Query limits** prevent resource exhaustion (max 500 chars)

## Development

### Build

```bash
npm run build
```

### Development Mode (Hot Reload)

```bash
npm run dev
```

### Linting

```bash
npm run lint
npm run format
```

### Testing

```bash
npm test
```

## Troubleshooting

### Server Not Starting

**Check vault path:**

```powershell
# Windows
Test-Path "C:\Users\YourName\Documents\ObsidianVault"  # Should return True
```

```bash
# macOS/Linux
ls -la ~/Documents/ObsidianVault  # Should show folder contents
```

**Check build output:**

```powershell
# Windows
Test-Path .\dist\index.js  # Should return True
```

```bash
# macOS/Linux
ls dist/index.js  # Should exist
```

**View error logs:**

```bash
# All platforms
node dist/index.js
```

### Claude Not Finding Server

1. **Verify config file location:**
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

2. **Check JSON syntax:** Use a JSON validator

3. **Restart Claude Desktop completely** (don't just close window)

4. **Check Claude logs:**
   - Windows: `%APPDATA%\Claude\logs\`
   - macOS: `~/Library/Logs/Claude/`

### Search Returns No Results

- **Check exclude patterns** - Your notes might be excluded
- **Verify file extension** - Only `.md` files are indexed
- **Check query terms** - Try broader terms

### Permission Errors

Ensure your user has read access to:
- Vault directory
- All subdirectories
- All `.md` files

## Configuration Options

Full configuration schema:

```typescript
{
```typescript
{
  // Note: vaultPath is set via OBSIDIAN_VAULT_PATH env variable
  includePatterns: string[];      // Glob patterns to include
  excludePatterns: string[];      // Glob patterns to exclude
  enableWrite: boolean;           // Enable write operations
  vectorSearch?: {                // Optional vector search config
    enabled: boolean;             // Enable semantic search
    provider: "transformers";     // Embedding provider
    model?: string;               // Model name (default: Xenova/all-MiniLM-L6-v2)
    autoIndex: boolean;           // Auto-index on startup
  };
  searchOptions: {
    maxResults: number;           // Max search results (default: 20)
    excerptLength: number;        // Excerpt length (default: 200)
    caseSensitive: boolean;       // Case-sensitive search (default: false)
    includeMetadata: boolean;     // Include frontmatter (default: true)
  };
  logging: {
    level: string;                // Log level (default: "info")
    file: string;                 // Log file path
  };
}
```

## Performance

### Optimization Strategies

- **Lazy loading** - Only reads files when requested
- **Pagination** - Limits search results
- **Character limits** - Truncates large responses
- **Exclude patterns** - Skips unnecessary files

### Recommended Limits

- **Vault size**: < 10,000 notes
- **Search results**: < 100 per query
- **File size**: < 10MB per note

### Future Enhancements

- **Indexing** - Pre-build search index for faster queries
- **Caching** - Cache frontmatter and metadata
- **Vector search** - Semantic similarity search
- **Watch mode** - Real-time file system monitoring

## MCP Protocol Compliance

This server follows [MCP best practices](https://modelcontextprotocol.io/):

- ✅ Zod input validation
- ✅ Tool annotations (readOnlyHint, destructiveHint, etc.)
- ✅ Multiple response formats (JSON/Markdown)
- ✅ Character limits (25k) with truncation
- ✅ Proper error handling
- ✅ Pagination support
- ✅ Security validation
- ✅ Descriptive tool documentation
- ✅ Search-tool pattern for large datasets

## Changelog

### v1.3.0 (October 2025) - Automatic Index Updates

**New Features**:

- ✅ **Automatic file watching**: Real-time vector index updates when notes change (chokidar)
- ✅ **Debounced re-indexing**: Smart 2-second delay prevents excessive rebuilds
- ✅ **Seamless integration**: No manual re-indexing required

### v1.2.0 (October 2025) - Vector Search & Write Operations

**New Features**:

- ✅ **Semantic search** with vector embeddings (Transformers.js)
- ✅ **Write operations**: Create, update, and delete notes
- ✅ **Hybrid search**: Combine semantic and keyword search (60/40 weighting)
- ✅ **Incremental indexing**: Track file modifications for efficient updates
- ✅ **Local embeddings**: Privacy-first with Xenova/all-MiniLM-L6-v2 model

**Bug Fixes**:

- ✅ Fixed config.json loading to use script directory instead of CWD
- ✅ Fixed tags handling for non-array frontmatter tags
- ✅ Improved error handling for malformed YAML frontmatter

**Performance**:

- ✅ Tested with 5,457 note vault (5,456 indexed successfully)
- ✅ Fast startup with optional auto-indexing
- ✅ Vectra-based local vector store (no external server required)

### v1.0.0 (January 2025) - Production Release

**Architecture**:

- ✅ Search-tool-only design (no resource pre-registration)
- ✅ Fast startup (< 1 second)
- ✅ Scalable to vaults of any size

**Security**:

- ✅ Updated all dependencies (0 vulnerabilities)
- ✅ ESLint 9.17.0, Rimraf 6.0.1, TypeScript-ESLint 8.18.2
- ✅ Eliminated deprecated packages with memory leak risks

**MCP SDK**:

- ✅ Migrated to MCP SDK 1.20+ API
- ✅ Updated from old `registerResourceList`/`registerResource` methods
- ✅ Clean TypeScript compilation (0 errors)

**Testing**:

- ✅ Verified with 5,453 note vault
- ✅ Tested on Windows 11 with Node.js 25.0.0
- ✅ Confirmed Claude Desktop integration

## License

MIT License - See LICENSE file for details

## Contributing

Contributions welcome! Please:

1. Follow existing code style
2. Add tests for new features
3. Update documentation
4. Follow MCP best practices

## References

- [MCP Specification](https://modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Claude MCP Documentation](https://docs.anthropic.com/en/docs/agents-and-tools/mcp)
- [Obsidian API](https://docs.obsidian.md/)

---

**Built with ❤️ for the Obsidian + Claude community**
