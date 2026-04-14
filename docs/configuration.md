# Configuration Guide

## Overview

The Obsidian MCP Server uses a JSON configuration file to define vaults and behavior:

1. **Config File** (`config.json`) - Defines vaults, features, and behavior
2. **Environment Variable** (`OBSIDIAN_CONFIG_PATH`) - Points to config file location (optional)

## Quick Start

### 1. Create config.json

Create `config.json` in the repo root with your vault(s):

```json
{
  "vaults": [
    {
      "name": "work",
      "path": "C:\\Users\\YourName\\Documents\\WorkVault",
      "enableWrite": true
    },
    {
      "name": "personal",
      "path": "C:\\Users\\YourName\\Documents\\PersonalVault",
      "enableWrite": false
    }
  ],
  "vectorSearch": {
    "enabled": true,
    "provider": "transformers",
    "model": "Xenova/bge-small-en-v1.5",
    "indexOnStartup": "auto"
  },
  "searchOptions": {
    "maxResults": 20,
    "excerptLength": 200
  },
  "logging": {
    "level": "info",
    "file": "logs/mcp-server.log"
  }
}
```

Each vault entry requires a unique `name` (used in tool parameters) and a `path` to the Obsidian vault directory.

### 2. Configure Claude Desktop

**Windows:**

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": [
        "--expose-gc",
        "--max-old-space-size=16384",
        "D:\\repos\\obsidian-mcp-server\\dist\\index.js"
      ],
      "env": {
        "OBSIDIAN_CONFIG_PATH": "D:\\repos\\obsidian-mcp-server\\config.json"
      }
    }
  }
}
```

**macOS:**

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": [
        "--expose-gc",
        "--max-old-space-size=16384",
        "/Users/YourName/obsidian-mcp-server/dist/index.js"
      ],
      "env": {
        "OBSIDIAN_CONFIG_PATH": "/Users/YourName/obsidian-mcp-server/config.json"
      }
    }
  }
}
```

> **Legacy Note:** The `OBSIDIAN_VAULT_PATH` environment variable is still supported for backward compatibility. If present and no `vaults` array is defined, it is auto-migrated to a single vault entry at startup. New installations should use `config.json` with a `vaults` array.

## Configuration Reference

### Vaults

**`vaults`** (array of objects, required)

Each vault object defines an Obsidian vault the server can access:

| Field             | Type     | Required | Description                                        |
| ----------------- | -------- | -------- | -------------------------------------------------- |
| `name`            | string   | Yes      | Unique identifier used in tool `vault` parameter   |
| `path`            | string   | Yes      | Absolute path to the Obsidian vault directory      |
| `enableWrite`     | boolean  | No       | Override server-level `enableWrite` for this vault |
| `includePatterns` | string[] | No       | Override server-level include patterns             |
| `excludePatterns` | string[] | No       | Override server-level exclude patterns             |
| `vectorSearch`    | object   | No       | Override server-level vector search config         |

Per-vault settings inherit from server-level defaults when not specified.

**Example with per-vault overrides:**

```json
{
  "vaults": [
    {
      "name": "engineering",
      "path": "/Users/me/Vaults/Engineering",
      "enableWrite": true,
      "vectorSearch": {
        "enabled": true,
        "model": "Xenova/bge-base-en-v1.5"
      }
    },
    {
      "name": "knowledge-base",
      "path": "/Users/me/Vaults/KB",
      "enableWrite": false,
      "excludePatterns": [".obsidian/**", "_drafts/**"]
    }
  ],
  "enableWrite": false,
  "vectorSearch": {
    "enabled": true,
    "provider": "transformers",
    "model": "Xenova/bge-small-en-v1.5"
  }
}
```

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

The embedding model that converts your notes into numerical vectors for semantic search.

**Default**: `"Xenova/bge-small-en-v1.5"` (384 dimensions)

**Available Models**:

| Model                                          | Dimensions | Speed          | Quality   | Best For                                 |
| ---------------------------------------------- | ---------- | -------------- | --------- | ---------------------------------------- |
| `Xenova/bge-small-en-v1.5`                     | 384        | Fast (60ms)    | Excellent | **Default**, best quality/resource ratio |
| `Xenova/all-MiniLM-L6-v2`                      | 384        | Fast (50ms)    | Good      | Lightweight alternative                  |
| `Xenova/all-mpnet-base-v2`                     | 768        | Medium (150ms) | Very Good | Higher quality, 2x storage               |
| `Xenova/bge-base-en-v1.5`                      | 768        | Medium (150ms) | Excellent | State-of-the-art English                 |
| `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | 384        | Slow (100ms)   | Good      | Multilingual vaults                      |

**Choosing a Model**:

- **Default users**: Use `bge-small-en-v1.5` (excellent quality, efficient for multi-vault setups)
- **High-end CPU (Ryzen 9, i9, M3+)**: Use `Xenova/bge-base-en-v1.5` for best quality
- **Multilingual vaults**: Use `paraphrase-multilingual-MiniLM-L12-v2`
- **Limited storage**: Stick with 384-dim models (smaller index size)

**⚠️ Important**: Changing models requires deleting `.mcp-vector-store/` and re-indexing entire vault

**Performance Impact** (5,000 note vault):

| Model          | Initial Index Time | Storage Size | Re-index Single Note |
| -------------- | ------------------ | ------------ | -------------------- |
| 384-dim models | 4-6 minutes        | ~20 MB       | 50-100ms             |
| 768-dim models | 12-15 minutes      | ~40 MB       | 150-200ms            |

**`vectorSearch.indexOnStartup`** (string | boolean)

Controls when the vault should be indexed on server startup.

**Default**: `"auto"` (smart detection)

**Options**:

| Value             | Behavior        | Use Case                                              |
| ----------------- | --------------- | ----------------------------------------------------- |
| `"auto"`          | Smart detection | **Recommended**: Automatically re-indexes when needed |
| `"always"` / true | Always re-index | Debugging, testing, forcing fresh index               |
| `"never"` / false | Never re-index  | CI/CD with pre-built index, manual control            |

**"auto" Mode Logic** (recommended for all users):

1. ✅ **No index exists** → Indexes vault (first-time setup)
2. ✅ **Model changed** → Re-indexes with new model
3. ✅ **Index corrupted** → Rebuilds index
4. ✅ **Index valid** → Skips indexing (fast startup)

**Benefits of "auto" mode**:

- Zero manual configuration when changing models
- Automatic recovery from corrupted indexes
- Fast startups when index is valid
- "Just works" experience

**Note**: File watcher maintains the index automatically after initial build, regardless of this setting.

### Search Options

Controls default behavior for `obsidian_search_vault` tool (keyword search).

**`searchOptions.maxResults`** (number)

Maximum number of search results to return per query.

- **Default**: `20`
- **Range**: 1-100
- **Recommended**:
  - `10-20` for conversational use (Claude processes results efficiently)
  - `50-100` for comprehensive searches (may hit token limits)
- **Note**: Users can override this per-query with `limit` parameter

**`searchOptions.excerptLength`** (number)

Length of content excerpts shown in search results (in characters).

- **Default**: `200` characters
- **Range**: 50-1000 (practical limits)
- **Affects**:
  - Response token count (longer excerpts = more tokens)
  - Context quality (longer = more context, but more overwhelming)
- **Recommended**:
  - `100-150` for quick scanning
  - `200-300` for detailed context
  - `500+` for comprehensive previews

**`searchOptions.caseSensitive`** (boolean)

Whether keyword search should be case-sensitive.

- **Default**: `false` (case-insensitive)
- **When to enable**:
  - Technical vaults with case-sensitive terms (e.g., `TCP` vs `tcp`)
  - Code documentation with specific capitalization
  - Legal/academic documents requiring exact matches
- **Note**: Semantic search is always case-insensitive regardless of this setting

**`searchOptions.includeMetadata`** (boolean)

Whether to include YAML frontmatter fields in search results.

- **Default**: `true`
- **Includes**: title, tags, aliases, dates, custom fields
- **Benefits**:
  - Claude can filter by tags/dates
  - Provides richer context for note identification
  - Enables metadata-based follow-up queries
- **Disable if**: Privacy concerns about exposing all frontmatter fields

**Example Configuration**:

```json
{
  "searchOptions": {
    "maxResults": 30,
    "excerptLength": 250,
    "caseSensitive": false,
    "includeMetadata": true
  }
}
```

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
  "vaults": [
    {
      "name": "my-vault",
      "path": "/path/to/vault"
    }
  ],
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
  "vaults": [
    {
      "name": "my-vault",
      "path": "/path/to/vault",
      "enableWrite": true
    }
  ],
  "vectorSearch": {
    "enabled": true,
    "provider": "transformers",
    "indexOnStartup": "auto"
  }
}
```

**Use when**: Production setup with all features (recommended).

### Scenario 3: Multi-Vault with Mixed Permissions

```json
{
  "vaults": [
    {
      "name": "work",
      "path": "/path/to/work-vault",
      "enableWrite": true,
      "vectorSearch": {
        "enabled": true,
        "model": "Xenova/bge-base-en-v1.5"
      }
    },
    {
      "name": "reference",
      "path": "/path/to/reference-vault",
      "enableWrite": false
    }
  ],
  "vectorSearch": {
    "enabled": true,
    "provider": "transformers",
    "model": "Xenova/bge-small-en-v1.5",
    "indexOnStartup": "auto"
  }
}
```

**Use when**: Multiple vaults with different access levels. The `work` vault uses a higher-quality model, while `reference` inherits the server default.

### Scenario 4: Force Re-Indexing

}
}

````markdown
**Use when**: Production setup with all features (recommended).

### Scenario 5: Force Re-Indexing

```json
{
  "vectorSearch": {
    "enabled": true,
    "indexOnStartup": "always"
  }
}
```
````

**Use when**: Debugging, testing, or forcing a fresh index build.

### Scenario 6: Testing/Development

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
2. **Use Descriptive Vault Names**: Choose short, meaningful names (e.g., `work`, `personal`, `reference`) — they appear in tool parameters and results
3. **Start Simple**: Begin with read-only, enable features as needed
4. **Per-Vault Write Control**: Keep most vaults read-only, enable writes only where needed
5. **Startup Indexing**: Use `indexOnStartup: "auto"` for best experience (default)
6. **Memory Planning**: Each vault loads its own vector index (~150-300MB RAM per vault depending on model and vault size)
7. **Backup First**: Backup vault before enabling write operations
8. **Monitor Logs**: Check `logs/mcp-server.log` for vault initialization and indexing status
9. **Version Control**: Keep `config.example.json` in git, exclude `config.json`
10. **Platform Paths**:
    - Windows: Use double backslashes `\\` in JSON config files
    - macOS/Linux: Use forward slashes `/` (no escaping needed)

## Example Configurations

See `config.example.json` for complete example.

For Claude Desktop integration, see `README.md` configuration section.
