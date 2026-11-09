#!/usr/bin/env node
// End-to-end check for the MCP server: a real stdio handshake against a throwaway data dir.
// No network, no model call, and it never touches the user's real workflows.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mcp-'));
fs.mkdirSync(path.join(tmp, 'links'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'versions'), { recursive: true });

const cards = [
  { id: 'a', kind: 'in', title: 'Materials', body: 'collect the shots', impl: 'ls shots/', mods: [{ type: 'mat', name: 'shots' }], x: 0, y: 0 },
  { id: 'b', kind: 'proc', title: 'Render', body: 'render the sheet', impl: '', mods: [{ type: 'tool', name: 'ffmpeg' }], x: 300, y: 0 },
  { id: 'c', kind: 'out', title: 'Sheet', body: 'hand over one PNG', impl: '', mods: [{ type: 'res', name: 'sheet.png' }], x: 600, y: 0 },
];
const doc = {
  schema: 4, id: 'wtest_fixture', kind: 'flow', name: 'Fixture flow', agent: 'demo', agent_name: 'Demo agent',
  version: 2, updated_at: Date.now(),
  cards, edges: [['a', 'b'], ['b', 'c']],
};
const linkFile = path.join(tmp, 'links', 'wtest_fixture.json');
const versFile = path.join(tmp, 'versions', 'wtest_fixture.json');
fs.writeFileSync(linkFile, JSON.stringify(doc, null, 2));
fs.writeFileSync(versFile, JSON.stringify({
  schema: 4, id: 'wtest_fixture', keep: 20, updated_at: Date.now(),
  list: [
    { v: 1, at: Date.now() - 60000, by: 'me', what: 'created', snapshot: { name: 'Fixture flow', cards: cards.slice(0, 2), edges: [['a', 'b']] } },
    { v: 2, at: Date.now(), by: 'me', what: 'added output', snapshot: { name: 'Fixture flow', cards, edges: [['a', 'b'], ['b', 'c']] } },
  ],
}, null, 2));

function startServer(extraArgs = []) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'workflow-studio.js'), ...extraArgs], {
    env: { ...process.env, WF_HOME: tmp }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = '';
  const waiting = new Map();
  let nextId = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 5000);
  });
  const call = (name, args) => rpc('tools/call', { name, arguments: args || {} });
  return { child, rpc, call, stop: () => child.kill() };
}
const dataOf = res => JSON.parse(res.result.content[0].text);
const readDoc = () => JSON.parse(fs.readFileSync(linkFile, 'utf8'));
const readVers = () => JSON.parse(fs.readFileSync(versFile, 'utf8'));

(async () => {
  const s = startServer();

  // ---- handshake ----
  const init = await s.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.strictEqual(init.result.serverInfo.name, 'workflow-studio');
  assert.ok(init.result.capabilities.tools, 'advertises tools capability');
  s.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // ---- tools/list has read + write ----
  const tools = (await s.rpc('tools/list', {})).result.tools.map(t => t.name).sort();
  assert.deepStrictEqual(tools, ['get_versions', 'get_workflow', 'list_workflows', 'rollback_workflow', 'save_workflow', 'update_card']);

  // ---- reads ----
  const all = dataOf(await s.call('list_workflows'));
  assert.strictEqual(all.count, 1);
  assert.strictEqual(all.workflows[0].version, 2);
  const one = dataOf(await s.call('get_workflow', { workflow: 'fixture' }));
  assert.deepStrictEqual(one.cards.map(c => c.kind), ['in', 'proc', 'out']);
  assert.deepStrictEqual(one.edges, ['Materials -> Render', 'Render -> Sheet']);
  const vers = dataOf(await s.call('get_versions', { workflow: 'Fixture flow' }));
  assert.deepStrictEqual(vers.versions.map(v => v.v), [2, 1]);

  // ---- write: save_workflow with the version we read ----
  const renamed = await s.call('save_workflow', { workflow: 'fixture', expected_version: 2, name: 'Fixture flow (v3)', note: 'rename via test' });
  assert.ok(!renamed.result.isError, 'save should succeed');
  assert.strictEqual(dataOf(renamed).version, 3);
  assert.strictEqual(readDoc().version, 3);
  assert.strictEqual(readDoc().name, 'Fixture flow (v3)');
  assert.strictEqual(readVers().list.slice(-1)[0].v, 3);
  assert.ok(readVers().list.slice(-1)[0].snapshot, 'new version carries a snapshot');

  // ---- stale write is refused and changes nothing ----
  const before = fs.readFileSync(linkFile, 'utf8');
  const stale = await s.call('save_workflow', { workflow: 'fixture', expected_version: 2, name: 'should not land' });
  assert.strictEqual(stale.result.isError, true);
  assert.strictEqual(JSON.parse(stale.result.content[0].text).current_version, 3);
  assert.strictEqual(fs.readFileSync(linkFile, 'utf8'), before, 'refused write left the file untouched');

  // ---- update_card patches one card only ----
  const upd = await s.call('update_card', { workflow: 'fixture', card_id: 'b', expected_version: 3, body: 'render every shot', mods: ['ffmpeg', 'montage'], note: 'rewrote the render step' });
  assert.ok(!upd.result.isError);
  assert.strictEqual(dataOf(upd).version, 4);
  const after = readDoc();
  assert.strictEqual(after.cards.find(c => c.id === 'b').body, 'render every shot');
  assert.strictEqual(after.cards.find(c => c.id === 'b').mods.length, 2);
  assert.strictEqual(after.cards.find(c => c.id === 'a').body, 'collect the shots', 'other cards untouched');

  // ---- validation refusals ----
  const badEdge = await s.call('save_workflow', { workflow: 'fixture', expected_version: 4, edges: [['a', 'zzz']] });
  assert.strictEqual(badEdge.result.isError, true);
  assert.ok(/unknown card/.test(badEdge.result.content[0].text));
  const badCard = await s.call('save_workflow', { workflow: 'fixture', expected_version: 4, cards: [{ id: 'x', kind: 'nope', title: 'x' }] });
  assert.strictEqual(badCard.result.isError, true);
  assert.strictEqual(readDoc().version, 4, 'failed validation wrote nothing');

  // ---- rollback restores the snapshot and is itself a version ----
  const rb = await s.call('rollback_workflow', { workflow: 'fixture', to_version: 1, expected_version: 4, note: 'back to the first cut' });
  assert.ok(!rb.result.isError);
  assert.strictEqual(dataOf(rb).restored_from, 1);
  const restored = readDoc();
  assert.strictEqual(restored.version, 5);
  assert.strictEqual(restored.cards.length, 2, 'v1 snapshot had two cards');
  assert.deepStrictEqual(restored.edges, [['a', 'b']]);
  assert.strictEqual(readVers().list.slice(-1)[0].what, 'back to the first cut', 'the note is what lands in the version list');

  // ---- keeping only the newest 20 ----
  for (let i = 0; i < 24; i++) {
    const cur = readDoc().version;
    await s.call('save_workflow', { workflow: 'fixture', expected_version: cur, note: `bulk ${i}` });
  }
  const kept = readVers();
  assert.strictEqual(kept.list.length, 20, 'keep window is 20');
  assert.strictEqual(kept.list.slice(-1)[0].v, readDoc().version);

  // ---- read-only mode hides and refuses writes ----
  const ro = startServer(['--read-only']);
  await ro.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  const roTools = (await ro.rpc('tools/list', {})).result.tools.map(t => t.name).sort();
  assert.deepStrictEqual(roTools, ['get_versions', 'get_workflow', 'list_workflows']);
  const roWrite = await ro.call('save_workflow', { workflow: 'fixture', expected_version: readDoc().version });
  assert.strictEqual(roWrite.result.isError, true);
  ro.stop();

  // ---- server still answers after all that ----
  assert.deepStrictEqual((await s.rpc('ping', {})).result, {});

  // ---- CLI reads the same data ----
  const cli = execFileSync(process.execPath, [path.join(__dirname, 'workflow-cli.js'), 'show', 'fixture', '--json'],
    { env: { ...process.env, WF_HOME: tmp }, encoding: 'utf8' });
  assert.strictEqual(JSON.parse(cli).name, readDoc().name);

  console.log('mcp checks: 12 groups passed (handshake, tools, reads, save, stale-refusal, update_card, validation, rollback, keep-20, read-only, ping, CLI)');
  s.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(e => {
  console.error('FAIL', e && e.message);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { }
  process.exit(1);
});
