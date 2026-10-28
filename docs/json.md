# ctx-autopsy `--json` output schema

`ctx-autopsy --json` prints one JSON document (plus a trailing newline) with the same
numbers as the text report, in machine-readable form. File names appear without folders;
no session content, arguments, or folder paths appear anywhere in the output (see
[Privacy](#privacy-what-names-appear)).

Example output below was produced by the 0.1.1 `cli.js` (archived from `origin/main`,
run in a temp dir) against fully synthetic logs, with the 0.2.0 keys added. All other
`e.g.` values in this doc are synthetic too. Fields marked **0.2.0** were checked
against the 0.2.0 `cli.js` and synthetic runs.

## Stability promise

- `schemaVersion` is `1`. While it stays `1`, changes are **additive only**: new fields
  may appear, but no field is renamed, removed, or changes meaning.
- If a field is ever renamed, removed, or changes meaning, `schemaVersion` is bumped.
- Checked against the current tree: `cli.js` emits `schemaVersion` from a
  `SCHEMA_VERSION = 1` constant, `test.js` asserts it equals `1`, and the 0.1.0 → 0.1.1
  history is additive only (`summary.toolReferences` and `meta.skippedDirectories` were
  added; nothing was renamed — `startingContext` kept its name even when its
  text-report wording changed, as the README notes). The README makes no
  contradicting stability claim, so this promise is new documentation, not a behavior
  change. The 0.2.0 release keeps `schemaVersion` at `1` with additive-only changes.

## Example (0.1.1, synthetic logs)

One main session (an `npm test` run, two identical `Read pricing.ts` calls, one MCP
search) plus one subagent log (`git status`):

```json
{
  "schemaVersion": 1,
  "toolVersion": "0.1.1",
  "summary": {
    "sessions": 1,
    "subagentFiles": 1,
    "toolResults": 5,
    "textChars": 25095,
    "flaggedChars": 25023,
    "flaggedPct": 99.7,
    "images": 0,
    "toolReferences": 0
  },
  "byTool": [
    { "tool": "Bash", "calls": 2, "chars": 25025, "pct": 99.7 },
    { "tool": "Read", "calls": 2, "chars": 46, "pct": 0.2 },
    { "tool": "mcp:synthdemo", "calls": 1, "chars": 24, "pct": 0.1 }
  ],
  "top": [
    { "label": "Bash  npm test", "chars": 25000 },
    { "label": "Bash  git status", "chars": 25 },
    { "label": "mcp:synthdemo", "chars": 24 },
    { "label": "Read  pricing.ts", "chars": 23 },
    { "label": "Read  pricing.ts", "chars": 23 }
  ],
  "rereads": {
    "count": 1,
    "chars": 23,
    "files": [{ "file": "pricing.ts", "count": 1 }],
    "subagent": { "count": 0, "chars": 0, "readChars": 0, "files": [] }
  },
  "startingContext": {
    "medianTokens": 60700,
    "sessions": 1,
    "split": null
  },
  "meta": {
    "node": "v24.21.0",
    "platform": "linux",
    "claudeCodeVersions": ["2.1.312", "2.1.312"],
    "files": 2,
    "skippedFiles": 0,
    "skippedDirectories": 0,
    "lines": 10,
    "badLines": 0,
    "oversizeLines": 0,
    "unpairedToolResults": 0,
    "unknownBlockTypes": {},
    "suspect": false
  },
  "tips": [
    "Bash output is a big share. Prefer quiet runners (pytest -q, vitest --reporter=dot). If you pipe, keep the exit code: set -o pipefail; npm test 2>&1 | tail -50",
    "Unchanged files were re-read. Put the key facts in CLAUDE.md or point Claude at exact lines.",
    "First-request input includes your message. Use /context to inspect CLAUDE.md, MCP and skill sizes."
  ]
}
```

0.2.0 output always includes both keys. With values, they look like (synthetic
values):

```json
"startingContext": {
  "medianTokens": 60704,
  "sessions": 40,
  "split": {
    "sessions": 32,
    "systemChars": 9800,
    "toolsChars": 30100,
    "toolCount": 13,
    "systemTokens": 3267,
    "toolsTokens": 10033,
    "toolsBuiltinTokens": 10033,
    "toolsMcpTokens": 0,
    "restTokens": 40500
  }
},
"rereads": {
  "count": 2, "chars": 15000,
  "files": [{ "file": "checkout.ts", "count": 1 }, { "file": "pricing.ts", "count": 1 }],
  "subagent": {
    "count": 4, "chars": 12000,
    "readChars": 20000,
    "files": [{ "file": "pricing.ts", "count": 3 }, { "file": "checkout.ts", "count": 1 }]
  }
}
```

## Field reference

Units used below: **chars** = characters of tool-output text (JS string length);
**tokens** = usage tokens reported by the log (`input_tokens` + `cache_read_input_tokens`
+ `cache_creation_input_tokens`); **~tokens** = rough tokens, `round(chars / 3)`, ±50%;
**count** = integer count; **%** = percent on a 0–100 scale with one decimal.

### Top level

- `schemaVersion` — number, count. Schema version, currently `1`. Never null.
  Since 0.1.0. E.g. `1`.
- `toolVersion` — string. Tool version that produced the report. Never null.
  Since 0.1.0. E.g. `"0.1.1"`.
- `summary` — object. Totals across the window. Never null. Since 0.1.0.
- `byTool` — array of objects, sorted by `chars` descending (full list; text shows 8).
  Empty when no tool results were counted (non-empty with `chars: 0` / `pct: null`
  when results have no text). Since 0.1.0.
- `top` — array of `{label, chars}`, largest single results first, up to 10 entries
  (text shows 5). Empty when no tool results were counted (non-empty with `chars: 0`
  when results have no text). Since 0.1.0.
- `rereads` — object. Re-reads of unchanged files. Never null. Since 0.1.0.
- `startingContext` — object. First-request input sizes. Never null. Since 0.1.0.
- `meta` — object. Parse/census info for bug reports. Never null. Since 0.1.0.
- `tips` — array of strings. Static advice; empty when nothing applies. Never null.
  Since 0.1.0.

### `summary.*`

- `summary.sessions` — number, count. Main-session log files parsed (subagent logs
  excluded; resumed copies count per file). Never null. Since 0.1.0. E.g. `1`.
- `summary.subagentFiles` — number, count. Subagent log files parsed. Never null.
  Since 0.1.0. E.g. `1`.
- `summary.toolResults` — number, count. Tool results counted: inside `--days`,
  deduplicated by `tool_use` id across resumed copies. Never null. Since 0.1.0.
  E.g. `5`.
- `summary.textChars` — number, chars. Measured text in counted results: string
  content plus `text` blocks (including inside `search_result`); base64 never counted.
  Never null. Since 0.1.0. E.g. `25095`.
- `summary.flaggedChars` — number, chars. Of `textChars`, the part from results that
  are oversized (single result ≥ 20000 chars) or re-reads; each result counted once.
  Never null. Since 0.1.0. E.g. `25023`.
- `summary.flaggedPct` — number or null, %. `flaggedChars / textChars`, one decimal.
  Null when `textChars` is 0. Since 0.1.0. E.g. `99.7`.
- `summary.images` — number, count. `image`/`document` blocks in counted results
  (counted, not measured). Never null. Since 0.1.0. E.g. `0`.
- `summary.toolReferences` — number, count. `tool_reference` blocks inside counted
  tool results (definitions loaded by tool search; counted, not measured — the log
  names the tool but not the loaded definition). Windowed and deduplicated like
  results. Never null. Since 0.1.1. E.g. `2`.

### `byTool[].*`

One entry per tool group, sorted by `chars` descending.

- `byTool[].tool` — string. Group label: `Bash`, cleaned tool name (`Read`,
  `ToolSearch`, …), `mcp:<server>` for MCP tools, or `?` for non-string names.
  Never null. Since 0.1.0. E.g. `"mcp:synthdemo"`.
- `byTool[].calls` — number, count. Counted results in this group. Never null.
  Since 0.1.0. E.g. `2`.
- `byTool[].chars` — number, chars. Measured text in this group. Never null.
  Since 0.1.0. E.g. `25025`.
- `byTool[].pct` — number or null, %. Group share of `summary.textChars`, one decimal.
  Null when `textChars` is 0 (e.g. all results empty or reference-only). Since 0.1.0.
  E.g. `99.7`.

### `top[].*`

- `top[].label` — string. Result label: `Bash  <program[ subcommand]>`,
  `Read  <basename>` (plain `Read` for failed reads), otherwise the tool group.
  Never null. Since 0.1.0. E.g. `"Bash  npm test"`.
- `top[].chars` — number, chars. Measured text of that single result. Never null.
  Since 0.1.0. E.g. `25000`.

### `rereads.*`

Same-file re-reads: a `Read` returning exactly the same text for the same
file + offset + limit as an earlier read in the same log, with no compaction or
content change in between. Failed reads never count. Empty, image-containing, and
incomplete (unknown-block) reads never count either.

- `rereads.count` — number, count. Re-read results. Never null. Since 0.1.0. E.g. `1`.
- `rereads.chars` — number, chars. Measured text of the re-read results. Never null.
  Since 0.1.0. E.g. `23`.
- `rereads.files` — array of `{file, count}`, top 5 by `count` descending (ties keep
  log order). Empty when `count` is 0. Since 0.1.0.
- `rereads.files[].file` — string. File basename (no folders). Never null.
  Since 0.1.0. E.g. `"pricing.ts"`.
- `rereads.files[].count` — number, count. Re-reads of that file. Never null.
  Since 0.1.0. E.g. `1`.
- `rereads.subagent` — object. Subagent reads repeating an earlier identical
  main-session read of the same file range (listed separately, not part of the
  flagged percentage; a single subagent result can count in both `rereads` and
  `rereads.subagent`). Always present in 0.2.0
  (`{count: 0, chars: 0, files: [], readChars: 0}` when none). Since 0.2.0.
- `rereads.subagent.count` — number, count. Matching subagent reads. Never null.
  Since 0.2.0. E.g. `4`.
- `rereads.subagent.chars` — number, chars. Subagent result text of the matches
  (sum). Never null. Since 0.2.0. E.g. `12000`.
- `rereads.subagent.files` — array of `{file, count}`, top 5 by `count` descending,
  ties by filename ascending (code-unit order). Since 0.2.0.
- `rereads.subagent.files[].file` — string. File basename. Since 0.2.0.
  E.g. `"pricing.ts"`.
- `rereads.subagent.files[].count` — number, count. Matches for that file.
  Since 0.2.0. E.g. `3`.
- `rereads.subagent.readChars` — number, chars. All candidate subagent `Read` text
  (in-window, one per `tool_use` id) — the tip-ratio denominator. Never null.
  Since 0.2.0. E.g. `20000`.

### `startingContext.*`

First-request input per main session: the first `usage` with a positive total
(`input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`), which
includes the user message, attachments and preloaded context. Subagent logs excluded.

- `startingContext.medianTokens` — number or null, tokens. Median of the per-session
  first-request totals (even counts: mean of the two middle values, rounded).
  Null when no main session has an in-window positive first usage. Since 0.1.0.
  E.g. `60700`.
- `startingContext.sessions` — number, count. Sessions contributing to the median
  (in-window positive first usage only), so `≤ summary.sessions`. Never null.
  Since 0.1.0. E.g. `1`.
- `startingContext.split` — object or null. Median first-request breakdown for
  sessions whose earliest `api-request` resolves to an `api-request-shape` in the
  same file (2.1.310+ logs), among sessions with an in-window positive first usage
  (`split.sessions ≤ startingContext.sessions`). Null when no session resolves.
  Since 0.2.0.
- `startingContext.split.sessions` — number, count. Decomposed sessions
  (`≤ startingContext.sessions`). Never null inside `split`. Since 0.2.0. E.g. `32`.
- `startingContext.split.systemChars` — number, chars. Median system-prompt chars
  per session. Since 0.2.0. E.g. `9800`.
- `startingContext.split.toolsChars` — number, chars. Median tool-definition chars
  (`JSON.stringify(tools).length`) per session. Since 0.2.0. E.g. `30100`.
- `startingContext.split.toolCount` — number, count. Median tool count per session.
  Since 0.2.0. E.g. `13`.
- `startingContext.split.systemTokens` — number, ~tokens. Median of
  `round(systemChars / 3)`. Since 0.2.0. E.g. `3267`.
- `startingContext.split.toolsTokens` — number, ~tokens. Median of
  `round(toolsChars / 3)`. Since 0.2.0. E.g. `10033`.
- `startingContext.split.toolsBuiltinTokens` — number, ~tokens. Median of the
  non-MCP share. Since 0.2.0. E.g. `10033`.
- `startingContext.split.toolsMcpTokens` — number, ~tokens. Median of the
  `mcp__*`-tool share. Since 0.2.0. E.g. `0`.
- `startingContext.split.restTokens` — number, ~tokens. Median of
  `max(0, round(firstTokens - (systemChars + toolsChars) / 3))`: the first request
  minus system and tool definitions (message, attachments, on-demand definitions).
  Since 0.2.0. E.g. `40500`.
- Note: each `split` median is computed independently, so
  `toolsBuiltinTokens + toolsMcpTokens` may differ from `toolsTokens` by ±1. All
  `split` medians use the same even-count rounding as `medianTokens`.

### `meta.*`

Census info. Paste only this block in bug reports — never attach `.jsonl` files.

- `meta.node` — string. `process.version` of the run. Never null. Since 0.1.0.
  E.g. `"v24.21.0"`.
- `meta.platform` — string. `process.platform` of the run. Never null. Since 0.1.0.
  E.g. `"linux"`.
- `meta.claudeCodeVersions` — `[min, max]` version strings or null. Range of valid
  `x.y.z` log versions seen. Null when none seen. Since 0.1.0.
  E.g. `["2.1.312", "2.1.312"]`.
- `meta.files` — number, count. Files parsed (after the mtime prefilter, excluding
  unreadable ones). Never null. Since 0.1.0. E.g. `2`.
- `meta.skippedFiles` — number, count. Files skipped (stat/read failures). Never null.
  Since 0.1.0. E.g. `0`.
- `meta.skippedDirectories` — number, count. Subdirectories whose listing failed.
  (An unreadable session root exits with an error instead.) Never null. Since 0.1.1.
  E.g. `0`.
- `meta.lines` — number, count. Lines read. Never null. Since 0.1.0. E.g. `10`.
- `meta.badLines` — number, count. Lines that failed to parse or had odd shapes
  (errors are counted, never printed — they can echo content). Never null.
  Since 0.1.0. E.g. `0`.
- `meta.oversizeLines` — number, count. Lines over 4 MiB, skipped without buffering.
  Never null. Since 0.1.0. E.g. `0`.
- `meta.unpairedToolResults` — number, count. In-window `tool_result`s with no
  matching `tool_use` in the same log. Never null. Since 0.1.0. E.g. `0`.
- `meta.unknownBlockTypes` — object. In-window unknown block-type label → count
  (includes unknown blocks nested inside tool results). `{}` when none. Never null.
  Since 0.1.0. E.g. `{"future_result": 1}`.
- `meta.suspect` — boolean. True when numbers may be incomplete or unreliable:
  `unpairedToolResults > toolResults * 0.1`, or any entries in `unknownBlockTypes`,
  or `skippedFiles > 0`, or `skippedDirectories > 0`. (In 0.1.0 only the first two
  conditions applied.) Never null. Since 0.1.0. E.g. `false`.

## Privacy: what names appear

The JSON output never contains folders, command arguments, or session content: no
file paths, no system-prompt or tool-definition text, no tool/skill/MCP-server names
inside the 0.2.0 `split` sizes, no `shapeHash`/`requestDigest`, no session/agent ids,
no content hashes, no timestamps, no user names. The only name-like strings are:

- File basenames (`top[].label` for `Read`, `rereads.*.files[].file`): basename only,
  `?` for folder-shaped, empty, or non-string paths, `<redacted>` when longer than
  40 chars or secret-shaped.
- Bash labels (`top[].label`, never in `byTool`): program name only (`curl`),
  plus a recognized public subcommand (`npm test`, `git status`); arguments, private
  script names and env prefixes are dropped, and unidentifiable complex shell syntax
  is shown as `bash`.
- Tool groups (`byTool[].tool`, other `top[].label`s): `Bash`, the cleaned tool name
  (`Read`, `ToolSearch`, …), or `mcp:<server>` where `<server>` is the cleaned MCP
  server name (the `mcp:` prefix is kept even when the name is redacted).
- Unknown block-type labels (`meta.unknownBlockTypes` keys): validated charset only,
  otherwise `<redacted>` (secret-shaped names also redact).

## Version history

- 0.1.0: all fields except the two below.
- 0.1.1: added `summary.toolReferences` and `meta.skippedDirectories`; `meta.suspect`
  also covers skipped files/directories; `search_result` text is measured and
  `tool_reference` blocks inside counted tool results are counted (previously
  unknown; top-level `tool_reference` is still unknown).
- 0.2.0: adds `startingContext.split` (9 number fields) and `rereads.subagent`
  (`count`, `chars`, `files`, `readChars`). `schemaVersion` stays `1`.
