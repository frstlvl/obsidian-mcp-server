# Vector Search (Semantic Search) Feature

## Overview

The Vector Search feature adds **semantic search capabilities** to the Obsidian MCP Server, enabling Claude to find notes based on meaning rather than just keyword matching. This uses embeddings and vector similarity to discover conceptually related notes even when they don't share exact keywords.

## Features

- **Semantic Search**: Find notes by meaning, not just keywords
- **Automatic Index Updates**: Real-time file system watching keeps index synchronized (v1.3.0)
- **Hybrid Search**: Combine semantic similarity with keyword matching for best results
- **Local Embeddings**: Uses Transformers.js for privacy-friendly, API-free embeddings
- **Incremental Indexing**: Only re-index changed notes (tracked by modification time)
- **Configurable**: Enable/disable, choose embedding model, auto-index on startup
- **Vectra Storage**: Lightweight local vector database - no server required

## Installation

The vector search dependencies are already included in `package.json`:

```bash
npm install
```

Key dependencies:
- `vectra` - Lightweight local vector database for Node.js
- `@xenova/transformers` - Local transformer models for embeddings
- `@anthropic-ai/sdk` - (Optional) For future Anthropic embeddings support

## Configuration

Add the `vectorSearch` section to your `config.json`:

```json
{
  "vectorSearch": {
    "enabled": true,
    "provider": "transformers",
    "model": "Xenova/all-MiniLM-L6-v2",
    "autoIndex": true
  },
  "searchOptions": {
    "maxResults": 20,
    "excerptLength": 200
  }
}
```

**Note**: Vault path is set via `OBSIDIAN_VAULT_PATH` environment variable, not in config.json.

### Configuration Options

| Option      | Type    | Default                     | Description                                            |
| ----------- | ------- | --------------------------- | ------------------------------------------------------ |
| `enabled`   | boolean | `false`                     | Enable/disable semantic search                         |
| `provider`  | string  | `"transformers"`            | Embedding provider (`"transformers"` or `"anthropic"`) |
| `model`     | string  | `"Xenova/all-MiniLM-L6-v2"` | Embedding model to use                                 |
| `autoIndex` | boolean | `true`                      | Automatically index vault on server startup            |

### Supported Models

**Transformers.js Models** (local, no API key required):
- `Xenova/all-MiniLM-L6-v2` - Fast, good quality, 384 dimensions (recommended)
- `Xenova/all-mpnet-base-v2` - Higher quality, 768 dimensions
- `Xenova/paraphrase-multilingual-MiniLM-L12-v2` - Multilingual support

**Anthropic Models** (future support):
- Currently placeholder - Anthropic doesn't have a dedicated embeddings API yet

## Usage

### MCP Tool: `obsidian_semantic_search`

Once enabled, Claude can use the `obsidian_semantic_search` tool:

```json
{
  "query": "What are my thoughts on machine learning ethics?",
  "limit": 10,
  "min_score": 0.5,
  "hybrid": false,
  "response_format": "markdown"
}
```

#### Parameters

- **query** (required): Natural language query describing what you're looking for
- **limit** (optional): Maximum results to return (1-50, default: 10)
- **min_score** (optional): Minimum similarity threshold (0-1, default: 0.5)
- **hybrid** (optional): Combine with keyword search (default: false)
- **response_format** (optional): "markdown" or "json" (default: "markdown")

#### Examples

**Pure Semantic Search**:

```text
"Find notes about consciousness and artificial intelligence"
"What did I write about project management best practices?"
"Notes exploring the relationship between creativity and constraints"
```

**Hybrid Search** (semantic + keyword):

```json
{
  "query": "machine learning deployment strategies",
  "hybrid": true,
  "limit": 15
}
```

## How It Works

### 1. Indexing Phase

When the server starts (if `autoIndex: true`):

1. Scans all markdown files in your vault
2. For each note:
   - Reads title, frontmatter, and content
   - Generates embedding vector (384-768 dimensions)
   - Stores in ChromaDB with metadata
3. Tracks modification times to skip unchanged notes on re-index

**Storage Location**: `.mcp-vector-store/` in your vault directory (automatically created)

### 2. Search Phase

When Claude performs a semantic search:

1. Generates embedding for the query
2. Performs cosine similarity search in ChromaDB
3. Returns top N most similar notes with scores
4. (Hybrid mode) Merges with keyword search results (60% semantic, 40% keyword)

### 3. Similarity Scoring

- **Score Range**: 0.0 (unrelated) to 1.0 (identical)
- **Typical Ranges**:
  - `0.7-1.0` - Highly relevant
  - `0.5-0.7` - Moderately relevant
  - `0.3-0.5` - Loosely related
  - `<0.3` - Probably unrelated

## Performance

### First Index (Cold Start)

- **Small vault** (~100 notes): 10-30 seconds
- **Medium vault** (~1,000 notes): 2-5 minutes
- **Large vault** (~5,000 notes): 10-20 minutes

### Automatic Index Updates (v1.3.0)

With file system watching enabled, the index updates automatically:
- **File added**: Indexed within 2-3 seconds after file write completes
- **File modified**: Re-indexed within 2-3 seconds after changes saved
- **File deleted**: Removed from index immediately
- **Debouncing**: Rapid successive edits are batched (2-second delay)
- **No restarts needed**: Index stays synchronized while Claude Desktop runs

### Incremental Updates

After first index, only changed notes are re-indexed:
- **Typical re-index**: < 5 seconds

### Search Speed

- **Query time**: 100-500ms (includes embedding generation + similarity search)
- **Hybrid mode**: +100-200ms (includes keyword search)

## Storage Requirements

### Embeddings Size

With `Xenova/all-MiniLM-L6-v2` (384 dimensions):
- **Per note**: ~2-4 KB (embedding + metadata)
- **1,000 notes**: ~2-4 MB
- **5,000 notes**: ~10-20 MB

Vectra stores vectors efficiently in `.mcp-vector-store/` directory.

## Comparison: Semantic vs. Keyword Search

| Aspect           | Keyword Search | Semantic Search   | Hybrid Search     |
| ---------------- | -------------- | ----------------- | ----------------- |
| **Matching**     | Exact keywords | Meaning/concepts  | Both              |
| **Synonyms**     | ❌ No           | ✅ Yes             | ✅ Yes             |
| **Paraphrasing** | ❌ No           | ✅ Yes             | ✅ Yes             |
| **Exact terms**  | ✅ Excellent    | ⚠️ May miss        | ✅ Excellent       |
| **Conceptual**   | ❌ Poor         | ✅ Excellent       | ✅ Very Good       |
| **Speed**        | ⚡ Very Fast    | ⚠️ Moderate        | ⚠️ Moderate        |
| **Setup**        | None           | Indexing required | Indexing required |

## Troubleshooting

### Vector Store Not Initializing

**Problem**: Server starts but semantic search is unavailable

**Solutions**:
1. Check `config.json` has `vectorSearch.enabled: true`
2. Ensure Vectra is installed: `npm list vectra`
3. Check disk space for vector storage
4. Review server logs for initialization errors

### Indexing Fails

**Problem**: Auto-index errors on startup

**Solutions**:
1. Set `autoIndex: false` and index manually later
2. Check vault path permissions (needs read access)
3. Ensure enough disk space for embeddings
4. Check for corrupted markdown files (skip them in `excludePatterns`)

### Poor Search Results

**Problem**: Semantic search returns irrelevant notes

**Solutions**:
1. Increase `min_score` threshold (try 0.6 or 0.7)
2. Use more descriptive queries (add context)
3. Try `hybrid: true` mode for better accuracy
4. Consider using a higher-quality model (e.g., `all-mpnet-base-v2`)

### Slow Search Performance

**Problem**: Searches take > 1 second

**Solutions**:
1. Reduce `limit` parameter (fewer results = faster)
2. Use a smaller/faster model (`all-MiniLM-L6-v2`)
3. Increase `min_score` to reduce result set
4. Check system resources (CPU/memory)

### Index Not Updating Automatically

**Problem**: New or modified notes don't appear in search results

**Solution**: File system watcher should handle this automatically in v1.3.0+. If issues persist:
1. Check server logs for file watcher errors
2. Verify note is in vault directory (not ignored paths like `.obsidian`, `_data`)
3. Ensure file has `.md` extension
4. Wait 2-3 seconds after saving (debounce delay)
5. If still not working, restart Claude Desktop

## Automatic Index Updates

### How It Works (v1.3.0+)

The server uses `chokidar` to watch your vault for file system changes:

**Monitored Events**:
- **File Added**: New note automatically indexed
- **File Modified**: Existing note re-indexed with new content
- **File Deleted**: Note removed from vector index

**Ignored Paths**:
- Dot files/folders (e.g., `.obsidian`, `.git`)
- `node_modules/`
- `_data/` directory
- Non-markdown files

**Debouncing**: File changes are debounced (2-second delay) to:
- Prevent indexing incomplete saves
- Batch rapid successive edits
- Reduce unnecessary embedding generation

**What You'll See**:

```text
[MCP] Setting up file system watcher for automatic index updates...
[MCP] File system watcher active - index will update automatically
[MCP] File changed: Projects/MyNote.md
[MCP Vector] Indexed note: Projects/MyNote.md
```

### Performance Impact

- **Minimal overhead**: Watcher uses native OS events
- **CPU usage**: Only spikes briefly during re-indexing
- **Memory**: ~1-2 MB for watcher + queue
- **No polling**: Event-driven, not CPU-intensive

## Manual Indexing

To re-index your vault manually:

```typescript

## Privacy & Security

### Local Processing

- **Embeddings**: Generated locally using Transformers.js
- **No API calls**: All processing happens on your machine
- **No data leaves**: Vectors stored locally in `.mcp-vector-store/`

### Data Storage

- **Location**: `.mcp-vector-store/` in vault directory
- **Contents**: Vectra index files + metadata (title, path, tags, timestamps)
- **Note content**: First 1000 chars stored for excerpts only

### Gitignore

Add to your `.gitignore`:

```gitignore
.mcp-vector-store/
*.sqlite3
```

## Future Enhancements

- [ ] Manual re-index MCP tool (on-demand re-indexing without restart)
- [ ] OpenAI embeddings support
- [ ] Anthropic embeddings (when API available)
- [ ] Cross-vault semantic search
- [ ] Customizable embedding dimensions
- [ ] Vector store compression
- [ ] Export/import embeddings

## API Reference

### VectorStore Class

```typescript
class VectorStore {
  constructor(vaultPath: string, config: EmbeddingConfig);

  // Initialize vector store and ChromaDB
  async initialize(): Promise<void>;

  // Index entire vault (or incremental update)
  async indexVault(forceReindex?: boolean): Promise<{
    indexed: number;
    skipped: number;
    failed: number;
  }>;

  // Semantic search
  async search(query: string, options?: VectorSearchOptions): Promise<VectorSearchResult[]>;

  // Hybrid search (semantic + keyword)
  async hybridSearch(
    query: string,
    keywordResults: Array<{path: string; score: number; excerpt: string}>,
    options?: VectorSearchOptions
  ): Promise<VectorSearchResult[]>;

  // Get statistics
  async getStats(): Promise<{
    totalDocuments: number;
    collectionName: string;
    lastIndexed?: number;
  }>;

  // Clear vector store
  async clear(): Promise<void>;
}
```

## Cost Comparison

### Transformers.js (Local)

- **Cost**: $0 (runs on your machine)
- **Speed**: Moderate (depends on hardware)
- **Privacy**: Excellent (fully local)
- **Quality**: Good (384-768 dimensions)

### Anthropic (Future)

- **Cost**: TBD (when API available)
- **Speed**: Fast (API-based)
- **Privacy**: Data sent to Anthropic
- **Quality**: Excellent (enterprise-grade)

## Best Practices

1. **Enable autoIndex** for initial setup
2. **Use hybrid mode** for critical searches
3. **Adjust min_score** based on your needs (start at 0.5)
4. **Exclude large files** in `excludePatterns` (images, PDFs)
5. **Re-index periodically** if you add many notes
6. **Monitor storage** in `.mcp-vector-store/`
7. **Backup embeddings** (though they can be regenerated)

## Examples

### Example 1: Find Related Research Notes

Query: "What research notes do I have about neural networks and deep learning?"

Result: Returns notes about ML, AI, transformers, CNNs, etc. even if they don't mention "neural networks" explicitly.

### Example 2: Discover Connections

Query: "Notes exploring the intersection of philosophy and technology"

Result: Finds notes that discuss both topics, even if they use different terminology.

### Example 3: Hybrid Search for Precision

Query: "Docker container deployment strategies"
Mode: `hybrid: true`

Result: Combines exact matches for "Docker" with semantic understanding of "deployment strategies".

---

**Ready to try semantic search?** Set `vectorSearch.enabled: true` in your config and restart the server! 🚀
