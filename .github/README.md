# GitHub Configuration

This folder contains GitHub-specific configuration files that are **gitignored** (see root `.gitignore`).

## Files

### `copilot-instructions.md`

AI assistant instructions for GitHub Copilot and Claude.

**Purpose:**
- Provides comprehensive project context for AI assistants
- Documents MCP architecture and TypeScript patterns
- Explains Obsidian vault structure and conventions
- Defines coding standards and best practices
- Includes testing and validation procedures

**Key Sections:**
- Project overview and critical context
- Technology stack and dependencies
- Development workflows and patterns
- MCP protocol standards
- Documentation and logging standards
- Integration points (Claude Desktop, vector search, file watcher)
- Common pitfalls and testing strategies

**Usage:**
AI assistants automatically reference this file for project-specific guidance.

### `obsidian-mcp-server.code-workspace`

VS Code workspace configuration for the Obsidian MCP Server project.

**Features:**
- Multi-folder workspace (MCP Server + Documentation)
- Pre-configured launch configurations for debugging
- Build and test tasks
- Recommended extensions
- TypeScript and markdown formatting settings
- Utility tasks (clean build, clean vector store, standalone indexing)

**Usage:**

```powershell
# Open workspace in VS Code
code .github\obsidian-mcp-server.code-workspace
```

**What's Included:**

1. **MCP Server Folder** (`d:\repos\obsidian-mcp-server\`)
   - Primary development folder
   - TypeScript/Node.js configuration
   - Build and test tasks

2. **Documentation Folder** (Obsidian vault path)
   - Project documentation in Obsidian
   - Architecture, guides, and project notes
   - Markdown-optimized settings

**Launch Configurations:**
- `Run MCP Server (Standalone)` - Run server with full indexing
- `Debug MCP Server` - Debug with source maps
- `Run Tests` - Execute test suite

**Tasks:**
- `npm: build` - Compile TypeScript (Ctrl+Shift+B)
- `npm: build - watch` - Watch mode compilation
- `Run Standalone Indexing` - Index vault outside Claude Desktop
- `Clean Build` - Remove dist/ folder
- `Clean Vector Store` - Remove .mcp-vector-store for fresh indexing

## Privacy Note

The `.github` folder is gitignored because the workspace file contains:
- Personal vault paths
- System-specific configuration
- Local development settings

**Do not commit `.github/` to version control.**

## Customization

To customize the workspace for your setup:

1. Open the workspace file in VS Code
2. Update vault path in launch configurations (search for `OBSIDIAN_VAULT_PATH`)
3. Update documentation folder path if different
4. Save changes (they stay local, not committed)
