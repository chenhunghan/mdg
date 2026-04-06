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

### Optional Indexing

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

## Search setup

Zero setup for basic `mdg grep` use.
Optional smart search auto-installs on first use.

```bash
# Pre-install optional smart search dependencies
mdg setup

# Or just use mdg grep and it auto-installs on first use
mdg grep "how to configure the API"
```

## Requirements

- [Bun](https://bun.sh) v1.3+
- macOS: Homebrew SQLite (`brew install sqlite`)
- Hybrid search downloads extra files on first use
