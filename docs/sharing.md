# Sharing Guide

## How to Share This Project

The Obsidian MCP Server is now clean and ready to share with others!

## Quick Share via GitHub

Simply share the repository URL:

```text
https://github.com/frstlvl/obsidian-mcp-server
```

Your friend can:

```bash
git clone https://github.com/frstlvl/obsidian-mcp-server.git
cd obsidian-mcp-server
npm install
npm run build
```

## Share via ZIP Archive

### What's Included

The project is now clean with only essential files:

```text
obsidian-mcp-server/
├── src/                    # Source code
├── docs/                   # Extended documentation
│   ├── configuration.md    # Config guide
│   ├── vector-search.md    # Vector search docs
│   └── sharing.md          # This file
├── .github/                # GitHub workflows
├── .gitignore              # Git exclusions
├── package.json            # Dependencies
├── package-lock.json       # Lock file
├── tsconfig.json           # TypeScript config
├── config.example.json     # Config template
├── README.md               # Main documentation
└── LICENSE                 # MIT License
```

### What's Excluded

All personal/test files have been removed:
- ❌ Personal config files (`config.json`, `config-test.json`)
- ❌ Test configurations
- ❌ Personal vault paths
- ❌ Redundant documentation
- ❌ Build artifacts (`dist/`, `node_modules/`)

### Create ZIP Archive

**Windows PowerShell:**

```powershell
Compress-Archive -Path * -DestinationPath obsidian-mcp-server.zip
```

**macOS/Linux:**

```bash
zip -r obsidian-mcp-server.zip . -x "*.git*" "node_modules/*" "dist/*"
```

## Setup Instructions for Recipients

1. **Extract and Install**

   ```bash
   cd obsidian-mcp-server
   npm install
   npm run build
   ```

2. **Configure Vault Path**

   Set environment variable:

   ```bash
   # Windows
   $env:OBSIDIAN_VAULT_PATH = "C:\Users\YourName\Documents\ObsidianVault"

   # macOS/Linux
   export OBSIDIAN_VAULT_PATH="/path/to/your/vault"
   ```

3. **Test Server**

   ```bash
   node dist/index.js
   ```

4. **Configure Claude Desktop**

   See [README.md](../README.md#claude-desktop-integration) for detailed instructions.

## Optional: Create Custom config.json

Recipients can create their own `config.json` in the project root:

```json
{
  "includePatterns": ["**/*.md"],
  "excludePatterns": [".obsidian/**", ".trash/**"],
  "enableWrite": true,
  "vectorSearch": {
    "enabled": true,
    "provider": "transformers",
    "model": "Xenova/all-MiniLM-L6-v2",
    "autoIndex": false
  }
}
```

See [docs/configuration.md](configuration.md) for all options.

## Features Available

Recipients will have access to:

✅ **Keyword search** - Fast text search with scoring
✅ **Semantic search** - AI-powered meaning-based search
✅ **Write operations** - Create, update, delete notes
✅ **Hybrid search** - Combine semantic + keyword
✅ **Privacy-first** - Local embeddings, no external API calls
✅ **Production-ready** - Tested with 5,000+ notes

## Support

For issues or questions:
- Check [README.md](../README.md)
- Check [docs/configuration.md](configuration.md) for setup help
- Check [docs/vector-search.md](vector-search.md) for semantic search help
- Open an issue on GitHub

## License

This project is MIT licensed - free to use, modify, and share.
