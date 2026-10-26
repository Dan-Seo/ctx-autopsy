'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { analyze, bashLabel, readLines } = require('./cli.js');

const FIX = path.join(__dirname, 'fixtures');
const run = (args, env = {}) => spawnSync(process.execPath, [path.join(__dirname, 'cli.js'), ...args],
  { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: FIX, ...env } });

async function loadFixtures() {
  const dir = path.join(FIX, 'projects', 'C--work-demo-shop');
  const files = [];
  for (const [rel, subagent] of [['sess-a.jsonl', false], ['sess-b.jsonl', false], ['sess-a/subagents/agent-1.jsonl', true]]) {
    const p = path.join(dir, rel), lines = [];
    for await (const l of readLines(p, fs.statSync(p).size)) lines.push(l);
    files.push({ lines, subagent });
  }
  return files;
}

test('fixture numbers', async () => {
  const s = analyze(await loadFixtures());
  assert.strictEqual(s.summary.sessions, 2);
  assert.strictEqual(s.summary.subagentFiles, 1, 'subagent logs are their own context, not duplicates');
  assert.strictEqual(s.summary.images, 1, 'image counted, base64 not');
  assert.strictEqual(s.rereads.count, 2, 'checkout.ts once (before compact) + pricing.ts; edit-then-read is not a re-read');
  assert.deepStrictEqual(s.rereads.files.map(f => f.file).sort(), ['checkout.ts', 'pricing.ts']);
  assert.strictEqual(s.meta.badLines, 1);
  assert.strictEqual(s.meta.unpairedToolResults, 0);
  assert.strictEqual(s.meta.suspect, false);
  assert.strictEqual(s.startingContext.medianTokens, 60704, 'mean of the two middle values');
  assert.ok(s.summary.textChars < 300000, 'prompt_snapshot and toolUseResult.originalFile are not counted');
  assert.ok(s.summary.flaggedPct > 0 && s.summary.flaggedPct <= 100);
});

test('no secrets, user names or paths in any output', () => {
  for (const args of [['--days', '36500'], ['--days', '36500', '--json']]) {
    const r = run(args);
    assert.strictEqual(r.status, 0);
    const all = r.stdout + r.stderr;
    for (const bad of ['sk-ant-TESTSECRET', 'Bearer', 'Alice', 'AcmeCorp', 'CANARY_7f3', '/work/demo-shop', 'C--work']) {
      assert.ok(!all.includes(bad), `leaked ${bad} with ${args.join(' ')}`);
    }
  }
});

test('exit codes', () => {
  assert.strictEqual(run(['--days', 'abc']).status, 2);
  assert.strictEqual(run(['--days', '0']).status, 2);
  assert.strictEqual(run(['--nope']).status, 2);
  assert.strictEqual(run([], { CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'ctx-autopsy-missing-dir') }).status, 1);
  const r = run(['--days', '1']); // fixtures are older than a day: empty but fine
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /No tool results/);
});

test('json is a single valid document with schemaVersion', () => {
  const j = JSON.parse(run(['--days', '36500', '--json']).stdout);
  assert.strictEqual(j.schemaVersion, 1);
  assert.ok(Array.isArray(j.byTool));
});

test('tips that pipe into tail/head keep the exit code', async () => {
  const s = analyze(await loadFixtures());
  assert.ok(s.tips.length > 0);
  for (const t of s.tips) if (/\|\s*(tail|head)/.test(t)) assert.match(t, /pipefail/);
});

test('readLines: BOM, CRLF, missing last newline, oversized line', async () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctxa-')), 'x.jsonl');
  fs.writeFileSync(p, '﻿{"a":1}\r\n' + 'x'.repeat(5 * 1024 * 1024) + '\n{"b":2}\r\n{"c":3}');
  const out = [];
  for await (const l of readLines(p, fs.statSync(p).size)) out.push(l);
  assert.deepStrictEqual(out, ['{"a":1}', null, '{"b":2}', '{"c":3}']);
});

test('unknown content blocks or unpaired results each mark the report suspect; a quiet log does not', () => {
  const pair = [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] } })];
  const unknown = analyze([{ lines: [...pair, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'brand_new_block' }] } })] }]);
  assert.strictEqual(unknown.meta.suspect, true);
  const unpaired = analyze([{ lines: [...pair, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'nope', content: 'x' }] } })] }]);
  assert.strictEqual(unpaired.meta.suspect, true);
  assert.strictEqual(unpaired.meta.unpairedToolResults, 1);
  const textOnly = analyze([{ lines: [JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })] }]);
  assert.strictEqual(textOnly.meta.suspect, false);
});

test('bashLabel shows only the command, never arguments', () => {
  assert.strictEqual(bashLabel('cd /secret/dir && FOO=1 npm test -- --grep x'), 'npm test');
  assert.strictEqual(bashLabel('curl -H "Authorization: Bearer sk-x" https://h'), 'curl');
  assert.strictEqual(bashLabel('/usr/local/bin/python3 /home/alice/run.py'), 'python3');
  assert.strictEqual(bashLabel(''), 'bash');
});

test('cli.js has no network or process-spawning code', () => {
  const src = fs.readFileSync(path.join(__dirname, 'cli.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"](node:)?(https?|http2|net|dgram|child_process|tls|worker_threads)['"]\)|\bfetch\(|\bimport\(/);
});

// ---- regressions from pre-release review ----
const U = (id, name, input, extra = {}) => ({ type: 'assistant', ...extra, message: { content: [{ type: 'tool_use', id, name, input }] } });
const R = (id, content, extra = {}, line = {}) => ({ type: 'user', ...line, message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] } });
const A = (rows, opts) => analyze([{ lines: rows.map(r => JSON.stringify(r)) }], opts);

test('bashLabel never shows plain arguments, quoted paths or hostnames', () => {
  assert.strictEqual(bashLabel('echo launchcode123'), 'echo');
  assert.strictEqual(bashLabel('echo hunter2 | sudo -S reboot'), 'echo');
  assert.strictEqual(bashLabel('ssh prod-db-acmecorp'), 'ssh');
  assert.strictEqual(bashLabel('cat salaries'), 'cat');
  assert.strictEqual(bashLabel(String.raw`"C:\Users\DongWan SEO\venv\Scripts\python.exe" x.py`), 'python');
  assert.strictEqual(bashLabel('"/Users/Alice Smith/bin/run" --x'), 'run');
  assert.strictEqual(bashLabel("'/home/bob smith/x.sh'"), 'x.sh');
  assert.strictEqual(bashLabel('git status'), 'git status');
  assert.strictEqual(bashLabel('npx acme-private-cli --x'), 'npx', 'package runner names can be private');
});

test('ordinary file names are not over-redacted', async () => {
  const { fileLabel } = require('./cli.js');
  for (const f of ['task-queue.ts', 'risk-model.py', 'disk-usage.md']) assert.strictEqual(fileLabel('/x/' + f), f);
  assert.strictEqual(fileLabel('/x/sk-proj-abc'), '<redacted>');
});

test('non-numeric usage never reaches output', () => {
  const row = U('b', 'Bash', { command: 'true' });
  row.message.usage = { input_tokens: 'CANARY_START_SECRET', cache_read_input_tokens: 5, cache_creation_input_tokens: 0 };
  const s = A([row, R('b', 'ok')]);
  assert.strictEqual(s.startingContext.medianTokens, 5);
  assert.ok(!JSON.stringify(s).includes('CANARY'));
});

test('all-zero (synthetic) usage is not a session start', () => {
  const z = U('a', 'Bash', { command: 'true' }); z.message.usage = { input_tokens: 0 };
  const real = U('b', 'Bash', { command: 'true' }); real.message.usage = { input_tokens: 10, cache_read_input_tokens: 990 };
  assert.strictEqual(A([z, R('a', 'x'), real, R('b', 'y')]).startingContext.medianTokens, 1000);
});

test('re-read requires identical content; failed reads and changed files do not count', () => {
  const f = { file_path: '/w/a.txt' };
  const changed = A([U('r1', 'Read', f), R('r1', 'version-one'), U('b', 'Bash', { command: 'printf x > /w/a.txt' }), R('b', ''),
    U('r2', 'Read', f), R('r2', 'version-two')]);
  assert.strictEqual(changed.rereads.count, 0);
  const failedFirst = A([U('r1', 'Read', f), R('r1', 'Permission denied', { is_error: true }), U('r2', 'Read', f), R('r2', 'ok')]);
  assert.strictEqual(failedFirst.rereads.count, 0);
  const failedEdit = A([U('r1', 'Read', f), R('r1', 'same'), U('e', 'Edit', { ...f, old_string: 'x', new_string: 'y' }),
    R('e', 'String to replace not found', { is_error: true }), U('r2', 'Read', f), R('r2', 'same')]);
  assert.strictEqual(failedEdit.rereads.count, 1);
  const nb = { file_path: '/w/n.ipynb' };
  const notebook = A([U('r1', 'Read', nb), R('r1', 'old'), U('e', 'NotebookEdit', { notebook_path: '/w/n.ipynb' }), R('e', 'ok'),
    U('r2', 'Read', nb), R('r2', 'new')]);
  assert.strictEqual(notebook.rereads.count, 0);
});

test('--days window: calls before the window still pair, session start is the real first turn', () => {
  const since = Date.parse('2026-10-20T09:00:00Z');
  const first = U('a', 'Bash', { command: 'ls' }, { timestamp: '2026-10-20T08:00:00Z' });
  first.message.usage = { input_tokens: 1000 };
  const call = U('b', 'Bash', { command: 'npm test' }, { timestamp: '2026-10-20T08:59:59Z' });
  call.message.usage = { input_tokens: 100000 };
  const s = A([first, R('a', 'x', {}, { timestamp: '2026-10-20T08:00:01Z' }), call,
    R('b', 'x'.repeat(30000), {}, { timestamp: '2026-10-20T09:00:01Z' })], { since });
  assert.strictEqual(s.summary.toolResults, 1);
  assert.strictEqual(s.summary.textChars, 30000);
  assert.strictEqual(s.meta.unpairedToolResults, 0);
  assert.strictEqual(s.meta.suspect, false);
  assert.strictEqual(s.startingContext.medianTokens, null, 'session started before the window');
});

test('readLines caps a long line regardless of where it starts in a chunk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxa-'));
  for (const pad of [0, 65534, 65535]) {
    const p = path.join(dir, `o${pad}.jsonl`);
    const head = pad ? 'p'.repeat(pad - 1) + '\n' : '';
    fs.writeFileSync(p, head + 'x'.repeat(4 * 1024 * 1024 + 1) + '\n{"ok":1}\n');
    const out = [];
    for await (const l of readLines(p, fs.statSync(p).size)) out.push(l);
    assert.deepStrictEqual(out.slice(-2), [null, '{"ok":1}'], `pad ${pad}`);
  }
});

test('nothing to measure prints a message, not null%', () => {
  const r = run(['--days', '36500'], { CLAUDE_CONFIG_DIR: (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxa-'));
    fs.mkdirSync(path.join(d, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(d, 'projects', 'p', 's.jsonl'),
      [U('b', 'Bash', { command: 'true' }), R('b', '')].map(x => JSON.stringify(x)).join('\n') + '\n');
    return d;
  })() });
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /null/);
});

test('a config dir under a folder named "subagents" still finds main sessions', () => {
  const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctxa-')), 'subagents', 'cfg');
  fs.mkdirSync(path.join(d, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(d, 'projects', 'p', 's.jsonl'), JSON.stringify(R('x', 'y')) + '\n');
  const j = JSON.parse(run(['--days', '36500', '--json'], { CLAUDE_CONFIG_DIR: d }).stdout);
  assert.strictEqual(j.summary.sessions, 1);
});

test('env-var prefixes never leak into the label', () => {
  assert.strictEqual(bashLabel('GIT_AUTHOR_NAME="Jane Doe" git commit -m wip'), 'git commit');
  assert.strictEqual(bashLabel("PGPASSWORD='hunter2 Zq9xLmT4' psql -h db.internal"), 'psql');
  assert.strictEqual(bashLabel('API_KEY="abc 9f8e7d6c5b4a" ./deploy.sh'), 'deploy.sh');
  assert.strictEqual(bashLabel('FOO="a b" BAR=1 npm test'), 'npm test');
  assert.strictEqual(bashLabel('DIR=/home/alice'), 'bash');
  assert.strictEqual(bashLabel(String.raw`PROJ=C:\Users\jdoe`), 'bash');
  assert.strictEqual(bashLabel('make deploy-acmecorp-prod'), 'make');
});

test('bashLabel stays fast on pathological input', () => {
  const t0 = process.hrtime.bigint();
  bashLabel('='.repeat(300000)); bashLabel('a=='.repeat(20000)); bashLabel('x='.repeat(32000));
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 500);
});

test('failed reads of folders show no folder or host name', () => {
  for (const p of [String.raw`C:\Users\jdoe\ `.trim(), '/home/alice/', String.raw`\\fileserver.corp.example.com`]) {
    const s = A([U('r', 'Read', { file_path: p }), R('r', 'EISDIR: illegal operation on a directory, read', { is_error: true })]);
    assert.strictEqual(s.top[0].label, 'Read', p);
  }
  const { fileLabel } = require('./cli.js');
  assert.strictEqual(fileLabel('/home/alice/'), '?');
  assert.strictEqual(fileLabel(String.raw`C:\Users\jdoe\ `.trim()), '?');
});

test('identical failed reads are not re-reads', () => {
  const f = { file_path: '/w/missing.ts' };
  assert.strictEqual(A([U('a', 'Read', f), R('a', 'File does not exist.', { is_error: true }),
    U('b', 'Read', f), R('b', 'File does not exist.', { is_error: true })]).rereads.count, 0);
});

test('block types named like Object.prototype members are counted safely', () => {
  const s = A([{ type: 'assistant', message: { content: [{ type: 'constructor' }, { type: '__proto__' }, { type: 'hasOwnProperty' }] } }]);
  assert.strictEqual(JSON.stringify(s.meta.unknownBlockTypes), '{"constructor":1,"__proto__":1,"hasOwnProperty":1}');
  assert.strictEqual(s.meta.suspect, true);
});

test('a strange but valid record skips one line, not the rest of the file', () => {
  const s = A([U('a', 'Bash', { command: 'npm test' }), R('a', 'x'.repeat(100)),
    { type: 'user', timestamp: { toString: 1 }, message: { content: [] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: { toString: 1 }, input: { command: { toString: 1 } } }] } },
    R('b', 'y'), U('c', 'Bash', { command: 'npm run build' }), R('c', 'z'.repeat(50000))], { since: 1 });
  assert.strictEqual(s.summary.textChars, 50101);
  assert.strictEqual(s.summary.toolResults, 3);
});

test('history copied into a resumed session is counted once', () => {
  const a = [U('t1', 'Bash', { command: 'npm test' }), R('t1', 'x'.repeat(30000))].map(x => JSON.stringify(x));
  const b = [...a, ...[U('t2', 'Bash', { command: 'git status' }), R('t2', 'y'.repeat(100))].map(x => JSON.stringify(x))];
  const s = analyze([{ lines: a }, { lines: b }]);
  assert.strictEqual(s.summary.textChars, 30100);
  assert.strictEqual(s.summary.toolResults, 2);
});

test('MCP servers with long or secret-sounding names keep the mcp: prefix and trigger the tip', () => {
  const s = A([U('a', 'mcp__plugin_corporate-legal_Solve_Intelligence_extra_long_name__search', {}), R('a', 'x'.repeat(5000)),
    U('b', 'mcp__token_vault__get', {}), R('b', 'y'.repeat(5000)), U('c', 'Bash', { command: 'ls' }), R('c', 'z')]);
  assert.ok(s.byTool.every(t => t.tool === 'Bash' || t.tool.startsWith('mcp:')));
  assert.ok(s.tips.some(t => t.includes('MCP')));
});
