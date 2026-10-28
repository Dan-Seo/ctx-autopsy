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

test('Bash labels keep quoted and escaped separators inside their words', () => {
  for (const command of [
    'cd "/work/client;CANARY_7f3;repo" && npm test',
    "cd '/work/client|CANARY_7f3|repo' && npm test",
    'cd "/work/client\nCANARY_7f3\nrepo" && npm test',
    String.raw`cd /work/client\;CANARY_7f3\;repo && npm test`,
    String.raw`FOO=hello\ CANARY_7f3 npm test`,
    'FOO=hello\u00a0CANARY_7f3 npm test',
    'cd /work # ;CANARY_7f3;\nnpm test',
  ]) {
    assert.strictEqual(bashLabel(command), 'npm test', command);
  }
  for (const command of [
    'FOO=$(printf CANARY_7f3 more) npm test',
    'FOO=`printf CANARY_7f3 more` npm test',
    'cd /work <<EOF\nCANARY_7f3\nEOF\nnpm test',
    'cd "/work/client;CANARY_7f3;repo',
    '"FOO=bar" CANARY_7f3',
  ]) assert.strictEqual(bashLabel(command), 'bash', command);
});

test('Bash labels allow only public subcommands, never arbitrary script names', () => {
  for (const command of ['yarn acme-private-deploy', 'bun acme-deploy', 'git acme-internal', 'npm acme-internal']) {
    const program = command.split(' ')[0];
    assert.strictEqual(bashLabel(command), program);
    const s = A([U('b', 'Bash', { command }), R('b', 'x'.repeat(25000))]);
    assert.strictEqual(s.top[0].label, 'Bash  ' + program);
  }
  for (const command of ['npm test', 'git status', 'cargo test', 'docker compose', 'bun run']) {
    assert.strictEqual(bashLabel(command), command);
  }
});

test('copied history restores read state without making totals depend on file order', () => {
  const f = { file_path: '/work/a.ts' };
  const original = [U('r1', 'Read', f), R('r1', 'same')];
  const resumed = [...original, U('r2', 'Read', f), R('r2', 'same')];
  for (const rows of [[original, resumed], [resumed, original]]) {
    const s = analyze(rows.map(lines => ({ lines: lines.map(JSON.stringify) })));
    assert.strictEqual(s.summary.toolResults, 2);
    assert.strictEqual(s.summary.textChars, 8);
    assert.strictEqual(s.rereads.count, 1);
    assert.strictEqual(s.summary.flaggedChars, 4);
  }
  const compacted = [...original, { type: 'system', subtype: 'compact_boundary' }, U('r3', 'Read', f), R('r3', 'same')];
  const s = analyze([original, compacted].map(lines => ({ lines: lines.map(JSON.stringify) })));
  assert.strictEqual(s.rereads.count, 0, 'a copied read must still expire at compaction');
  const changed = [...original, U('r4', 'Read', f), R('r4', 'changed')];
  assert.strictEqual(analyze([original, changed].map(lines => ({ lines: lines.map(JSON.stringify) }))).rereads.count, 0);
  const failed = [U('err', 'Read', f), R('err', 'same', { is_error: true })];
  const afterFailure = [...failed, U('ok', 'Read', f), R('ok', 'same')];
  assert.strictEqual(analyze([failed, afterFailure].map(lines => ({ lines: lines.map(JSON.stringify) }))).rereads.count, 0);
  const old = original.map(row => ({ ...row, timestamp: '2020-01-01T00:00:00Z' }));
  const recent = [...old, ...resumed.slice(-2).map(row => ({ ...row, timestamp: '2026-10-20T00:00:00Z' }))];
  for (const rows of [[old, recent], [recent, old]]) {
    const report = analyze(rows.map(lines => ({ lines: lines.map(JSON.stringify) })), { since: Date.parse('2026-01-01T00:00:00Z') });
    assert.strictEqual(report.summary.toolResults, 1);
    assert.strictEqual(report.rereads.count, 1);
  }
});

test('structured search text is measured, and unknown nested blocks mark incomplete results', () => {
  const search = { type: 'search_result', source: 'https://example.com', title: 'Result',
    content: [{ type: 'text', text: 'x'.repeat(25000) }] };
  const measured = A([U('a', 'mcp__demo__search', {}), R('a', [search])]);
  assert.strictEqual(measured.summary.textChars, 25000);
  assert.strictEqual(measured.summary.flaggedChars, 25000);
  assert.strictEqual(measured.meta.suspect, false);
  const unknown = A([U('a', 'mcp__demo__search', {}), R('a', [
    { type: 'text', text: 'known' }, { type: 'future_result', text: 'CANARY_7f3' },
    { ...search, content: [{ type: 'future_nested', text: 'CANARY_7f3' }] },
  ])]);
  assert.strictEqual(unknown.summary.textChars, 5);
  assert.strictEqual(unknown.meta.unknownBlockTypes.future_result, 1);
  assert.strictEqual(unknown.meta.unknownBlockTypes.future_nested, 1);
  assert.strictEqual(unknown.meta.suspect, true);
  assert.ok(!JSON.stringify(unknown).includes('CANARY_7f3'));
  const old = [U('old', 'Bash', {}), R('old', [{ type: 'future_result' }])]
    .map(row => ({ ...row, timestamp: '2020-01-01T00:00:00Z' }));
  assert.strictEqual(A(old, { since: Date.parse('2026-01-01T00:00:00Z') }).meta.suspect, false);
});

test('nested content handles media, malformed blocks and deep wrappers without leaking data', () => {
  const mixed = A([U('a', 'Bash', {}), R('a', [
    { type: 'text', text: 'known' },
    { type: 'image', source: { type: 'base64', data: 'CANARY_7f3' } },
    { type: 'document', source: { type: 'base64', data: 'CANARY_7f3' } },
  ])]);
  assert.strictEqual(mixed.summary.textChars, 5);
  assert.strictEqual(mixed.summary.images, 2);
  assert.strictEqual(mixed.meta.suspect, false);
  assert.ok(!JSON.stringify(mixed).includes('CANARY_7f3'));
  for (const content of [
    { text: 'CANARY_7f3' },
    [{ type: 'search_result', content: { text: 'CANARY_7f3' } }],
    [{ type: 'text', text: { private: 'CANARY_7f3' } }],
    [{ type: '/home/CANARY_7f3/data' }],
  ]) {
    const s = A([U('a', 'Bash', {}), R('a', content)]);
    assert.strictEqual(s.summary.textChars, 0);
    assert.strictEqual(s.meta.suspect, true);
    assert.ok(!JSON.stringify(s).includes('CANARY_7f3'));
  }
  const nested = '{"type":"search_result","content":['.repeat(12000) + '{"type":"text","text":"ok"}' + ']}'.repeat(12000);
  const deep = analyze([{ lines: [JSON.stringify(U('deep', 'Bash', {})),
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"deep","content":[' + nested + ']}]}}'] }]);
  assert.strictEqual(deep.summary.textChars, 2);
  assert.strictEqual(deep.meta.badLines, 0);
  const partial = [{ type: 'text', text: 'same' }, { type: 'future_result' }];
  const f = { file_path: '/work/a.ts' };
  assert.strictEqual(A([U('r1', 'Read', f), R('r1', partial), U('r2', 'Read', f), R('r2', partial)]).rereads.count, 0);
});

test('first-request input is not described as context before the user message', async () => {
  const r = run(['--days', '36500']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /First-request input:.*includes your message/);
  assert.doesNotMatch(r.stdout, /before your first message/i);
  const s = analyze(await loadFixtures());
  assert.strictEqual(s.startingContext.medianTokens, 60704, 'keep the existing JSON field and usage sum');
  assert.ok(s.tips.some(t => t.includes('includes your message')));
});

test('unreadable root fails; unreadable subdirectories produce an explicit partial report', () => {
  const runDenied = (relative, args) => spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs'), path = require('node:path');
    const { main } = require(process.argv[1]);
    const denied = path.resolve(process.env.CLAUDE_CONFIG_DIR, process.argv[2]);
    const read = fs.readdirSync;
    fs.readdirSync = function(dir, ...args) {
      if (path.resolve(dir) === denied) throw Object.assign(new Error('CANARY_7f3'), { code: 'EACCES' });
      return read.call(this, dir, ...args);
    };
    main(process.argv.slice(3)).then(code => { process.exitCode = code; });
  `, path.join(__dirname, 'cli.js'), relative, ...args],
  { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: FIX, DEBUG: '1' } });
  const root = runDenied('projects', ['--json']);
  assert.strictEqual(root.status, 1);
  assert.strictEqual(root.stdout, '');
  assert.match(root.stderr, /cannot read.*session folder/i);
  assert.ok(!root.stderr.includes('CANARY_7f3'));
  assert.ok(!root.stderr.includes(FIX), 'even DEBUG must not print the directory or error stack');
  const partial = runDenied('projects/C--work-demo-shop', ['--days', '36500', '--json']);
  assert.strictEqual(partial.status, 0);
  const s = JSON.parse(partial.stdout);
  assert.strictEqual(s.meta.skippedDirectories, 1);
  assert.strictEqual(s.meta.suspect, true);
  assert.ok(!partial.stdout.includes('CANARY_7f3'));
  const rendered = runDenied('projects/C--work-demo-shop', ['--days', '36500']);
  assert.match(rendered.stdout, /unreadable directories 1/);
  assert.match(rendered.stdout, /incomplete|unreliable/);
});

test('tool_reference blocks are counted, not measured, and stay out of output', () => {
  const dir = path.join(FIX, 'tool-search');
  const r = run(['--days', '36500', '--json'], { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.deepStrictEqual(j.meta.unknownBlockTypes, {});
  assert.strictEqual(j.meta.suspect, false);
  assert.strictEqual(j.summary.toolReferences, 2, 'the api-request-blob copy is not counted twice');
  assert.strictEqual(j.summary.toolResults, 2);
  const ts = j.byTool.find(t => t.tool === 'ToolSearch');
  assert.strictEqual(ts.calls, 1);
  assert.strictEqual(ts.chars, 0);
  assert.ok(!JSON.stringify(j).includes('CANARY_TS'));
  const t = run(['--days', '36500'], { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(t.status, 0);
  assert.match(t.stdout, /Tool definitions loaded by tool search: 2 \(size not in logs, not counted above\)/);
  assert.doesNotMatch(t.stdout, /⚠/);
  assert.ok(!t.stdout.includes('CANARY_TS'));
});

test('tool references are counted once across resumed history and only inside --days', () => {
  const ref = name => ({ type: 'tool_reference', tool_name: name });
  const a = [U('t1', 'ToolSearch', {}), R('t1', [ref('a'), ref('b')])].map(x => JSON.stringify(x));
  const b = [...a, ...[U('t2', 'ToolSearch', {}), R('t2', [ref('c')])].map(x => JSON.stringify(x))];
  const s = analyze([{ lines: a }, { lines: b }]);
  assert.strictEqual(s.summary.toolReferences, 3);
  assert.strictEqual(s.summary.toolResults, 2);
  assert.strictEqual(s.meta.suspect, false);
  const old = [U('o', 'ToolSearch', {}), R('o', [ref('old')])]
    .map(row => ({ ...row, timestamp: '2020-01-01T00:00:00Z' }));
  const w = A(old, { since: Date.parse('2026-01-01T00:00:00Z') });
  assert.strictEqual(w.summary.toolReferences, 0);
  assert.strictEqual(w.summary.toolResults, 0);
});

test('a top-level tool_reference block is still unknown', () => {
  for (const type of ['assistant', 'user']) {
    const s = A([{ type, message: { content: [{ type: 'tool_reference', tool_name: 'x' }] } }]);
    assert.strictEqual(s.meta.unknownBlockTypes.tool_reference, 1, type);
    assert.strictEqual(s.meta.suspect, true, type);
    assert.strictEqual(s.summary.toolReferences, 0, type);
  }
});

test('text mixed with tool_reference is measured and counted, nothing unknown', () => {
  const s = A([U('a', 'ToolSearch', {}), R('a', [{ type: 'text', text: 'hello' }, { type: 'tool_reference', tool_name: 't' }])]);
  assert.strictEqual(s.summary.textChars, 5);
  assert.strictEqual(s.summary.toolReferences, 1);
  assert.strictEqual(JSON.stringify(s.meta.unknownBlockTypes), '{}');
  assert.strictEqual(s.meta.suspect, false);
});

// ---- robustness regressions (ctx-pm 2026-10-28) ----
test('a top-level JSON array is a bad line like other non-record values', () => {
  const s = analyze([{ lines: ['[1,2]', '[]', '42', '"x"', 'null'] }]);
  assert.strictEqual(s.meta.badLines, 5);
});

test('unquoted backslash paths never mash server or folder names into the Bash label', () => {
  assert.strictEqual(bashLabel('\\\\fileserver\\share\\run.sh --x'), 'bash');
  assert.strictEqual(bashLabel('share\\dir\\run.sh --x'), 'bash');
  assert.strictEqual(bashLabel('"\\\\fileserver\\share\\run.sh" --x'), 'run.sh');
  assert.strictEqual(bashLabel('"C:\\Tools\\run.exe" --x'), 'run');
  const s = A([U('a', 'Bash', { command: '\\\\fileserver\\share\\run.sh --x' }), R('a', 'x'.repeat(25000))]);
  assert.strictEqual(s.top[0].label, 'Bash  bash');
});

test('a search_result with non-array content keeps its own invalid-content key', () => {
  const s = A([U('a', 'mcp__d__search', {}), R('a', [{ type: 'search_result', content: 'oops' }])]);
  assert.strictEqual(s.summary.textChars, 0);
  assert.strictEqual(s.meta.unknownBlockTypes.invalid_search_result_content, 1);
  assert.strictEqual(s.meta.unknownBlockTypes.search_result, undefined);
  assert.strictEqual(s.meta.suspect, true);
});
