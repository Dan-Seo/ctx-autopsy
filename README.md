# ctx-autopsy

[![npm](https://img.shields.io/npm/v/ctx-autopsy)](https://www.npmjs.com/package/ctx-autopsy) ![node](https://img.shields.io/node/v/ctx-autopsy) ![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen) ![license](https://img.shields.io/npm/l/ctx-autopsy)

**What ate your Claude Code context window?**

- **What:** ranks the tool results — Bash outputs, file reads, MCP calls — that pushed
  the most text into your context, lists subagent re-reads of main-session files,
  and splits the first request (2.1.310+ sessions) into system prompt, tool definitions and the rest.
- **Who:** Claude Code users whose context fills up fast and who want to know exactly which calls did it.
- **How:** reads your local session logs across all your sessions, offline. Zero dependencies.

```sh
npx ctx-autopsy
```

> In the bundled demo sessions, 82.5% of tool-output text came from oversized results
> and re-reads. Run it to see your number.

![ctx-autopsy output: 82.5% of tool-output text came from oversized results and re-reads, followed by a per-tool bar chart, the largest results, re-read files and tips](https://raw.githubusercontent.com/Dan-Seo/ctx-autopsy/main/docs/demo.svg)

<sub>Output from the synthetic sessions in `fixtures/`. Try it on your own: `npx ctx-autopsy`</sub>

## Why

Context fills up silently: one verbose `npm test` run or a file read ten times over can push
thousands of lines into the window without you noticing. ctx-autopsy shows which individual
tool calls were the biggest, so you know what to quiet down, scope down, or stop re-reading.

## When to use

- Your sessions compact early or run out of context unexpectedly.
- You want fewer, cheaper re-reads: find files Claude reads again without changes.
- Your first request looks big: see what it is made of — system prompt, tool definitions (built-in vs MCP) and the rest — on Claude Code 2.1.310+.
- You use subagents: find files they read again that the main session already loaded.
- You are writing a bug report or tuning a workflow and need a `meta` block or JSON summary (`--json`).

## Usage

```sh
npx ctx-autopsy            # last 30 days
npx ctx-autopsy --days 7
npx ctx-autopsy --json     # for scripts and bug reports
```

JSON fields are documented in [docs/json.md](docs/json.md).

Requires Node 22+. Zero dependencies. Reads `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`).

## FAQ

**What is eating my Claude Code context window?**
Run `npx ctx-autopsy`. It ranks the tool results that pushed the most text into context
across all your sessions. Percentages are of tool-output text (characters), not of your
whole context or your bill.

**Which files does Claude keep re-reading?**
The re-reads section lists files that returned exactly the same text as an earlier read of
the same file range, with no compaction in between.

**Why is my first request so big?**
Every session starts with the first-request input before any tool result lands.
ctx-autopsy reports its median size and, on Claude Code 2.1.310+, splits it into system prompt, tool definitions (built-in vs MCP) and the rest. For example, synthetic sessions with the new records print:
`First-request input: median 58k tokens over 2 sessions (includes your message)`
`first-request split (2.1.310+, 1 session): system ~167 · tools ~16 (builtin ~6 · mcp ~10) · rest ~55k tokens (±50%)`
Older logs show the total without the split. Token figures are rough (`chars / 3`, ±50%).

**Do subagents re-read what the main session already loaded?**
Sometimes: a subagent works in a separate context and may read the same files again.
ctx-autopsy lists subagent reads that return exactly the same text the main session already read from the same file range. For example, synthetic sessions with subagent logs print:
`Subagent re-reads of main-session files: 2 (86 chars)`
The list is separate from same-session re-reads and from the flagged percentage.

**Does it send my session data anywhere?**
No. It runs locally with no network access, no telemetry, and never writes files.
Output shows file names, tool names, MCP server names, and directly executed script names — no folders, no arguments, no session content. Tool/MCP names appear only when identifier-like (letters, digits, `_ . : -`, 1–40 chars) and not secret-like, else `<redacted>` (`mcp:<redacted>`). Files/scripts omit folders; over-long or secret-like file names are `<redacted>`, unidentifiable or over-long commands `bash`. Unknown block type names may appear under `meta.unknownBlockTypes` (non-identifier-like, secret-like or over-long names show as `<redacted>`).

**How is this different from `/context` or ccusage?**
`/context` shows the current session's context right now; ccusage reports token usage and
cost over time. ctx-autopsy ranks which individual past tool calls were biggest.

**토큰 수치는 얼마나 정확한가요?**
Token figures are rough (`chars / 3`, ±50%). Korean, Japanese and Chinese text uses more
tokens per character — treat the number as an order-of-magnitude guide.

## How it compares

Built-in commands:

| | shows |
|---|---|
| `/usage` | share of usage by skill, subagent, plugin, MCP server (last 24h / 7d, subscription plans) |
| `/context` | what is in the **current** session's context right now |
| `/insights` | how you work, written by the model (uses tokens) |
| **ctx-autopsy** | **which individual tool calls** (`npm test`, `Read pricing.ts`) were biggest, which files were re-read (same session or by subagents), and the first-request split into system, tools and rest (2.1.310+), across all sessions, offline, any plan |

Other open-source tools:

- [ccusage](https://github.com/ccusage/ccusage) reports token usage and cost per day, week, month and session across agent CLIs; ctx-autopsy instead ranks individual tool calls and re-reads by their share of context.
- [cost-xray](https://github.com/tigerless-labs/cost-xray) shows what an agent sends to the API and what each part costs; ctx-autopsy measures local session logs offline and does not track cost.
- [token-report](https://github.com/24kchengYe/token-report) scans local sessions into terminal reports and interactive HTML dashboards; ctx-autopsy is a zero-dependency terminal-only report focused on per-tool-call ranking.
- [claude-mods](https://github.com/mishgoldenberg/claude-mods) adds live panels, guardrails and notifications inside Claude Code; ctx-autopsy is a post-hoc analysis across past sessions.
- [tokenmaxxing](https://github.com/851-labs/tokenmaxxing) syncs token usage with others; ctx-autopsy runs fully locally with no network access.

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
  it does not isolate CLAUDE.md or skills (see the split line below for the system prompt and tool definitions). Use `/context` for the details.
  The JSON field `startingContext` retains its name for compatibility and reports this same total.
- Subagent logs are separate contexts: their tool results are included in the totals, while re-reads are tracked
  per context and the first-request input line uses main sessions only.
- If a resumed session copied earlier history into a new log, each tool result is still counted once.
- The first-request split line (2.1.310+ sessions only) breaks the median first request into system prompt, tool definitions (built-in vs MCP) and the rest. Underlying sizes are characters (see JSON `systemChars`/`toolsChars`); the line shows rough tokens (`chars / 3`, ±50%). Tool definitions loaded on demand by tool search are not part of the request's tool list, so they show up in "rest".
- Subagent re-reads counts subagent reads that repeat an earlier identical main-session read of the same file range. It is listed separately and is not part of the flagged percentage. A result can appear in both lists.

## Privacy

- Runs locally. No network access, no telemetry, never writes files.
- Output shows file **names** only (no folders; names over 40 chars or matching secret patterns show as `<redacted>`). Bash commands show only the program name (`curl`, `python`),
  plus a recognized public subcommand (`npm test`, `git status`). Private package-script names and arguments are never shown:
  `npm acme-private-deploy` is labeled `npm`. Directly executed scripts show as the file name only (`./deploy.sh` → `deploy.sh`). Complex shell syntax that cannot be safely identified is labeled `bash`; secret-like program names show as `<redacted>`.
- Tool names and MCP server names (`mcp:<server>`) are shown as-is when identifier-like (letters, digits, `_ . : -`, 1–40 chars); empty or longer names, names matching secret patterns, or names containing folders, spaces or other separators show as `<redacted>` (`mcp:<redacted>` keeps the prefix).
  Unknown block type names may appear under `meta.unknownBlockTypes` (non-identifier-like, secret-like or over-long names show as `<redacted>`).
- Session content is never printed, including in error messages.
- Reporting a bug? Paste the `meta` block of `npx ctx-autopsy --json`. Please do not attach `.jsonl` files.
- The first-request split reads request-shape records but shows only sizes (characters and counts).

## Limits

The session log format is not a public API and may change between Claude Code versions.
The footer shows which versions were parsed, and a warning appears when unknown structures show up,
including inside tool results. Unreadable files and subdirectories also produce a warning;
the JSON `meta.skippedDirectories` field counts directory traversal failures. An unreadable session root exits with an error.

## License

MIT
