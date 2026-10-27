# ctx-autopsy

[![npm](https://img.shields.io/npm/v/ctx-autopsy)](https://www.npmjs.com/package/ctx-autopsy) ![node](https://img.shields.io/node/v/ctx-autopsy) ![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen) ![license](https://img.shields.io/npm/l/ctx-autopsy)

**Which tool calls filled your Claude Code context?**

`npx ctx-autopsy` reads your local Claude Code session logs and ranks the tool results
(Bash commands, file reads, MCP calls) that pushed the most text into context
across all your sessions, including files that were re-read without changing.

![ctx-autopsy output: 82.5% of tool-output text came from oversized results and re-reads, followed by a per-tool bar chart, the largest results, re-read files and tips](https://raw.githubusercontent.com/Dan-Seo/ctx-autopsy/main/docs/demo.svg)

<sub>Output from the synthetic sessions in `fixtures/`. Try it on your own: `npx ctx-autopsy`</sub>

## Usage

```sh
npx ctx-autopsy            # last 30 days
npx ctx-autopsy --days 7
npx ctx-autopsy --json     # for scripts and bug reports
```

Requires Node 22+. Zero dependencies. Reads `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`).

## How it differs from built-in commands

| | shows |
|---|---|
| `/usage` | share of usage by skill, subagent, plugin, MCP server (last 24h / 7d, subscription plans) |
| `/context` | what is in the **current** session's context right now |
| `/insights` | how you work, written by the model (uses tokens) |
| **ctx-autopsy** | **which individual tool calls** (`npm test`, `Read pricing.ts`) were biggest, and which files were re-read, across all sessions, offline, any plan |

## What the numbers mean

- **Percentages are of tool-output text** (characters), not of your whole context or your bill.
  Both sides use the same unit, so no tokenizer guess is involved.
- **Flagged** = a single result of 20k+ characters, or a re-read that returned exactly the same text
  as an earlier read of the same file range (no compaction in between). Each result is counted once.
  Failed reads are not counted as re-reads.
- Token figures are rough (`chars / 3`, ±50%). Korean, Japanese and Chinese text uses more tokens per character.
- Images and PDFs are counted, not measured. Text inside structured `search_result` blocks is measured too.
- Tools loaded through tool search (`tool_reference` blocks) are counted, not measured: the log names the tool but not the definition it loads.
- The first-request input line includes your first message, attachments and preloaded context;
  it does not isolate the system prompt or CLAUDE.md. Use `/context` for the details.
  The JSON field `startingContext` retains its name for compatibility and reports this same total.
- Subagent logs are separate contexts: their tool results are included in the totals, while re-reads are tracked
  per context and the first-request input line uses main sessions only.
- If a resumed session copied earlier history into a new log, each tool result is still counted once.

## Privacy

- Runs locally. No network access, no telemetry, never writes files.
- Output shows file **names** only (no folders). Bash commands show only the program name (`curl`, `python`),
  plus a recognized public subcommand (`npm test`, `git status`). Custom script names and arguments are never shown.
  Complex shell syntax that cannot be safely identified is labeled `bash`.
- Session content is never printed, including in error messages.
- Reporting a bug? Paste the `meta` block of `npx ctx-autopsy --json`. Please do not attach `.jsonl` files.

## Limits

The session log format is not a public API and may change between Claude Code versions.
The footer shows which versions were parsed, and a warning appears when unknown structures show up,
including inside tool results. Unreadable files and subdirectories also produce a warning;
the JSON `meta.skippedDirectories` field counts directory traversal failures. An unreadable session root exits with an error.

## License

MIT
