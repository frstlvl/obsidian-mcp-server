# Semantic Search Feature

## Overview

Semantic search enables Claude to find notes based on **meaning and context**, not just keyword matching. It uses AI embeddings (vector representations) to discover conceptually related content, even when exact words don't match.

### Traditional Keyword vs. Semantic Search

**Keyword Search:**

```text
Query: "authentication methods"
Finds: Notes containing "authentication" AND "methods"
Misses: Notes about "SSO", "OAuth", "MFA" (related concepts, different words)
```

**Semantic Search:**

```text
Query: "authentication methods"
Finds:
  - Notes about "OAuth and SAML configuration" (0.89 similarity)
  - "Multi-factor authentication setup" (0.85)
  - "Single sign-on best practices" (0.82)
  - "Identity provider integration" (0.78)
→ Understands these are ALL about authentication concepts
```

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
  - **Parameters**: 22M
  - **Speed**: ~50ms per note on modern CPU
  - **Quality**: Excellent for document similarity
  - **Privacy**: Runs locally, no API calls
- `Xenova/all-mpnet-base-v2` - Higher quality, 768 dimensions
- `Xenova/paraphrase-multilingual-MiniLM-L12-v2` - Multilingual support

**Anthropic Models** (future support):
- Currently placeholder - Anthropic doesn't have a dedicated embeddings API yet

### Technical Implementation

**Embedding Generation** (from `src/embeddings.ts`):

```typescript
import { pipeline } from '@xenova/transformers';

// Load model once at startup
const embedder = await pipeline(
  'feature-extraction',
  'Xenova/all-MiniLM-L6-v2'
);

// Generate embedding (runs on your CPU/GPU)
async generateEmbedding(text: string): Promise<number[]> {
  const output = await embedder(text, {
    pooling: 'mean',
    normalize: true
  });
  return Array.from(output.data);  // [0.123, -0.456, 0.789, ...]
}
```

**Search Process**:

```typescript
// 1. Convert query to vector
const queryEmbedding = await generateEmbedding(query);

// 2. Find similar vectors (cosine similarity)
const results = await vectorStore.query({
  vector: queryEmbedding,
  topK: 10,
  minScore: 0.7  // 70% similarity threshold
});

// 3. Return ranked results
return results.map(r => ({
  path: r.metadata.path,
  title: r.metadata.title,
  similarity: r.score,  // 0.0 to 1.0
  excerpt: extractExcerpt(r.metadata.content)
}));
```

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

### Architecture Overview

```mermaid
graph TD
    A[Obsidian Vault] -->|File Watcher| B[Index Manager]
    B -->|Note Added/Changed| C[Embedding Generator]
    C -->|384-dim Vector| D[Vectra Vector Store]
    E[Claude Query] -->|Semantic Search Tool| F[Query Embeddings]
    F -->|Vector Similarity| D
    D -->|Top K Results| G[Claude Response]
    
    style C fill:#e1f5ff
    style D fill:#fff4e1
    style F fill:#e1f5ff
```

### 1. Indexing Phase

When the server starts (if `autoIndex: true`):

1. Scans all markdown files in your vault
2. For each note:
   - Reads title, frontmatter, and content
   - Generates embedding vector (384-768 dimensions)
   - Stores in Vectra with metadata
3. Tracks modification times to skip unchanged notes on re-index

**Storage Location**: `.mcp-vector-store/` in your vault directory (automatically created)

### 2. Search Phase

When Claude performs a semantic search:

1. Generates embedding for the query
2. Performs cosine similarity search in Vectra
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

**Implementation** (from `src/index.ts`):

```typescript
// File watcher monitors vault directory
const watcher = chokidar.watch(vaultPath, {
  ignored: [/(^|[\/\\])\../, /node_modules/, /.obsidian/, /_data/],
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1000 }
});

// When you edit a note in Obsidian
watcher.on('change', async (filePath) => {
  // Debounce rapid edits (2 second delay)
  clearTimeout(updateQueue.get(filePath));
  updateQueue.set(filePath, setTimeout(async () => {
    // Re-generate embedding for changed note
    const embedding = await generateEmbedding(updatedContent);
    
    // Update vector store
    await vectorStore.upsert({ id: filePath, vector: embedding });
    
    console.log(`[Vector] Re-indexed: ${filePath}`);
  }, 2000));
});
```

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

## Real-World Usage Examples

### Example 1: Conceptual Discovery

```text
You: "What have I written about machine learning deployment?"

Claude:
1. Uses obsidian_semantic_search("machine learning deployment")
2. Finds:
   - "MLOps Pipeline Architecture" (0.89 similarity)
   - "Docker Containers for Model Serving" (0.85)
   - "Kubernetes for ML Workloads" (0.82)
   - "CI/CD for Data Science" (0.78)
3. Returns excerpts from each note
4. Summarizes common themes

→ No exact "machine learning deployment" phrase needed
→ Understands related concepts automatically
```

### Example 2: Cross-Domain Connections

```text
You: "Notes exploring consciousness and AI"

Claude:
1. Semantic search finds:
   - Philosophy notes about "qualia and subjective experience"
   - Tech notes about "neural networks and emergent behavior"
   - Psychology notes about "cognition and awareness"
2. Connects ideas across different vault folders
3. Identifies unexpected relationships

→ Discovers connections you might have forgotten
→ No manual tagging required
```

### Example 3: Automatic Note Linking

```text
You: "Create a note about GraphQL API design and suggest related notes"

Claude:
1. Creates new note
2. Runs semantic search on new content
3. Finds related notes:
   - "REST API Best Practices" (similar patterns)
   - "TypeScript Type Generation" (GraphQL codegen)
   - "Apollo Server Configuration" (implementation)
4. Suggests wikilinks: [[REST API Best Practices]], [[Apollo Server]]

→ Automatic knowledge graph building
→ Maintains vault interconnectedness
```

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

## Benefits for Obsidian + Claude Integration

**Semantic Search transforms the MCP from a file browser into an intelligent knowledge assistant:**

### Problem Solved: Token Limitations

**Before Semantic Search:**

```text
User: "Find notes about cloud security best practices"

Claude calls: obsidian_search_vault(query="cloud security best practices")
→ Keyword matching only
→ Misses: "AWS IAM policies", "Azure Defender", "GCP security hardening"
→ Limited to exact phrase matches
```

**After Semantic Search:**

```text
User: "Find notes about cloud security best practices"

Claude calls: obsidian_semantic_search(query="cloud security best practices")
→ Understands: "cloud" = AWS/Azure/GCP, "security" = IAM/defender/hardening
→ Finds conceptually related notes
→ Returns top 10 most relevant (sorted by similarity)
→ No need to upload entire vault to Claude context
```

### Key Benefits

| Feature                 | Before                         | After                     |
| ----------------------- | ------------------------------ | ------------------------- |
| **Search Method**       | Keyword matching               | Meaning understanding     |
| **Recall**              | Exact matches only             | Conceptually related      |
| **Claude Integration**  | Manual keyword crafting        | Natural language queries  |
| **Vault Size Limit**    | None (but slow keyword search) | None (fast vector search) |
| **Knowledge Discovery** | Limited to tags/links          | Automatic connections     |
| **Real-time Updates**   | Manual restart                 | Automatic re-indexing     |

**Summary:**
1. ✅ **Token-efficient** - No need to upload vault to Claude context
2. ✅ **Intelligent** - Understands concepts, not just words
3. ✅ **Automatic** - File watcher keeps index synchronized
4. ✅ **Privacy-first** - Local embeddings, no external API calls
5. ✅ **Fast** - Sub-second search across thousands of notes
6. ✅ **Scalable** - Works with vaults of any size

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

## Privacy & Security

### Local Processing

- **Embeddings**: Generated locally using Transformers.js
- **No API calls**: All processing happens on your machine
- **No data leaves**: Vectors stored locally in `.mcp-vector-store/`

### Data Storage

- **Location**: `.mcp-vector-store/` in vault directory
- **Contents**: Vectra index files + metadata (title, path, tags, timestamps)
- **Note content**: First 1000 chars stored for excerpts only

### Vector Store Location

**Storage Location**: `.mcp-vector-store/` in your vault directory (automatically created)

**Files created:**
- `index.json` - Vector embeddings for all notes (size depends on vault size)
- `index-metadata.json` - Index metadata and timestamps

**If you version control your Obsidian vault:**

Two approaches:

1. **Commit embeddings (recommended)** - Faster setup on new machines, instant semantic search
2. **Gitignore embeddings** - Smaller repo size, requires re-indexing (~2-5 min) after cloning

To gitignore:

```gitignore
.mcp-vector-store/
```

**Most users don't version control their vaults** and can ignore this entirely.

## Future Enhancements

**Planned:**
- [ ] Manual re-index MCP tool - Force full vault re-index via tool call (useful when switching models or troubleshooting)

**Considering:**
- [ ] Cross-vault semantic search - Search multiple Obsidian vaults simultaneously
- [ ] Higher-quality models - Support for larger embedding models (e.g., `all-mpnet-base-v2` with 768 dimensions)

**Not Planned:**
- OpenAI/Anthropic embeddings APIs - Current local embeddings are excellent, no need for paid APIs with privacy trade-offs
- Export/import embeddings - Already solved if you commit `.mcp-vector-store/` to git (recommended approach)

## API Reference

### VectorStore Class

```typescript
class VectorStore {
  constructor(vaultPath: string, config: EmbeddingConfig);

  // Initialize vector store and Vectra index
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

### Transformers.js (Local) - Current Implementation

- **Cost**: $0 (runs on your machine)
- **Speed**: Moderate (depends on hardware, ~50ms per note)
- **Privacy**: Excellent (fully local, no API calls)
- **Quality**: Excellent for document similarity (384 dimensions)
- **Maintenance**: Zero - no API keys, rate limits, or usage costs

## Best Practices

1. **Enable autoIndex** for initial setup (automatic re-indexing handles updates thereafter)
2. **Use hybrid mode** for searches requiring exact keyword matches
3. **Adjust min_score** based on your needs (start at 0.5, increase for higher precision)
4. **Exclude large files** in `excludePatterns` (images, PDFs, archives)
5. **Commit embeddings to git** if you version control your vault (instant setup on new machines)
6. **Monitor storage** in `.mcp-vector-store/` (typically 2-4 KB per note)

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
