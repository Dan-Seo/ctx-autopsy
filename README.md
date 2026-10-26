# ctx-autopsy

**Which tool calls filled your Claude Code context?**

`npx ctx-autopsy` reads your local Claude Code session logs and ranks the tool results
(Bash commands, file reads, MCP calls) that pushed the most text into context
across all your sessions, including files that were re-read without changing.

```
ctx-autopsy  last 30 days · 2 sessions · 1 subagent log · 18 tool results

82.5% of tool-output text came from oversized results (>=20k chars) and re-reads
  217k of 263k chars · roughly 72k tokens (±50%)

By tool
  Read          48.4%  ████████████ 127k chars · 9 calls
  Bash          41.4%  ██████████ 109k chars · 4 calls
  mcp:browser    9.1%  ██ 24k chars · 1 call
  Grep           0.9%  █ 2k chars · 1 call
  Glob           0.2%  █ 649 chars · 1 call
  Edit             0%  █ 4 chars · 2 calls

Largest single results
     47k  Bash  npx
     35k  Read  pricing.ts
     35k  Read  pricing.ts
     34k  Bash  npm test
     28k  Bash  npm test

Re-reads of unchanged files: 2 (49k chars)
     1x  checkout.ts
     1x  pricing.ts

Images/PDFs in tool results: 1 (not counted above)
Context before your first message: median 61k tokens over 2 sessions

Try
  - Bash output is a big share. Prefer quiet runners (pytest -q, vitest --reporter=dot). If you pipe, keep the exit code: set -o pipefail; npm test 2>&1 | tail -50
  - Read output is a big share. Ask for line ranges (Read with offset/limit) instead of whole files.
  - Unchanged files were re-read. Put the key facts in CLAUDE.md or point Claude at exact lines.
  - Context already loaded before your first message: run /context to see CLAUDE.md, MCP and skill sizes.

Parsed 45 lines in 3 files · Claude Code 2.1.280–2.1.292 · bad 1 · oversize 0 · unpaired 0
```
<sub>Output from the synthetic sessions in `fixtures/`.</sub>

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
- Images and PDFs are counted, not measured. The system prompt, CLAUDE.md, and other context that loads
  before your first message are shown as one line; use `/context` for the details.
- Subagent logs are separate contexts: their tool results are included in the totals, while re-reads are tracked
  per context and the starting-context line uses main sessions only.
- If a resumed session copied earlier history into a new log, each tool result is still counted once.

## Privacy

- Runs locally. No network access, no telemetry, never writes files.
- Output shows file **names** only (no folders). Bash commands show only the program name (`curl`, `python`),
  plus the subcommand for tools like npm, git, cargo, docker (`npm test`, `git status`). Arguments are never shown.
- Session content is never printed, including in error messages.
- Reporting a bug? Paste the `meta` block of `npx ctx-autopsy --json`. Please do not attach `.jsonl` files.

## Limits

The session log format is not a public API and may change between Claude Code versions.
The footer shows which versions were parsed, and a warning appears when unknown structures show up.

## License

MIT
