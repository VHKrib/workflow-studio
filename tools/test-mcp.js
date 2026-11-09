#!/usr/bin/env node
// End-to-end check for the MCP server: real stdio handshake against a throwaway data dir.
// No network, no model call, and it never touches the user's real workflows.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mcp-'));
fs.mkdirSync(path.join(tmp, 'links'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'versions'), { recursive: true });

const doc = {
  schema: 4, id: 'wtest_fixture', kind: 'flow', name: 'Fixture flow', agent: 'demo', agent_name: 'Demo agent',
  version: 2, updated_at: Date.now(),
  cards: [
    { id: 'a', kind: 'in', title: 'Materials', body: 'collect the shots', impl: 'ls shots/', mods: [{ type: 'mat', name: 'shots' }], x: 0, y: 0 },
    { id: 'b', kind: 'proc', title: 'Render', body: 'render the sheet', impl: '', mods: [{ type: 'tool', name: 'ffmpeg' }], x: 300, y: 0 },
    { id: 'c', kind: 'out', title: 'Sheet', body: 'hand over one PNG', impl: '', mods: [{ type: 'res', name: 'sheet.png' }], x: 600, y: 0 },
  ],
  edges: [['a', 'b'], ['b', 'c']],
};
fs.writeFileSync(path.join(tmp, 'links', 'wtest_fixture.json'), JSON.stringify(doc, null, 2));
fs.writeFileSync(path.join(tmp, 'versions', 'wtest_fixture.json'), JSON.stringify({
  schema: 4, id: 'wtest_fixture', keep: 20, updated_at: Date.now(),
  list: [
    { v: 1, at: Date.now() - 60000, by: 'me', what: 'created', snapshot: { name: 'Fixture flow', cards: doc.cards, edges: doc.edges } },
    { v: 2, at: Date.now(), by: 'me', what: 'added output', snapshot: { name: 'Fixture flow', cards: doc.cards, edges: doc.edges } },
  ],
}, null, 2));

const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'workflow-studio.js')], {
  env: { ...process.env, WF_HOME: tmp }, stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const waiting = new Map();
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

let nextId = 0;
function rpc(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 5000);
  });
}
const call = (name, args) => rpc('tools/call', { name, arguments: args || {} });
const dataOf = res => JSON.parse(res.result.content[0].text);

(async () => {
  // 1. handshake
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.strictEqual(init.result.serverInfo.name, 'workflow-studio');
  assert.ok(init.result.capabilities.tools, 'advertises tools capability');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // 2. tools/list
  const list = await rpc('tools/list', {});
  const names = list.result.tools.map(t => t.name).sort();
  assert.deepStrictEqual(names, ['get_versions', 'get_workflow', 'list_workflows']);
  assert.ok(list.result.tools.every(t => t.inputSchema && t.inputSchema.type === 'object'), 'every tool has a schema');

  // 3. list_workflows sees the fixture
  const all = dataOf(await call('list_workflows'));
  assert.strictEqual(all.count, 1);
  assert.strictEqual(all.workflows[0].name, 'Fixture flow');
  assert.strictEqual(all.workflows[0].version, 2);
  assert.strictEqual(all.workflows[0].cards, 3);

  // 4. get_workflow by fragment, with edges resolved to titles
  const one = dataOf(await call('get_workflow', { workflow: 'fixture' }));
  assert.strictEqual(one.cards.length, 3);
  assert.deepStrictEqual(one.cards.map(c => c.kind), ['in', 'proc', 'out']);
  assert.deepStrictEqual(one.edges, ['Materials -> Render', 'Render -> Sheet']);
  assert.strictEqual(one.executor, 'Demo agent');

  // 5. get_versions + one snapshot
  const vers = dataOf(await call('get_versions', { workflow: 'Fixture flow' }));
  assert.deepStrictEqual(vers.versions.map(v => v.v), [2, 1]);
  assert.strictEqual(vers.current, 2);
  const withSnap = dataOf(await call('get_versions', { workflow: 'Fixture flow', v: 1 }));
  assert.strictEqual(withSnap.snapshot.cards.length, 3);

  // 6. unknown workflow is a clean tool error, not a crash
  const miss = await call('get_workflow', { workflow: 'nope-does-not-exist' });
  assert.strictEqual(miss.result.isError, true);
  assert.ok(/no workflow matching/.test(miss.result.content[0].text));

  // 7. ping still answers after an error, and server stayed alive
  const pong = await rpc('ping', {});
  assert.deepStrictEqual(pong.result, {});

  // 8. the CLI reads the same data
  const cli = require('child_process').execFileSync(process.execPath,
    [path.join(__dirname, 'workflow-cli.js'), 'show', 'fixture', '--json'],
    { env: { ...process.env, WF_HOME: tmp }, encoding: 'utf8' });
  assert.strictEqual(JSON.parse(cli).name, 'Fixture flow');

  console.log('mcp checks: 8 groups passed (handshake, tools, list, get, versions, errors, ping, CLI)');
  child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(e => {
  console.error('FAIL', e && e.message);
  child.kill();
  process.exit(1);
});
