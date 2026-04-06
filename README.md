# mdg — Markdown Grep

Search markdown files with grep-like syntax and hybrid semantic ranking.

To install the latest release binary into `~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/chenhunghan/markdown-grep/main/install.sh | bash
```

Re-running the script is safe; it updates `mdg` to the latest GitHub release if needed.

On Windows, use PowerShell:

```powershell
iwr https://raw.githubusercontent.com/chenhunghan/markdown-grep/main/install.ps1 | iex
```

Re-running the PowerShell script is also safe; it updates `mdg.exe` to the latest GitHub release if needed.

## Commit Messages

This repo validates commit messages with commitlint on `postinstall`.

Use commit messages like:

```bash
feat: add install script
fix: improve embedding progress logs
docs: update install instructions
```

## Usage

### Text search (grep-compatible)

```bash
# Recursive search with line numbers
mdg grep -rn "pattern" [path...]

# Case-insensitive, list matching files only
mdg grep -rli "pattern"

# Count matches per file
mdg grep -rc "pattern" docs/

# All standard grep flags work (-v, -w, -x, -A, -B, -C, --include, etc.)
mdg grep -rn -A 2 -B 1 "function" .
```

Notes:
- `mdg grep` uses line-level output for normal search, but hybrid retrieval still ranks by markdown chunks internally.
- Flags that change output structure, like `-c` and `-A/-B/-C`, are handled via native `grep` for exact compatibility.
- For strict Unix `grep` parity, prefer explicit text-search flags and avoid relying on semantic ranking behavior.

### Hybrid search (vector similarity)

```bash
# Search by meaning, not exact text
mdg grep "how to configure the API"
mdg grep "error handling patterns" docs/

# Combine with grep flags for output formatting
mdg grep -nl "authentication flow"
```

### Indexing

```bash
# Build/update the search index (FTS + embeddings)
mdg index

# FTS-only index (fast, no model download needed)
mdg index --no-embeddings

# Force re-index everything
mdg index --force

# Check index status
mdg status
```

## Build

```bash
# Compile to a standalone binary
bun run build

# The binary can be moved anywhere; it looks for vec0.dylib in ~/.mdg/lib/
```

## Search setup

The compiled binary handles grep and FTS search standalone.
Hybrid search is auto-installed on first use.

```bash
# Pre-install search dependencies
mdg setup

# Or just use mdg grep and it auto-installs on first run
mdg grep "how to configure the API"
```

## Notes

- `mdg grep` is line-oriented for normal text search.
- `mdg setup` pre-installs the optional hybrid search dependencies.

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `MDG_EMBED_MODEL` | `embeddinggemma-300M-Q8_0` | GGUF model URI for embeddings |

Set `MDG_EMBED_MODEL` to a Hugging Face GGUF URI to use a different model:

```bash
export MDG_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
```

## Requirements

- [Bun](https://bun.sh) v1.3+
- macOS: Homebrew SQLite (`brew install sqlite`)
- Hybrid search downloads extra files on first use
