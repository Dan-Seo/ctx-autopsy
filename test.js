'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { analyze, bashLabel, readLines, render } = require('./cli.js');

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

// ---- 0.2.0: first-request split (a) + subagent re-reads (b) ----
const AR = (hash, extra = {}) => ({ type: 'api-request', shapeHash: hash, ...extra });
const SH = (hash, shape, extra = {}) => ({ type: 'api-request-shape', shapeHash: hash, shape, ...extra });
const AU = (id, usage, extra = {}) => { const r = U(id, 'Bash', { command: 'true' }, extra); r.message.usage = usage; return r; };
const J = rows => rows.map(r => JSON.stringify(r));
const SUB_TIP = 'Subagents re-read files the main session already had. Pass the key facts in the subagent prompt instead of letting them re-read shared files.';

test('0.2.0 (a1): split over two sessions uses medians', () => {
  const tools1 = [{ name: 'Read' }];
  const tools2 = [{ name: 'Read' }, { name: 'mcp__srv__t' }];
  const f1 = [SH('h1', { system: [{ type: 'text', text: 'a'.repeat(300) }], tools: tools1 }),
    AR('h1', { timestamp: '2026-10-27T09:00:00Z' }),
    AU('u1', { input_tokens: 9000 }, { timestamp: '2026-10-27T09:00:01Z' }), R('u1', 'ok')];
  const f2 = [SH('h2', { system: [{ type: 'text', text: 'b'.repeat(600) }], tools: tools2 }),
    AR('h2', { timestamp: '2026-10-27T09:00:00Z' }),
    AU('u2', { input_tokens: 12000 }, { timestamp: '2026-10-27T09:00:01Z' }), R('u2', 'ok')];
  const sp = analyze([{ lines: J(f1) }, { lines: J(f2) }]).startingContext.split;
  assert.strictEqual(sp.sessions, 2);
  assert.strictEqual(sp.systemChars, 450);
  assert.strictEqual(sp.toolCount, 2);
  assert.strictEqual(sp.systemTokens, 150);
  const t1 = JSON.stringify(tools1).length, t2 = JSON.stringify(tools2).length;
  const m2 = JSON.stringify(tools2[1]).length;
  assert.strictEqual(sp.toolsChars, Math.round((t1 + t2) / 2));
  assert.strictEqual(sp.toolsTokens, Math.round((Math.round(t1 / 3) + Math.round(t2 / 3)) / 2));
  assert.strictEqual(sp.toolsBuiltinTokens, Math.round((Math.round(t1 / 3) + Math.round((t2 - m2) / 3)) / 2));
  assert.strictEqual(sp.toolsMcpTokens, Math.round(Math.round(m2 / 3) / 2));
  const r1 = Math.max(0, Math.round(9000 - (300 + t1) / 3)), r2 = Math.max(0, Math.round(12000 - (600 + t2) / 3));
  assert.strictEqual(sp.restTokens, Math.round((r1 + r2) / 2));
});

test('0.2.0 (a2): sessions without request records have no split line', () => {
  const s = A([AU('u', { input_tokens: 5000 }), R('u', 'ok')]);
  assert.strictEqual(s.startingContext.split, null);
  assert.ok(!render(s, 30, false).includes('first-request split'));
});

test('0.2.0 (a3): a shape in another file does not resolve', () => {
  const shape = { system: [{ type: 'text', text: 'x'.repeat(100) }], tools: [{ name: 'Read' }] };
  const f1 = [AR('hx', { timestamp: '2026-10-27T09:00:00Z' }), AU('u1', { input_tokens: 5000 }), R('u1', 'ok')];
  const f2 = [SH('hx', shape), AU('u2', { input_tokens: 6000 }), R('u2', 'ok')];
  const s = analyze([{ lines: J(f1) }, { lines: J(f2) }]);
  assert.strictEqual(s.startingContext.split, null);
  assert.strictEqual(s.startingContext.sessions, 2);
});

test('0.2.0 (a4): a missing first-request hash excludes the session but keeps the totals', () => {
  const s = A([{ type: 'api-request', timestamp: '2026-10-27T09:00:00Z' },
    AR('h', { timestamp: '2026-10-27T09:01:00Z' }),
    SH('h', { system: [{ type: 'text', text: 'x' }], tools: [] }),
    AU('u', { input_tokens: 5000 }), R('u', 'ok')]);
  assert.strictEqual(s.startingContext.split, null, 'a later request never substitutes the first');
  assert.strictEqual(s.startingContext.medianTokens, 5000);
});

test('0.2.0 (a5): request and shape without usage are excluded', () => {
  const s = A([SH('h', { system: [{ text: 'x' }], tools: [] }), AR('h', { timestamp: 1000 })]);
  assert.strictEqual(s.startingContext.split, null);
  assert.strictEqual(s.startingContext.medianTokens, null);
});

test('0.2.0 (a6): usage outside the window excludes the session', () => {
  const rows = [SH('h', { system: [{ text: 'x'.repeat(10) }], tools: [] }),
    AR('h', { timestamp: '2026-10-27T09:00:00Z' }),
    AU('u', { input_tokens: 5000 }, { timestamp: '2020-01-01T00:00:00Z' }),
    R('u', 'ok', {}, { timestamp: '2020-01-01T00:00:01Z' })];
  const s = analyze([{ lines: J(rows) }], { since: Date.parse('2026-01-01T00:00:00Z') });
  assert.strictEqual(s.startingContext.split, null);
  assert.strictEqual(s.startingContext.medianTokens, null);
});

test('0.2.0 (a7): requests with an agentId are not the first request', () => {
  const s = A([
    SH('bad', { system: [{ text: 'x'.repeat(111) }], tools: [] }),
    SH('good', { system: [{ text: 'y'.repeat(222) }], tools: [] }),
    AR('bad', { timestamp: '2026-10-27T09:00:00Z', agentId: 'sub-1' }),
    AR('good', { timestamp: '2026-10-27T09:01:00Z' }),
    AU('u', { input_tokens: 5000 }), R('u', 'ok')]);
  assert.strictEqual(s.startingContext.split.systemChars, 222);
});

test('0.2.0 (a8): timestamp ties keep file order and unparsable times lose', () => {
  const mk = n => ({ system: [{ text: 'v'.repeat(n) }], tools: [] });
  const s = A([SH('c', mk(300)), SH('a', mk(100)), SH('b', mk(200)),
    AR('c', { timestamp: 'not-a-time' }),
    AR('a', { timestamp: '2026-10-27T09:00:00Z' }),
    AR('b', { timestamp: '2026-10-27T09:00:00Z' }),
    AU('u', { input_tokens: 5000 }), R('u', 'ok')]);
  assert.strictEqual(s.startingContext.split.systemChars, 100);
});

test('0.2.0 (a9): a non-array tool list contributes zero but still resolves', () => {
  const s = A([SH('h', { system: [{ text: 'abc' }], tools: 'nope' }),
    AR('h', { timestamp: 1000 }), AU('u', { input_tokens: 5000 }), R('u', 'ok')]);
  const sp = s.startingContext.split;
  assert.strictEqual(sp.sessions, 1);
  assert.strictEqual(sp.systemChars, 3);
  assert.strictEqual(sp.toolsChars, 0);
  assert.strictEqual(sp.toolCount, 0);
  assert.strictEqual(sp.toolsMcpTokens, 0);
});

test('0.2.0 (a10): split inputs never leak names, text, or hashes', () => {
  const s = A([
    SH('CANARY_02-hash', { system: [{ type: 'text', text: 'CANARY_02 system body' }],
      tools: [{ name: 'Read' }, { name: 'mcp__CANARY_02srv__t' }] }),
    AR('CANARY_02-hash', { timestamp: '2026-10-27T09:00:00Z' }),
    AU('u', { input_tokens: 5000 }), R('u', 'CANARY_02 result body')]);
  assert.strictEqual(s.startingContext.split.sessions, 1);
  assert.ok(!JSON.stringify(s).includes('CANARY_02'));
  assert.ok(!render(s, 30, false).includes('CANARY_02'));
});

const T0 = '2026-10-20T10:00:00Z', T1 = '2026-10-20T11:00:00Z';
const pair = (id, fp, body, ts, input = {}, extra = {}) =>
  [U(id, 'Read', { file_path: fp, ...input }), R(id, body, extra, { timestamp: ts })];
const sub2 = (mainRows, subRows, opts) => analyze([{ lines: J(mainRows), sessionKey: 'P/S' },
  { lines: J(subRows), subagent: true, sessionKey: 'P/S' }], opts).rereads.subagent;

test('0.2.0 (b11): two subagent re-reads match by key, hash, and order', () => {
  const main = [...pair('m1', '/w/a.ts', 'alpha-body', T0), ...pair('m2', '/w/b.ts', 'beta-body!', T0)];
  const sub = [...pair('s1', '/w/a.ts', 'alpha-body', T1), ...pair('s2', '/w/b.ts', 'beta-body!', T1)];
  const g = sub2(main, sub);
  assert.strictEqual(g.count, 2);
  assert.strictEqual(g.chars, 'alpha-body'.length + 'beta-body!'.length);
  assert.deepStrictEqual(g.files[0], { file: 'a.ts', count: 1 });
});

test('0.2.0 (b12): range, hash, or order mismatch is not a re-read', () => {
  assert.strictEqual(sub2(pair('m', '/w/a.ts', 'same', T0), pair('s', '/w/a.ts', 'same', T1, { offset: 5 })).count, 0, 'range');
  assert.strictEqual(sub2(pair('m', '/w/a.ts', 'v1', T0), pair('s', '/w/a.ts', 'v2', T1)).count, 0, 'hash');
  assert.strictEqual(sub2(pair('m', '/w/a.ts', 'same', T1), pair('s', '/w/a.ts', 'same', T0)).count, 0, 'order');
});

test('0.2.0 (b13): equal or unparsable timestamps never match', () => {
  assert.strictEqual(sub2(pair('m', '/w/a.ts', 'same', T0), pair('s', '/w/a.ts', 'same', T0)).count, 0, 'equal');
  assert.strictEqual(sub2(pair('m', '/w/a.ts', 'same', 'soon'), pair('s', '/w/a.ts', 'same', T1)).count, 0, 'main unparsable');
  const badSub = sub2(pair('m', '/w/a.ts', 'same', T0), pair('s', '/w/a.ts', 'same', 'later-ish'));
  assert.strictEqual(badSub.count, 0, 'sub unparsable');
  assert.strictEqual(badSub.readChars, 4, 'unparsable sub reads still count as reads');
});

test('0.2.0 (b14): sub reads outside the window are out, main reads outside count', () => {
  const since = Date.parse('2026-01-01T00:00:00Z');
  const outSub = sub2(pair('m', '/w/a.ts', 'same', '2020-01-01T00:00:00Z'),
    pair('s', '/w/a.ts', 'same', '2020-06-01T00:00:00Z'), { since });
  assert.strictEqual(outSub.count, 0);
  assert.strictEqual(outSub.readChars, 0);
  assert.strictEqual(sub2(pair('m', '/w/a.ts', 'same', '2020-01-01T00:00:00Z'),
    pair('s', '/w/a.ts', 'same', T1), { since }).count, 1);
});

test('0.2.0 (b15): duplicate ids pick one representative regardless of file order', () => {
  const main = (sk, ts) => ({ lines: J(pair('m', '/w/a.ts', 'same', ts)), sessionKey: sk });
  const sub = (sk, id, ts) => ({ lines: J(pair(id, '/w/a.ts', 'same', ts)), subagent: true, sessionKey: sk });
  const both = files => [analyze(files).rereads.subagent.count, analyze([...files].reverse()).rereads.subagent.count];
  assert.deepStrictEqual(both([main('P/S', T0), sub('P/S', 'dup', T1), sub('P/S', 'dup', '2026-10-20T12:00:00Z')]), [1, 1]);
  assert.deepStrictEqual(both([main('p/aaa', T0), sub('p/aaa', 'dup', T1), sub('p/zzz', 'dup', T1)]), [1, 1]);
  assert.deepStrictEqual(both([main('p/zzz', T0), sub('p/zzz', 'dup', T1), sub('p/aaa', 'dup', T1)]), [0, 0]);
});

test('0.2.0 (b16): compact boundaries do not affect subagent matching', () => {
  const bound = { type: 'system', subtype: 'compact_boundary' };
  const s = analyze([{ lines: J([...pair('m', '/w/a.ts', 'same', T0), bound]), sessionKey: 'P/S' },
    { lines: J([bound, ...pair('s', '/w/a.ts', 'same', T1)]), subagent: true, sessionKey: 'P/S' }]);
  assert.strictEqual(s.rereads.subagent.count, 1);
});

test('0.2.0 (b17): files without keys and orphan subagents contribute nothing', () => {
  const noKey = analyze([{ lines: J(pair('m', '/w/a.ts', 'same', T0)) },
    { lines: J(pair('s', '/w/a.ts', 'same', T1)), subagent: true }]);
  assert.deepStrictEqual(noKey.rereads.subagent, { count: 0, chars: 0, files: [], readChars: 0 });
  const orphan = analyze([{ lines: J(pair('s', '/w/a.ts', 'same', T1)), subagent: true, sessionKey: 'P/orphan' }]);
  assert.strictEqual(orphan.rereads.subagent.count, 0);
  assert.strictEqual(orphan.rereads.subagent.readChars, 4);
});

test('0.2.0 (b18): one result can count in both re-read lists but flags once', () => {
  const body = 'shared-body';
  const main = [...pair('m1', '/w/a.ts', body, T0), ...pair('m2', '/w/a.ts', body, '2026-10-20T10:30:00Z')];
  const s = analyze([{ lines: J(main), sessionKey: 'P/S' },
    { lines: J(pair('s', '/w/a.ts', body, T1)), subagent: true, sessionKey: 'P/S' }]);
  assert.strictEqual(s.rereads.count, 1);
  assert.strictEqual(s.rereads.subagent.count, 1);
  assert.strictEqual(s.summary.flaggedChars, body.length);
});

test('0.2.0 (b19): the subagent tip needs two re-reads, size, and share', () => {
  const run19 = (re, fresh) => {
    const main = [], sub = [];
    re.forEach(([f, n], i) => {
      const body = ('' + i).repeat(n).slice(0, n);
      main.push(...pair('m' + i, f, body, T0));
      sub.push(...pair('s' + i, f, body, T1));
    });
    fresh.forEach(([f, n], i) => sub.push(...pair('n' + i, f, 'n'.repeat(n), T1)));
    return analyze([{ lines: J(main), sessionKey: 'P/S' }, { lines: J(sub), subagent: true, sessionKey: 'P/S' }]);
  };
  const yes = run19([['/w/f1', 20000], ['/w/f2', 10000]], [['/w/g1', 30000]]);
  assert.strictEqual(yes.rereads.subagent.count, 2);
  assert.strictEqual(yes.rereads.subagent.chars, 30000);
  assert.strictEqual(yes.rereads.subagent.readChars, 60000);
  assert.ok(yes.tips.includes(SUB_TIP));
  assert.ok(!run19([['/w/f1', 20000]], []).tips.includes(SUB_TIP), 'single re-read');
  assert.ok(!run19([['/w/f1', 20000], ['/w/f2', 9000]], [['/w/g1', 71000]]).tips.includes(SUB_TIP), 'low share');
  assert.ok(!run19([['/w/f1', 6000], ['/w/f2', 4000]], [['/w/g1', 10000]]).tips.includes(SUB_TIP), 'small total');
});

test('0.2.0 (b20): subagent output shows file names only, never folders or bodies', () => {
  const fp = '/tmp/CANARY_02dir/plan.ts';
  const s = analyze([{ lines: J(pair('m', fp, 'CANARY_02 body text', T0)), sessionKey: 'P/S' },
    { lines: J(pair('s', fp, 'CANARY_02 body text', T1)), subagent: true, sessionKey: 'P/S' }]);
  assert.strictEqual(s.rereads.subagent.count, 1);
  assert.deepStrictEqual(s.rereads.subagent.files, [{ file: 'plan.ts', count: 1 }]);
  assert.ok(!JSON.stringify(s).includes('CANARY_02'));
  assert.ok(!render(s, 30, false).includes('CANARY_02'));
  assert.ok(s.rereads.subagent.files.every(f => !f.file.includes('/')));
});

test('0.2.0 (cli21): committed fixtures resolve one split session and two re-reads', () => {
  const dir = path.join(__dirname, 'fixtures-0.2.0');
  const r = run(['--days', '36500', '--json'], { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.startingContext.sessions, 2);
  assert.strictEqual(j.startingContext.split.sessions, 1);
  assert.strictEqual(j.rereads.subagent.count, 2);
  const t = run(['--days', '36500'], { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(t.status, 0);
  for (const bad of ['CANARY_02', 'ACME']) {
    assert.ok(!t.stdout.includes(bad) && !r.stdout.includes(bad), `leaked ${bad}`);
  }
});

test('0.2.0 (cli22): old fixtures gain no split or subagent lines', () => {
  const t = run(['--days', '36500']);
  assert.strictEqual(t.status, 0);
  assert.ok(!t.stdout.includes('first-request split'));
  assert.ok(!t.stdout.includes('Subagent re-reads'));
  const j = JSON.parse(run(['--days', '36500', '--json']).stdout);
  assert.strictEqual(j.startingContext.split, null);
  assert.deepStrictEqual(j.rereads.subagent, { count: 0, chars: 0, files: [], readChars: 0 });
});

test('0.2.0 (tip23): the subagent tip never pipes', () => {
  const { tips } = require('./cli.js');
  const out = tips({ byTool: [], rereads: { count: 0, subagent: { count: 2, chars: 30000, readChars: 60000 } },
    startingContext: { medianTokens: null } });
  assert.ok(out.includes(SUB_TIP));
  assert.ok(!SUB_TIP.includes('|'));
  for (const tp of out) if (/\|\s*(tail|head)/.test(tp)) assert.match(tp, /pipefail/);
});

test('0.2.0 (a24): only the first shape per hash is kept', () => {
  const s = A([SH('h', { system: [{ text: 'a'.repeat(100) }], tools: [] }),
    SH('h', { system: [{ text: 'b'.repeat(999) }], tools: [] }),
    AR('h', { timestamp: 1000 }), AU('u', { input_tokens: 5000 }), R('u', 'ok')]);
  assert.strictEqual(s.startingContext.split.systemChars, 100);
});

test('0.2.0 (a25): request records in subagent files are ignored', () => {
  const s = analyze([{ lines: J([SH('h', { system: [{ text: 'x'.repeat(100) }], tools: [] }),
    AR('h', { timestamp: 1000 }), AU('u', { input_tokens: 5000 }), R('u', 'ok')]), subagent: true }]);
  assert.strictEqual(s.startingContext.split, null);
  assert.strictEqual(s.startingContext.medianTokens, null);
});

test('0.2.0 (a26): rest tokens never go negative', () => {
  const s = A([SH('h', { system: [{ text: 'x'.repeat(300) }], tools: [{ name: 'Read' }] }),
    AR('h', { timestamp: 1000 }), AU('u', { input_tokens: 100 }), R('u', 'ok')]);
  assert.strictEqual(s.startingContext.split.restTokens, 0);
});

test('0.2.0 (a27): null or empty agentId counts as a main request', () => {
  const mk = n => ({ system: [{ text: 'v'.repeat(n) }], tools: [] });
  const s = A([SH('zero', mk(999)), SH('null', mk(100)), SH('empty', mk(200)),
    AR('zero', { timestamp: 50, agentId: 0 }),
    AR('null', { timestamp: 200, agentId: null }),
    AR('empty', { timestamp: 100, agentId: '' }),
    AU('u', { input_tokens: 5000 }), R('u', 'ok')]);
  assert.strictEqual(s.startingContext.split.systemChars, 200);
});

test('0.2.0 (b28): failed, partial, image, and empty reads are never candidates', () => {
  const mk = (mainExtra, mainBody, subExtra, subBody) => analyze([
    { lines: J([U('m', 'Read', { file_path: '/w/a.ts' }), R('m', mainBody, mainExtra, { timestamp: T0 })]), sessionKey: 'P/S' },
    { lines: J([U('s', 'Read', { file_path: '/w/a.ts' }), R('s', subBody, subExtra, { timestamp: T1 })]), subagent: true, sessionKey: 'P/S' }]).rereads.subagent.count;
  assert.strictEqual(mk({ is_error: true }, 'denied', {}, 'denied'), 0, 'main failed');
  assert.strictEqual(mk({}, 'ok', { is_error: true }, 'ok'), 0, 'sub failed');
  const partial = [{ type: 'text', text: 'same' }, { type: 'future_x' }];
  assert.strictEqual(mk({}, partial, {}, partial), 0, 'partial');
  const img = [{ type: 'text', text: 'same' }, { type: 'image', source: {} }];
  assert.strictEqual(mk({}, img, {}, img), 0, 'image');
  assert.strictEqual(mk({}, '', {}, ''), 0, 'empty');
});

test('0.2.0 (b29): subagent files sort by count then name and cut at five', () => {
  const main = [], sub = [];
  let i = 0;
  for (const [fp, n] of [['/w/zebra.ts', 3], ['/w/mango.ts', 2], ['/w/b.ts', 1], ['/w/a.ts', 1], ['/w/A.ts', 1], ['/w/0.ts', 1]]) {
    const body = 'body-of-' + fp;
    main.push(...pair('m' + i, fp, body, T0));
    for (let k = 0; k < n; k++) sub.push(...pair('s' + i + '_' + k, fp, body, T1));
    i++;
  }
  const g = analyze([{ lines: J(main), sessionKey: 'P/S' },
    { lines: J(sub), subagent: true, sessionKey: 'P/S' }]).rereads.subagent;
  assert.strictEqual(g.count, 9);
  assert.deepStrictEqual(g.files, [{ file: 'zebra.ts', count: 3 }, { file: 'mango.ts', count: 2 },
    { file: '0.ts', count: 1 }, { file: 'A.ts', count: 1 }, { file: 'a.ts', count: 1 }]);
});

test('0.2.0 (cli30): subagent keys need two leading segments', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxa-'));
  const put = (rel, rows) => {
    const p = path.join(d, 'projects', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, J(rows).join('\n') + '\n');
  };
  put('p.jsonl', pair('m1', '/w/a.ts', 'same', T0));
  put('p/subagents/s1.jsonl', pair('s1', '/w/a.ts', 'same', T1));
  put('subagents/s2.jsonl', pair('s2', '/w/a.ts', 'same', T1));
  put('v/sess.jsonl', pair('m2', '/w/b.ts', 'same', T0));
  put('v/sess/subagents/a.jsonl', pair('s3', '/w/b.ts', 'same', T1));
  const r = run(['--days', '36500', '--json'], { CLAUDE_CONFIG_DIR: d });
  assert.strictEqual(r.status, 0);
  const g = JSON.parse(r.stdout).rereads.subagent;
  assert.strictEqual(g.count, 1);
  assert.strictEqual(g.readChars, 4);
  assert.deepStrictEqual(g.files, [{ file: 'b.ts', count: 1 }]);
});

test('0.2.0 (json31): split values are numbers and subagent files are strings', () => {
  const main = [SH('h', { system: [{ text: 'x'.repeat(30) }], tools: [{ name: 'Read' }] }),
    AR('h', { timestamp: 1000 }), AU('u', { input_tokens: 5000 }), R('u', 'ok'),
    ...pair('m', '/w/a.ts', 'same', T0)];
  const s = analyze([{ lines: J(main), sessionKey: 'P/S' },
    { lines: J(pair('s', '/w/a.ts', 'same', T1)), subagent: true, sessionKey: 'P/S' }]);
  for (const [kk, v] of Object.entries(s.startingContext.split)) assert.strictEqual(typeof v, 'number', kk);
  assert.strictEqual(s.rereads.subagent.count, 1);
  for (const f of s.rereads.subagent.files) {
    assert.strictEqual(typeof f.file, 'string');
    assert.strictEqual(typeof f.count, 'number');
  }
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

// ---- privacy fuzz regressions (ctx-pm 2026-10-28): tool names are labels too ----
test('tool names with folders, spaces or = are redacted, never shown', () => {
  for (const nm of ['/home/alice/tool', 'tool name', 'k=v', 'a"b', 'x|y']) {
    const s = A([U('a', nm, {}), R('a', '0123456789')]);
    assert.strictEqual(s.byTool[0].tool, '<redacted>', nm);
    assert.strictEqual(s.top[0].label, '<redacted>', nm);
  }
  for (const nm of ['mcp__/home/x__t', 'mcp__srv name__t']) {
    const s = A([U('a', nm, {}), R('a', '0123456789')]);
    assert.strictEqual(s.byTool[0].tool, 'mcp:<redacted>', nm);
    assert.strictEqual(s.top[0].label, 'mcp:<redacted>', nm);
  }
});
