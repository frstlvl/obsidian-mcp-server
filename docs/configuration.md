# Configuration Guide

## Overview

The Obsidian MCP Server uses two configuration sources:

1. **Environment Variable** (`OBSIDIAN_VAULT_PATH`) - Controls vault location
2. **Config File** (`config.json`) - Controls features and behavior

## Quick Start

### 1. Set Vault Path (Required)

The vault path MUST be set via environment variable:

**Windows (PowerShell):**

```powershell
$env:OBSIDIAN_VAULT_PATH = "/path/to/your/vault"
```

**macOS/Linux (Bash):**

```bash
export OBSIDIAN_VAULT_PATH="/path/to/your/vault"
```

**Claude Desktop (Windows):**

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["C:\\path\\to\\obsidian-mcp-server\\dist\\index.js"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "C:\\Users\\YourName\\Documents\\ObsidianVault"
      }
    }
  }
}
```

**Claude Desktop (macOS):**

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/Users/YourName/obsidian-mcp-server/dist/index.js"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/Users/YourName/Documents/ObsidianVault"
      }
    }
  }
}
```

### 2. Create config.json (Optional)

If you want to customize behavior, create `config.json` in the repo root:

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

## Configuration Reference

### File Patterns

**`includePatterns`** (array of strings)
- Glob patterns for files to index
- Default: `["**/*.md"]`
- Example: `["**/*.md", "**/*.markdown"]`

**`excludePatterns`** (array of strings)
- Glob patterns for files to exclude
- Default: `[".obsidian/**", ".trash/**", "node_modules/**"]`
- Commonly excluded:
  - `.obsidian/**` - Obsidian config
  - `.trash/**` - Deleted files
  - `_archive/**` - Archived content
  - `.git/**` - Git repository
  - `node_modules/**` - NPM packages

### Write Operations

**`enableWrite`** (boolean)
- Enable create, update, and delete operations
- Default: `false` (read-only mode)
- Set to `true` to enable:
  - `obsidian_create_note`
  - `obsidian_update_note`
  - `obsidian_delete_note`

**Security Note**: Write operations have path validation and safety checks, but enable only if needed.

### Vector Search

**`vectorSearch.enabled`** (boolean)
- Enable semantic search with embeddings
- Default: `false`
- Requires: Transformers.js and Vectra dependencies (auto-installed)

**`vectorSearch.provider`** (string)
- Embedding provider to use
- Options: `"transformers"` (only option currently)
- Default: `"transformers"`

**`vectorSearch.model`** (string)
- Embedding model name
- Default: `"Xenova/all-MiniLM-L6-v2"` (384 dimensions)
- Other options: Any Transformers.js compatible model

**`vectorSearch.autoIndex`** (boolean)
- Automatically index vault on startup
- Default: `false` (recommended for fast startup)
- Set to `true` for first-time indexing
- Subsequent starts use existing index (incremental updates)

**Performance Note**: Auto-indexing a large vault (5,000+ notes) takes several minutes. Disable for production use.

### Search Options

**`searchOptions.maxResults`** (number)
- Maximum search results to return
- Default: `20`
- Range: 1-100

**`searchOptions.excerptLength`** (number)
- Length of content excerpts in results
- Default: `200` characters
- Affects response size

**`searchOptions.caseSensitive`** (boolean)
- Case-sensitive keyword search
- Default: `false`
- Note: Semantic search is always case-insensitive

**`searchOptions.includeMetadata`** (boolean)
- Include frontmatter in search results
- Default: `true`
- Provides title, tags, dates, etc.

### Logging

**`logging.level`** (string)
- Log verbosity level
- Options: `"error"`, `"warn"`, `"info"`, `"debug"`
- Default: `"info"`

**`logging.file`** (string)
- Log file path (relative to repo root)
- Default: `"logs/mcp-server.log"`
- Creates directory if not exists

## Configuration Scenarios

### Scenario 1: Read-Only Access (Safe Default)

```json
{
  "enableWrite": false,
  "vectorSearch": {
    "enabled": false
  }
}
```

**Use when**: Just browsing vault with keyword search.

### Scenario 2: Full Features Enabled

```json
{
  "enableWrite": true,
  "vectorSearch": {
    "enabled": true,
    "provider": "transformers",
    "autoIndex": false
  }
}
```

**Use when**: Production setup with all features.

### Scenario 3: Initial Indexing

```json
{
  "vectorSearch": {
    "enabled": true,
    "autoIndex": true
  }
}
```

**Use when**: First time setting up vector search. After indexing completes, set `autoIndex: false`.

### Scenario 4: Testing/Development

```json
{
  "includePatterns": ["Test/**/*.md"],
  "enableWrite": true,
  "vectorSearch": {
    "enabled": true
  },
  "logging": {
    "level": "debug"
  }
}
```

**Use when**: Testing with a subset of vault and verbose logging.

## Troubleshooting

### Config Not Loading

**Problem**: Server logs show "Could not load config file, using defaults"

**Solution**: Ensure `config.json` is in the repo root:

```powershell
# Windows
Test-Path /path/to/obsidian-mcp-server/config.json
```

```bash
# macOS/Linux
ls ~/obsidian-mcp-server/config.json
```

**Cause**: Config loading uses script directory (`dist/` → `../config.json`)

### Vector Search Not Available

**Problem**: Claude doesn't see `obsidian_semantic_search` tool

**Checklist**:
1. ✅ `vectorSearch.enabled: true` in config.json
2. ✅ Config file loading successfully (check logs)
3. ✅ No errors during server startup
4. ✅ Claude Desktop restarted after config change

**Verify**: Server logs should show:

```text
[MCP] Initializing vector search...
[MCP] Semantic search tool registered successfully
```

### Write Operations Not Working

**Problem**: Claude can't create/update notes

**Checklist**:
1. ✅ `enableWrite: true` in config.json
2. ✅ Vault path has write permissions
3. ✅ Config file loading successfully

**Verify**: Server logs should show:

```text
[MCP] Write operations: ENABLED
```

### Path Issues

**Problem**: Vault path not found or access denied

**Solution**: Verify path exists and use correct format:
- **Windows**: Use forward slashes or double backslashes in JSON
  - Example: `C:\\Users\\YourName\\Documents\\MyVault`
  - Claude Desktop config: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: Use absolute paths starting with `/Users/`
  - Example: `/Users/YourName/Documents/ObsidianVault`
  - Claude Desktop config: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: Use absolute paths starting with `/home/`
  - Example: `/home/username/Documents/ObsidianVault`
  - Claude Desktop config: `~/.config/Claude/claude_desktop_config.json`

**Test**:

```powershell
# Windows
Test-Path "C:\Users\YourName\Documents\MyVault"
```

```bash
# macOS
ls -la ~/Documents/ObsidianVault

# Linux
ls -la ~/Documents/ObsidianVault
```

## Best Practices

1. **Separate Config from Code**: Never commit `config.json` with personal paths (use `config.example.json`)
2. **Use Environment Variables**: Always use `OBSIDIAN_VAULT_PATH` env var for vault location
3. **Start Simple**: Begin with read-only, enable features as needed
4. **Index Once**: Use `autoIndex: true` once, then disable for fast startup
5. **Backup First**: Backup vault before enabling write operations
6. **Monitor Logs**: Check `logs/mcp-server.log` for issues
7. **Version Control**: Keep `config.example.json` in git, exclude `config.json`
8. **Platform Paths**:
   - Windows: Use double backslashes `\\` in JSON config files
   - macOS/Linux: Use forward slashes `/` (no escaping needed)

## Example Configurations

See `config.example.json` for complete example.

For Claude Desktop integration, see `README.md` configuration section.
