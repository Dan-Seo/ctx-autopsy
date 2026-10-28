#!/usr/bin/env node
'use strict';
// ctx-autopsy: which tool calls filled your Claude Code context.
// Local only: reads ~/.claude/projects/**/*.jsonl, never writes files, never touches the network.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseArgs } = require('node:util');
const { StringDecoder } = require('node:string_decoder');
const { createHash } = require('node:crypto');

const VERSION = require('./package.json').version;
const SCHEMA_VERSION = 1;
const MAX_LINE = 4 * 1024 * 1024; // longer lines are skipped, never buffered
const BIG = 20000;                // a single tool result this many chars or more is "oversized"
const TOP_N = 10;
const KNOWN_BLOCKS = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result',
  'image', 'document', 'search_result', 'server_tool_use', 'web_search_tool_result', 'web_fetch_tool_result']);

// ---------- redaction: every label shown to the user is built here ----------

const CTRL = /[\u0000-\u001f\u007f-\u009f]/g; // ANSI/OSC escapes, newlines
const SECRETISH = /(^|[^A-Za-z0-9])(sk-|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|eyJ)|Bearer|token|secret|passw/i;

function clean(s) {
  s = String(s).replace(CTRL, '');
  return s.length > 40 || SECRETISH.test(s) ? '<redacted>' : s;
}

// Only public subcommands are safe to display; runners also accept private script names here.
const SUBCOMMANDS = new Map(Object.entries({
  npm: 'install ci test run exec init update uninstall audit ls view pack publish',
  pnpm: 'install add remove update run test exec dlx build audit list',
  yarn: 'install add remove up run test build exec dlx workspace workspaces',
  bun: 'install add remove update run test build x',
  git: 'status diff log show add commit checkout switch branch merge rebase reset restore clean fetch pull push clone init remote config tag stash worktree',
  cargo: 'build test run check fmt clippy doc bench clean update add',
  go: 'build test run vet fmt mod get install version env clean',
  docker: 'build run compose ps images image container logs exec pull push inspect stop start',
  kubectl: 'get describe apply delete logs exec rollout config version top',
  gh: 'pr issue repo api auth release run workflow',
  dotnet: 'build test run restore publish new clean format tool',
  mvn: 'clean compile test package verify install deploy',
  gradle: 'build test clean assemble check tasks',
  uv: 'run sync add remove lock pip venv python tool',
  poetry: 'install add remove update run build publish lock show',
  deno: 'run test task check fmt lint compile install add',
  pip: 'install uninstall list show freeze check download wheel',
  pip3: 'install uninstall list show freeze check download wheel',
  brew: 'install uninstall update upgrade list info services',
}).map(([program, commands]) => [program, new Set(commands.split(' '))]));

// A bounded lexer for simple commands, not a shell interpreter. Ambiguous syntax returns no label.
function commandWords(cmd) {
  if (typeof cmd !== 'string' || cmd.length > 2000) return null;
  let words = [], word = '', quote = '', started = false, plain = true, assignment = false, esc = false;
  const endWord = () => {
    if (started) words.push({ word, assignment, esc });
    word = ''; started = false; plain = true; assignment = false; esc = false;
  };
  const endCommand = () => {
    endWord();
    const first = words.findIndex(w => !w.assignment);
    // An unquoted escape in the program word (e.g. a Windows path) mashes folders
    // into the name, so the program is unidentifiable.
    const command = first < 0 || words[first].word === 'cd' || words[first].esc ? null : words.slice(first).map(w => w.word);
    words = [];
    return command;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    // Expansions can contain nested commands and quotes; never guess their executable or arguments.
    if (quote !== "'" && (c === '$' || c === '`')) return null;
    if (c === '\\' && quote !== "'") {
      const next = cmd[i + 1];
      if (next === undefined) return null;
      if (!quote) esc = true;
      if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next)) { word += c; continue; }
      i++;
      if (next !== '\n') { word += next; started = true; plain = false; }
      continue;
    }
    if (quote) { if (c === quote) quote = ''; else word += c; continue; }
    if (c === '"' || c === "'") { quote = c; started = true; plain = false; continue; }
    if (';|&\n'.includes(c)) {
      const command = endCommand();
      if (command) return command;
      continue;
    }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === '#' && !started) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++;
      continue;
    }
    if ('<>()'.includes(c)) return null;
    if (c === '=' && plain && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) assignment = true;
    word += c; started = true;
  }
  return quote ? null : endCommand();
}

// "cd x && FOO=1 npm test -- --x" -> "npm test". Arguments are never shown.
function bashLabel(cmd) {
  const words = commandWords(cmd);
  if (!words || words[0].includes('=')) return 'bash';
  const prog = path.basename(words[0].replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, '');
  if (!/^[A-Za-z0-9._+-]{1,30}$/.test(prog)) return 'bash';
  const sub = SUBCOMMANDS.get(prog)?.has(words[1]) ? ' ' + words[1] : '';
  return clean(prog + sub);
}

function fileLabel(p) {
  if (typeof p !== 'string' || /[\\/]$/.test(p)) return '?'; // a folder path would show the folder name
  return clean(path.basename(p.replace(/\\/g, '/')) || '?');
}

function toolGroup(name) {
  if (name === 'Bash') return 'Bash';
  if (typeof name !== 'string') return '?';
  const m = /^mcp__(.+?)__/.exec(name);
  if (m) return 'mcp:' + (/^[A-Za-z0-9_.:-]{1,40}$/.test(m[1]) ? clean(m[1]) : '<redacted>');
  return /^[A-Za-z0-9_.:-]{1,40}$/.test(name) ? clean(name) : '<redacted>';
}

function resultLabel(name, input, isError) {
  if (name === 'Bash') return 'Bash  ' + bashLabel(input && input.command);
  if (name === 'Read') return isError ? 'Read' : 'Read  ' + fileLabel(input && input.file_path);
  return toolGroup(name);
}

// ---------- analysis ----------

function newReport(opts = {}) {
  return {
    since: opts.since || 0,
    files: 0, sessions: 0, subagentFiles: 0, skippedFiles: 0, skippedDirectories: 0,
    lines: 0, badLines: 0, oversizeLines: 0, unpaired: 0,
    unknownBlocks: Object.create(null), ccMin: null, ccMax: null,
    counted: new Set(),    // tool_use ids already counted, across files
    results: 0, textChars: 0, flaggedChars: 0, images: 0, toolReferences: 0,
    byTool: new Map(),     // group -> {calls, chars}
    top: [],               // [{label, chars}]
    rereads: { count: 0, chars: 0, files: new Map() },
    startCtx: [],          // first-request input tokens, including the user's message, per main session
    splitParts: [],        // per-session first-request shape measurements
    mainFirst: new Map(),  // sessionKey + read key + hash -> earliest main read time
    subById: new Map(),    // tool_use id -> one subagent read candidate
  };
}

function newFileState(isSubagent, sessionKey = null) {
  return { isSubagent, sessionKey, uses: new Map(), reads: new Map(), sawFirstUsage: false,
    shapes: new Map(), firstReq: null, firstUsageTokens: null, pushedStartCtx: false };
}

const num = x => (Number.isFinite(x) && x >= 0 ? x : 0); // usage fields come from an undocumented format

const parseTsMs = t => typeof t === 'number' && Number.isFinite(t) ? t : typeof t === 'string' && Number.isFinite(Date.parse(t)) ? Date.parse(t) : Infinity;

// Sizes only; never throws and never keeps names, text, or hashes.
function measureShape(shape) {
  try {
    let sysC = 0;
    if (shape && Array.isArray(shape.system))
      for (const el of shape.system) if (el && typeof el.text === 'string') sysC += el.text.length;
    let toolC = 0, mcpC = 0, count = 0, ok = false;
    if (shape && Array.isArray(shape.tools)) {
      count = shape.tools.length;
      try { toolC = JSON.stringify(shape.tools).length; ok = true; } catch { toolC = 0; }
      if (ok) for (const el of shape.tools) {
        if (el && typeof el.name === 'string' && el.name.startsWith('mcp__'))
          try { mcpC += JSON.stringify(el).length; } catch { /* skip this piece */ }
      }
    }
    return { sysC, toolC, builtinC: Math.max(0, toolC - mcpC), mcpC, count };
  } catch {
    return { sysC: 0, toolC: 0, builtinC: 0, mcpC: 0, count: 0 };
  }
}

function verCmp(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// Text length, image count, and a hash of the text (to tell a real re-read from a changed file).
function resultText(content, onUnknown) {
  const h = createHash('sha1');
  if (typeof content === 'string') return { chars: content.length, images: 0, refs: 0, hash: h.update(content).digest('hex'), complete: true };
  let chars = 0, images = 0, refs = 0, complete = true;
  const unknown = type => { complete = false; onUnknown(type); };
  const stack = Array.isArray(content) ? [{ blocks: content, index: 0 }] : [];
  if (content != null && !Array.isArray(content)) unknown('invalid_tool_result_content');
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index === frame.blocks.length) { stack.pop(); continue; }
    const c = frame.blocks[frame.index++];
    if (c && c.type === 'text' && typeof c.text === 'string') { chars += c.text.length; h.update(c.text); }
    else if (c && (c.type === 'image' || c.type === 'document')) images++; // base64 is never counted
    else if (c && c.type === 'tool_reference') refs++; // the loaded definition is not in the log
    else if (c && c.type === 'search_result' && Array.isArray(c.content)) {
      stack.push({ blocks: c.content, index: 0 });
    } else if (c && c.type === 'search_result') unknown('invalid_search_result_content');
    else unknown(c && typeof c.type === 'string' ? c.type : 'invalid_tool_result_block');
  }
  return { chars, images, refs, hash: h.digest('hex'), complete };
}

function unknownBlock(r, type, inWindow) {
  if (!inWindow) return;
  const label = /^[A-Za-z0-9_.:-]{1,40}$/.test(type) ? clean(type) : '<redacted>';
  r.unknownBlocks[label] = (r.unknownBlocks[label] || 0) + 1;
}

function pushTop(top, item) {
  top.push(item);
  top.sort((a, b) => b.chars - a.chars);
  if (top.length > TOP_N) top.length = TOP_N;
}

function feedLine(r, st, line) {
  r.lines++;
  if (line === null) { r.oversizeLines++; return; }
  let o;
  try { o = JSON.parse(line); } catch { r.badLines++; return; } // never print the error: it can echo content
  if (!o || typeof o !== 'object' || Array.isArray(o)) { r.badLines++; return; } // only record objects count
  try { feedRecord(r, st, o); } catch { r.badLines++; } // odd shapes (e.g. objects where strings belong)
}

function feedRecord(r, st, o) {
  if (typeof o.version === 'string' && /^\d+\.\d+\.\d+$/.test(o.version)) {
    if (!r.ccMin || verCmp(o.version, r.ccMin) < 0) r.ccMin = o.version;
    if (!r.ccMax || verCmp(o.version, r.ccMax) > 0) r.ccMax = o.version;
  }
  if (o.type === 'system' && o.subtype === 'compact_boundary') { st.reads.clear(); return; }
  if (o.type === 'api-request-shape' && !st.isSubagent && typeof o.shapeHash === 'string' && !st.shapes.has(o.shapeHash))
    st.shapes.set(o.shapeHash, measureShape(o.shape));
  if (o.type === 'api-request' && !st.isSubagent && (o.agentId == null || o.agentId === '')) {
    const ts = parseTsMs(o.timestamp);
    if (!st.firstReq || ts < st.firstReq.tsMs) st.firstReq = { tsMs: ts, hash: o.shapeHash };
  }
  if (o.type !== 'user' && o.type !== 'assistant') return; // attachments, snapshots, toolUseResult: not counted

  const m = o.message;
  if (!m || !Array.isArray(m.content)) return;
  // Lines before the window still register tool calls and the session start; only results inside it are counted.
  const inWindow = !(r.since && typeof o.timestamp === 'string' && Date.parse(o.timestamp) < r.since);

  if (o.type === 'assistant') {
    if (!st.isSubagent && !st.sawFirstUsage && m.usage && typeof m.usage === 'object') {
      const u = m.usage;
      const total = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
      if (total > 0) { // all-zero usage = synthetic error message, not a real first turn
        st.sawFirstUsage = true;
        st.firstUsageTokens = total;
        if (inWindow) { r.startCtx.push(total); st.pushedStartCtx = true; }
      }
    }
    for (const b of m.content) {
      if (!b || typeof b.type !== 'string') continue;
      if (!KNOWN_BLOCKS.has(b.type)) { unknownBlock(r, b.type, inWindow); continue; }
      if (b.type === 'tool_use' && typeof b.id === 'string') st.uses.set(b.id, { name: b.name, input: b.input });
    }
    return;
  }

  for (const b of m.content) {
    if (!b || typeof b.type !== 'string') continue;
    if (!KNOWN_BLOCKS.has(b.type)) { unknownBlock(r, b.type, inWindow); continue; }
    if (b.type !== 'tool_result') continue;
    const use = st.uses.get(b.tool_use_id);
    if (!use) { if (inWindow) r.unpaired++; continue; }
    st.uses.delete(b.tool_use_id);
    const duplicate = r.counted.has(b.tool_use_id);
    r.counted.add(b.tool_use_id);

    const { chars, images, refs, hash, complete } = resultText(b.content, type => unknownBlock(r, type, inWindow && !duplicate));
    // Restore each context's read history even for copied results or results before the window.
    const fp = use.name === 'Read' && use.input && typeof use.input.file_path === 'string' ? use.input.file_path : null;
    const readKey = fp && !b.is_error && complete && chars > 0 && !images
      ? [fp, num(use.input.offset), num(use.input.limit)].join('|') : null;
    const reread = !!readKey && st.reads.get(readKey) === hash; // same range, identical text: nothing changed
    if (readKey) st.reads.set(readKey, hash);
    if (readKey && st.sessionKey) {
      const t = parseTsMs(o.timestamp);
      if (!st.isSubagent) {
        if (Number.isFinite(t)) {
          const kk = st.sessionKey + '\n' + readKey + '\n' + hash;
          if (!(r.mainFirst.get(kk) <= t)) r.mainFirst.set(kk, t);
        }
      } else if (inWindow) {
        const cand = { sk: st.sessionKey, k: readKey, h: hash, t, chars, fp };
        const cur = r.subById.get(b.tool_use_id);
        if (!cur || cand.t < cur.t || (cand.t === cur.t && cand.sk < cur.sk)) r.subById.set(b.tool_use_id, cand);
      }
    }
    if (!inWindow || duplicate) continue; // copied history updates state but is only measured once

    r.images += images;
    r.toolReferences += refs;
    r.results++;
    r.textChars += chars;
    const g = toolGroup(use.name);
    const t = r.byTool.get(g) || { calls: 0, chars: 0 };
    t.calls++; t.chars += chars;
    r.byTool.set(g, t);
    pushTop(r.top, { label: resultLabel(use.name, use.input, !!b.is_error), chars });

    if (reread) {
      r.rereads.count++; r.rereads.chars += chars;
      const lbl = fileLabel(fp);
      r.rereads.files.set(lbl, (r.rereads.files.get(lbl) || 0) + 1);
    }
    if (reread || chars >= BIG) r.flaggedChars += chars; // each result counted once
  }
}

// Convenience for tests: analyze in-memory files.
function feedEnd(r, st) {
  if (st.isSubagent || !st.pushedStartCtx || !st.firstReq || typeof st.firstReq.hash !== 'string') return;
  const m = st.shapes.get(st.firstReq.hash);
  if (m) r.splitParts.push({ ...m, firstTokens: st.firstUsageTokens });
}

function analyze(files, opts) {
  const r = newReport(opts);
  for (const f of files) {
    const st = newFileState(!!f.subagent, typeof f.sessionKey === 'string' ? f.sessionKey : null);
    r.files++; f.subagent ? r.subagentFiles++ : r.sessions++;
    for (const line of f.lines) feedLine(r, st, line);
    feedEnd(r, st);
  }
  return summarize(r);
}

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), h = s.length >> 1;
  return s.length % 2 ? s[h] : Math.round((s[h - 1] + s[h]) / 2);
}

// Static, pre-checked advice only. Any tip that pipes into tail/head must keep pipefail.
function tips(s) {
  const out = [];
  const bash = s.byTool.find(t => t.tool === 'Bash');
  const read = s.byTool.find(t => t.tool === 'Read');
  if (bash && bash.pct >= 20) out.push('Bash output is a big share. Prefer quiet runners (pytest -q, vitest --reporter=dot). ' +
    'If you pipe, keep the exit code: set -o pipefail; npm test 2>&1 | tail -50');
  if (read && read.pct >= 20) out.push('Read output is a big share. Ask for line ranges (Read with offset/limit) instead of whole files.');
  if (s.rereads.count) out.push('Unchanged files were re-read. Put the key facts in CLAUDE.md or point Claude at exact lines.');
  if (s.rereads.subagent?.count >= 2 && s.rereads.subagent.chars >= BIG && s.rereads.subagent.chars * 10 >= s.rereads.subagent.readChars * 3)
    out.push('Subagents re-read files the main session already had. Pass the key facts in the subagent prompt instead of letting them re-read shared files.');
  if (s.byTool.some(t => t.tool.startsWith('mcp:') && t.pct >= 10)) out.push('An MCP server returns a lot of text. /usage shows its share; turn off unused servers with /mcp.');
  if (s.startingContext.medianTokens) out.push('First-request input includes your message. Use /context to inspect CLAUDE.md, MCP and skill sizes.');
  return out;
}

function summarize(r) {
  const pct = n => r.textChars ? Math.round((n / r.textChars) * 1000) / 10 : null;
  const round = Math.round;
  let subN = 0, subC = 0, subRead = 0;
  const subF = new Map();
  for (const sub of r.subById.values()) {
    subRead += sub.chars;
    const mt = r.mainFirst.get(sub.sk + '\n' + sub.k + '\n' + sub.h);
    if (Number.isFinite(sub.t) && mt !== undefined && mt < sub.t) {
      subN++; subC += sub.chars;
      const l = fileLabel(sub.fp);
      subF.set(l, (subF.get(l) || 0) + 1);
    }
  }
  const lt = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const subagent = { count: subN, chars: subC, readChars: subRead,
    files: [...subF].map(([file, count]) => ({ file, count })).sort((a, b) => b.count - a.count || lt(a.file, b.file)).slice(0, 5) };
  const split = !r.splitParts.length ? null : {
    sessions: r.splitParts.length,
    systemChars: median(r.splitParts.map(p => p.sysC)),
    toolsChars: median(r.splitParts.map(p => p.toolC)),
    toolCount: median(r.splitParts.map(p => p.count)),
    systemTokens: median(r.splitParts.map(p => round(p.sysC / 3))),
    toolsTokens: median(r.splitParts.map(p => round(p.toolC / 3))),
    toolsBuiltinTokens: median(r.splitParts.map(p => round(p.builtinC / 3))),
    toolsMcpTokens: median(r.splitParts.map(p => round(p.mcpC / 3))),
    restTokens: median(r.splitParts.map(p => Math.max(0, round(p.firstTokens - (p.sysC + p.toolC) / 3)))),
  };
  const s = {
    schemaVersion: SCHEMA_VERSION,
    toolVersion: VERSION,
    summary: {
      sessions: r.sessions, subagentFiles: r.subagentFiles, toolResults: r.results,
      textChars: r.textChars, flaggedChars: r.flaggedChars, flaggedPct: pct(r.flaggedChars), images: r.images,
      toolReferences: r.toolReferences,
    },
    byTool: [...r.byTool].map(([tool, v]) => ({ tool, calls: v.calls, chars: v.chars, pct: pct(v.chars) }))
      .sort((a, b) => b.chars - a.chars),
    top: r.top,
    rereads: { count: r.rereads.count, chars: r.rereads.chars,
      files: [...r.rereads.files].map(([file, count]) => ({ file, count })).sort((a, b) => b.count - a.count).slice(0, 5),
      subagent },
    startingContext: { medianTokens: median(r.startCtx), sessions: r.startCtx.length, split },
    meta: {
      node: process.version, platform: process.platform,
      claudeCodeVersions: r.ccMin ? [r.ccMin, r.ccMax] : null,
      files: r.files, skippedFiles: r.skippedFiles, skippedDirectories: r.skippedDirectories, lines: r.lines, badLines: r.badLines,
      oversizeLines: r.oversizeLines, unpairedToolResults: r.unpaired, unknownBlockTypes: r.unknownBlocks,
    },
  };
  s.tips = tips(s);
  s.meta.suspect = r.unpaired > r.results * 0.1 || Object.keys(r.unknownBlocks).length > 0 ||
    r.skippedFiles > 0 || r.skippedDirectories > 0;
  return s;
}

// ---------- file reading ----------

// Streams lines without ever holding more than MAX_LINE chars; yields null for an oversized line.
// Reads only up to the size seen at open, so a session being written right now is a stable snapshot.
async function* readLines(file, size) {
  if (!size) return;
  const dec = new StringDecoder('utf8');
  let buf = '', over = false, first = true;
  const emit = l => {
    if (first) { first = false; if (l.charCodeAt(0) === 0xfeff) l = l.slice(1); }
    return l.endsWith('\r') ? l.slice(0, -1) : l;
  };
  for await (const chunk of fs.createReadStream(file, { end: size - 1 })) {
    let s = dec.write(chunk), i;
    while ((i = s.indexOf('\n')) !== -1) {
      const part = s.slice(0, i);
      s = s.slice(i + 1);
      if (over || buf.length + part.length > MAX_LINE) { over = false; buf = ''; yield null; continue; }
      yield emit(buf + part);
      buf = '';
    }
    if (over) continue;
    buf += s;
    if (buf.length > MAX_LINE) { over = true; buf = ''; }
  }
  const rest = buf + dec.end();
  if (over || rest.length > MAX_LINE) yield null;
  else if (rest) yield emit(rest); // last line without newline (may be half-written: then it is just a bad line)
}

function findFiles(dir, onUnreadable, depth = 0, out = []) {
  if (depth > 4) return out;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    if (depth === 0) throw e;
    onUnreadable();
    return out;
  }
  for (const e of ents) {
    if (e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(p, onUnreadable, depth + 1, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// ---------- output ----------

const k = n => n >= 999500 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);

function render(s, days, tty) {
  const b = x => tty ? `\x1b[1m${x}\x1b[0m` : x;
  const dim = x => tty ? `\x1b[2m${x}\x1b[0m` : x;
  const L = [];
  const sm = s.summary;
  L.push(b(`ctx-autopsy`) + dim(`  last ${days} days · ${sm.sessions} sessions · ${sm.subagentFiles} subagent log${sm.subagentFiles === 1 ? '' : 's'} · ${sm.toolResults} tool results`));
  L.push('');
  if (!sm.textChars) {
    L.push(sm.toolResults ? 'Tool results in this period contain no text.' : 'No tool results found in this period.');
  } else {
    L.push(b(`${sm.flaggedPct}% of tool-output text came from oversized results (>=${k(BIG)} chars) and re-reads`));
    L.push(dim(`  ${k(sm.flaggedChars)} of ${k(sm.textChars)} chars · roughly ${k(Math.round(sm.flaggedChars / 3))} tokens (±50%)`));
    L.push('');
    L.push(b('By tool'));
    const w = Math.max(...s.byTool.slice(0, 8).map(t => t.tool.length), 4);
    for (const t of s.byTool.slice(0, 8)) {
      const bar = '█'.repeat(Math.max(1, Math.round(t.pct / 4)));
      L.push(`  ${t.tool.padEnd(w)}  ${String(t.pct).padStart(5)}%  ${bar} ${dim(`${k(t.chars)} chars · ${t.calls} call${t.calls === 1 ? "" : "s"}`)}`);
    }
    L.push('');
    L.push(b('Largest single results'));
    for (const t of s.top.slice(0, 5)) L.push(`  ${k(t.chars).padStart(6)}  ${t.label}`);
    if (s.rereads.count) {
      L.push('');
      L.push(b(`Re-reads of unchanged files: ${s.rereads.count}`) + dim(` (${k(s.rereads.chars)} chars)`));
      for (const f of s.rereads.files) L.push(`  ${String(f.count).padStart(4)}x  ${f.file}`);
    }
    if (s.rereads.subagent.count > 0) {
      const n = s.rereads.subagent.count, chars = s.rereads.subagent.chars;
      L.push('', b(`Subagent re-reads of main-session files: ${n}`) + dim(` (${k(chars)} chars)`));
      for (const f of s.rereads.subagent.files) L.push(`  ${String(f.count).padStart(4)}x  ${f.file}`);
    }
  }
  if (sm.images) L.push('', dim(`Images/PDFs in tool results: ${sm.images} (not counted above)`));
  if (sm.toolReferences && !sm.images) L.push('');
  if (sm.toolReferences) L.push(dim(`Tool definitions loaded by tool search: ${sm.toolReferences} (size not in logs, not counted above)`));
  if (s.startingContext.medianTokens) {
    L.push(dim(`First-request input: median ${k(s.startingContext.medianTokens)} tokens over ${s.startingContext.sessions} sessions (includes your message)`));
    const split = s.startingContext.split;
    if (split) {
      const n = split.sessions;
      L.push(dim(`  first-request split (2.1.310+, ${n} session${n === 1 ? '' : 's'}): system ~${k(split.systemTokens)} · tools ~${k(split.toolsTokens)} (builtin ~${k(split.toolsBuiltinTokens)} · mcp ~${k(split.toolsMcpTokens)}) · rest ~${k(split.restTokens)} tokens (±50%)`));
    }
  }
  if (s.tips.length) {
    L.push('', b('Try'));
    for (const t of s.tips) L.push(`  - ${t}`);
  }
  const m = s.meta;
  L.push('', dim(`Parsed ${m.lines} lines in ${m.files} files` +
    (m.claudeCodeVersions ? ` · Claude Code ${m.claudeCodeVersions.join('–')}` : '') +
    ` · bad ${m.badLines} · oversize ${m.oversizeLines} · unpaired ${m.unpairedToolResults}` +
    (m.skippedFiles ? ` · unreadable files ${m.skippedFiles}` : '') +
    (m.skippedDirectories ? ` · unreadable directories ${m.skippedDirectories}` : '')));
  if (m.suspect) L.push('⚠ Some log data could not be analyzed; numbers may be incomplete or unreliable. To report it, paste only the "meta" block of: npx ctx-autopsy --json');
  return L.join('\n');
}

// ---------- main ----------

const USAGE = `Usage: ctx-autopsy [--days N] [--json]
  --days N   look back N days (default 30)
  --json     machine-readable output (file names without folders, no session content)
Reads $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects. Never writes files, never uses the network.`;

async function main(argv) {
  let a;
  try {
    a = parseArgs({ args: argv, options: { days: { type: 'string' }, json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } } }).values;
  } catch (e) { process.stderr.write(`ctx-autopsy: ${e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? 'unknown option' : 'bad arguments'}\n${USAGE}\n`); return 2; }
  if (a.help) { process.stdout.write(USAGE + '\n'); return 0; }
  if (a.version) { process.stdout.write(VERSION + '\n'); return 0; }
  const days = a.days === undefined ? 30 : Number(a.days);
  if (!Number.isInteger(days) || days <= 0) { process.stderr.write(`ctx-autopsy: --days must be a positive integer\n`); return 2; }

  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  if (!fs.existsSync(root)) {
    process.stderr.write('ctx-autopsy: no Claude Code session folder found. If you use a custom location, set CLAUDE_CONFIG_DIR.\n');
    return 1;
  }

  const since = Date.now() - days * 864e5;
  const r = newReport({ since });
  let files;
  try { files = findFiles(root, () => { r.skippedDirectories++; }); }
  catch {
    process.stderr.write('ctx-autopsy: cannot read Claude Code session folder. Check its location and access permissions.\n');
    return 1;
  }
  for (const f of files) {
    let size;
    try { const st = fs.statSync(f); if (st.mtimeMs < since) continue; size = st.size; } catch { r.skippedFiles++; continue; }
    const segs = path.relative(root, f).split(path.sep);
    const sub = segs.includes('subagents');
    let sessionKey = null;
    if (!sub) {
      const rel = segs.join('/');
      sessionKey = rel.endsWith('.jsonl') ? rel.slice(0, -'.jsonl'.length) : rel;
    } else {
      const head = segs.slice(0, segs.indexOf('subagents'));
      if (head.length >= 2) sessionKey = head.join('/');
    }
    const st = newFileState(sub, sessionKey);
    try {
      for await (const line of readLines(f, size)) feedLine(r, st, line);
      feedEnd(r, st);
      r.files++; sub ? r.subagentFiles++ : r.sessions++;
    } catch { r.skippedFiles++; } // EBUSY/EACCES etc: skip this file only
  }
  const s = summarize(r);
  process.stdout.write((a.json ? JSON.stringify(s, null, 2) : render(s, days, process.stdout.isTTY)) + '\n');
  return 0;
}

module.exports = { analyze, bashLabel, fileLabel, readLines, main, render, tips };

if (require.main === module) {
  process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); });
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => {
    process.stderr.write(`ctx-autopsy: internal error (${e && (e.code || e.name)})\n`);
    if (process.env.DEBUG) process.stderr.write(String(e && e.stack) + '\n');
    process.exitCode = 1;
  });
}
