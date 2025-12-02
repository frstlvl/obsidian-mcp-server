# Indexing Workflow Guide

## Overview

This guide explains the recommended workflow for indexing your Obsidian vault with the MCP server. Based on testing with large vaults (5,000+ notes), we've identified the most reliable approach for different scenarios.

## Quick Reference

| Scenario                | Method             | When to Use                           |
| ----------------------- | ------------------ | ------------------------------------- |
| **First-time setup**    | Standalone Node.js | Before first Claude Desktop use       |
| **Model changes**       | Standalone Node.js | Switching embedding models            |
| **Full re-index**       | Standalone Node.js | After deleting vector store           |
| **Incremental updates** | Claude Desktop     | ✅ Validated - automatic file watcher |

## Standalone Indexing (Recommended for Large Vaults)

### When to Use Standalone Indexing

Run standalone indexing for these scenarios:

1. **Initial vault setup** - First time using the MCP server
2. **Model changes** - Switching between embedding models (e.g., `all-MiniLM-L6-v2` → `bge-base-en-v1.5`)
3. **Full re-index** - After deleting the `.mcp-vector-store` folder
4. **Large vaults** - Vaults with 1,000+ notes

### Why Standalone Works Better

Testing with 5,463 notes revealed:

- **Success rate**: 88.3% (4,821 notes indexed)
- **Reliability**: No process lifecycle interference
- **Memory management**: Better handling of large batch operations
- **Progress visibility**: Clear console output and logs
- **Resume capability**: Checkpoint system saves progress every 50 notes

### Standalone Indexing Procedure

#### Windows (PowerShell)

```powershell
# 1. Navigate to project directory
cd D:\repos\obsidian-mcp-server

# 2. Set environment variables
$env:OBSIDIAN_VAULT_PATH = "X:\Path\To\Your\Vault"
$env:OBSIDIAN_CONFIG_PATH = "D:\repos\obsidian-mcp-server\config.json"

# 3. Run with increased memory allocation
node --expose-gc --max-old-space-size=16384 dist\index.js

# Expected output:
# [INFO] Vector store initialized
# [INFO] Starting full vault indexing...
# [INFO] Indexed 50/5463 notes (0 failed, 0 skipped)
# [INFO] Indexed 100/5463 notes (0 failed, 0 skipped)
# [INFO] Pipeline refreshed at 500 notes
# ...
# [INFO] Indexing completed: indexed=5421, skipped=0, failed=42
```

#### macOS/Linux (Bash)

```bash
# 1. Navigate to project directory
cd ~/obsidian-mcp-server

# 2. Set environment variables
export OBSIDIAN_VAULT_PATH="/Users/YourName/Documents/ObsidianVault"
export OBSIDIAN_CONFIG_PATH="$HOME/obsidian-mcp-server/config.json"

# 3. Run with increased memory allocation
node --expose-gc --max-old-space-size=16384 dist/index.js
```

### What Happens During Indexing

**v1.4.0 Parallel Batch Processing Architecture**:

1. **Initialization** - Loads configuration and initializes vector store
2. **Batch processing** - Notes processed in parallel batches of 10:
   - Concurrent embedding generation with Promise.all
   - Sequential insertion into Vectra (maintains data integrity)
   - Each batch completes in ~2-3 seconds (vs ~20-30 seconds sequential)
3. **Transaction management** - Vectra beginUpdate/endUpdate wrapping:
   - Single transaction opened at start
   - Flushed to disk every 50 notes (checkpoint)
   - Ensures progress is persisted even on interruption
4. **Progress updates** - Console output every 50 notes with batch statistics
5. **Checkpoints** - Progress saved to disk every 50 notes (allows resume):
   - endUpdate() forces write to disk
   - Metadata updated with last indexed timestamp
   - New transaction started for next batch
6. **Pipeline refresh** - Memory cleanup every 500 notes:
   - Transformer pipeline reloaded
   - Explicit garbage collection (with --expose-gc flag)
   - Prevents memory leaks during large indexing operations
7. **Error handling** - Failed notes are logged and skipped (batch continues)
8. **Completion** - Final endUpdate() and statistics summary

**Performance Benefits**:

- 🚀 **10x faster**: Parallel embedding generation via Promise.all
- 💾 **Reliable**: Transaction management prevents data loss
- 🔧 **Memory efficient**: Pipeline refresh and GC prevent memory bloat
- 📊 **Validated**: Successfully indexed 5,681 notes in 5.5 minutes

### Performance Expectations

| Vault Size   | Model            | Duration  | Memory Usage | Notes                     |
| ------------ | ---------------- | --------- | ------------ | ------------------------- |
| 1,000 notes  | all-MiniLM-L6-v2 | 1-2 min   | 400-600 MB   | Parallel batch processing |
| 5,000 notes  | all-MiniLM-L6-v2 | 5-6 min   | 500-800 MB   | ~65x faster than v1.3     |
| 5,000 notes  | bge-base-en-v1.5 | 8-12 min  | 700-1000 MB  | 10 concurrent embeddings  |
| 10,000 notes | bge-base-en-v1.5 | 15-25 min | 1-2 GB       | Checkpoint every 50 notes |

_Note: Times measured with parallel batch processing (10 concurrent embeddings). Performance varies based on CPU cores and note complexity._

**v1.4.0 Performance Improvements:**

- ⚡ **10x faster indexing** via parallel Promise.all batch processing
- 🔄 **11x CPU efficiency** - ~60 CPU minutes in 5.5 wall-clock minutes for 5,681 notes
- 💾 **Checkpoint system** - Progress saved every 50 notes with proper Vectra transaction management
- 🚀 **Tested**: 5,681 notes indexed in 5 minutes 38 seconds (down from 6+ hours in v1.3)

## Claude Desktop Integration

### Configuration

After successful standalone indexing, configure Claude Desktop to use the MCP server.

#### Important: Disable Auto-Indexing

In your `config.json`, set:

```json
{
  "vectorSearch": {
    "indexOnStartup": false
  }
}
```

This prevents automatic re-indexing when Claude Desktop starts, since you've already completed indexing standalone.

### Incremental Updates

**Status: ✅ VALIDATED - Production Ready**

The MCP server includes a file system watcher that handles incremental updates automatically. This has been fully tested and validated with the following results:

- **Add note**: ✅ Automatically indexes new `.md` files (~2 seconds)
- **Edit note**: ✅ Re-indexes modified files (2-second debounce for stability)
- **Delete note**: ✅ Removes entries from vector store

**Validation Testing (Oct 23, 2025)**:

- Created test note with unique token → Found immediately (score: 1.0)
- Modified note with new token → Updated content found (score: 1.0)
- Deleted note → Completely removed from index (no results)

The file watcher is reliable for day-to-day vault maintenance. You only need standalone indexing for initial setup or model changes

## Model Switching Workflow

When switching between embedding models:

### 1. Update Configuration

Edit `config.json`:

```json
{
  "vectorSearch": {
    "model": "Xenova/bge-base-en-v1.5", // Changed from all-MiniLM-L6-v2
    "indexOnStartup": false
  }
}
```

### 2. Clean Vector Store

```powershell
# Windows
Remove-Item "X:\Path\To\Vault\.mcp-vector-store\*" -Recurse -Force

# macOS/Linux
rm -rf "/path/to/vault/.mcp-vector-store/"*
```

**Why clean?** Different models produce different embedding dimensions:

- `all-MiniLM-L6-v2`: 384 dimensions
- `bge-base-en-v1.5`: 768 dimensions
- Incompatible embeddings will cause errors

### 3. Re-run Standalone Indexing

Use the standalone procedure above with your new model configuration.

### 4. Resume Claude Desktop Usage

Once indexing completes, Claude Desktop will use the new embeddings.

## Troubleshooting

### Failed Notes

Some notes may fail to index due to:

1. **YAML frontmatter errors** - Malformed YAML syntax
2. **Special characters** - Unusual Unicode or control characters
3. **File access issues** - Locked files or permission problems

Failed notes are logged to `logs/mcp-server.log`. They can be manually fixed and re-indexed.

### Memory Issues

If indexing crashes with out-of-memory errors:

```powershell
# Increase heap size (example: 24GB)
node --expose-gc --max-old-space-size=24576 dist\index.js
```

### Slow Performance

If indexing is too slow:

1. **Use smaller model**: Switch from `bge-base-en-v1.5` to `all-MiniLM-L6-v2`
2. **Reduce vault size**: Exclude folders with `excludePatterns` in config
3. **Check CPU usage**: Close other applications during indexing

## Best Practices

### ✅ Do

- Run standalone indexing for initial setup
- Use checkpoint system (built-in, automatic)
- Monitor logs during indexing
- Test search quality after completion
- Document your model choice

### ❌ Don't

- Don't mix embedding dimensions (clean vector store when switching models)
- Don't interrupt indexing (use Ctrl+C gracefully, checkpoints allow resume)
- Don't enable `indexOnStartup: true` for large vaults in Claude Desktop
- Don't delete `.mcp-vector-store` without being prepared to re-index

## Summary

**Recommended workflow:**

1. **Initial setup**: Run standalone indexing before first Claude Desktop use
2. **Configuration**: Set `indexOnStartup: false` in config
3. **Daily usage**: Use Claude Desktop normally (incremental updates should work)
4. **Model changes**: Clean vector store and re-run standalone indexing
5. **Troubleshooting**: Check logs at `logs/mcp-server.log`

For questions or issues, see the main [README.md](../README.md) or [Configuration Guide](configuration.md).
