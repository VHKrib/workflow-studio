#!/usr/bin/env node
// Workflow Studio · MCP server (stdio, zero dependencies)
//
// Exposes the workflows this app writes to disk as tools any MCP client can call:
// Claude Code, Codex, OpenClaw, or anything else that speaks MCP over stdio.
//
//   node mcp/workflow-studio.js            # speak MCP on stdin/stdout
//   node mcp/workflow-studio.js --selftest # print what it can see, for a quick check
//
// Read-only by design: the canvas is the only writer, so every tool here reads the
// shared state file (links/<id>.json) and the version store (versions/<id>.json).
// Env: WF_HOME overrides the data directory (useful for tests and isolated instances).
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROTOCOL = '2024-11-05';
const SERVER = { name: 'workflow-studio', version: require('../package.json').version };

function dataDir() {
  if (process.env.WF_HOME) return process.env.WF_HOME;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'workflow-studio');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'workflow-studio');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'workflow-studio');
}

const linksDir = () => path.join(dataDir(), 'links');
const versionsDir = () => path.join(dataDir(), 'versions');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function filesIn(dir) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.')).map(f => path.join(dir, f)); }
  catch (e) { return []; }
}

function allWorkflows() {
  return filesIn(linksDir()).map(readJson).filter(d => d && d.id);
}

// Accept an id, an exact name, or a case-insensitive fragment of a name.
function findWorkflow(query) {
  const list = allWorkflows();
  const q = String(query || '').trim();
  if (!q) return null;
  return list.find(w => w.id === q)
    || list.find(w => w.name === q)
    || list.find(w => String(w.name || '').toLowerCase() === q.toLowerCase())
    || list.find(w => String(w.name || '').toLowerCase().includes(q.toLowerCase()))
    || null;
}

function versionsOf(id) {
  const file = path.join(versionsDir(), String(id).replace(/[^\w.-]/g, '_') + '.json');
  const doc = readJson(file);
  return { file, doc };
}

// One line per card, the same shape the app itself uses: kind, title, plain body.
function outline(doc) {
  const cards = (doc.cards || []).map(c => ({ id: c.id, kind: c.kind, title: c.title, body: c.body, mods: (c.mods || []).map(m => m.name || m) }));
  const byId = new Map(cards.map(c => [c.id, c]));
  const edges = (doc.edges || []).map(e => ({ from: Array.isArray(e) ? e[0] : e.from, to: Array.isArray(e) ? e[1] : e.to }))
    .filter(e => byId.has(e.from) && byId.has(e.to))
    .map(e => `${byId.get(e.from).title} -> ${byId.get(e.to).title}`);
  return { cards, edges };
}

const TOOLS = [
  {
    name: 'list_workflows',
    description: 'List the workflows in this Workflow Studio install: id, name, current version, executor, card/edge counts and when it last changed. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_workflow',
    description: 'Read one workflow in full: name, executor, version, every card (kind, title, plain body, internal wiring, modules) and the edges between them. Accepts an id, an exact name or part of a name. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { workflow: { type: 'string', description: 'workflow id, name, or part of the name' } },
      required: ['workflow'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_versions',
    description: 'List the kept versions of one workflow (newest first: number, time, who changed it, what changed). Pass "v" to also get that version\'s full snapshot. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'workflow id, name, or part of the name' },
        v: { type: 'number', description: 'optional: also return the snapshot of this version' },
      },
      required: ['workflow'],
      additionalProperties: false,
    },
  },
];

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function bad(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function callTool(name, args) {
  if (name === 'list_workflows') {
    const list = allWorkflows().map(w => ({
      id: w.id,
      name: w.name,
      version: w.version,
      executor: w.agent_name || w.agent || '',
      updated_at: w.updated_at,
      cards: (w.cards || []).length,
      edges: (w.edges || []).length,
    })).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    return ok({ count: list.length, workflows: list });
  }

  if (name === 'get_workflow') {
    const w = findWorkflow(args && args.workflow);
    if (!w) return bad(`no workflow matching "${args && args.workflow}"`);
    const { cards, edges } = outline(w);
    return ok({
      id: w.id,
      name: w.name,
      version: w.version,
      executor: w.agent_name || w.agent || '',
      updated_at: w.updated_at,
      summary: w.summary || null,
      cards,
      edges,
      versions: (versionsOf(w.id).doc && versionsOf(w.id).doc.list || []).length,
    });
  }

  if (name === 'get_versions') {
    const w = findWorkflow(args && args.workflow);
    if (!w) return bad(`no workflow matching "${args && args.workflow}"`);
    const { doc } = versionsOf(w.id);
    const list = ((doc && doc.list) || []).slice().sort((a, b) => b.v - a.v).map(e => ({
      v: e.v, at: e.at, by: e.by, what: e.what,
    }));
    const out = { id: w.id, name: w.name, current: w.version, kept: list.length, versions: list };
    if (args && args.v != null) {
      const hit = ((doc && doc.list) || []).find(e => Number(e.v) === Number(args.v));
      if (!hit) return bad(`version ${args.v} not kept for "${w.name}"`);
      out.snapshot = hit.snapshot || null;
    }
    return ok(out);
  }

  return bad(`unknown tool "${name}"`);
}

function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'initialize') {
    return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;      // notification: no reply
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const out = callTool(params && params.name, (params && params.arguments) || {});
      return reply(out);
    } catch (e) {
      return fail(-32603, String((e && e.message) || e));
    }
  }
  return fail(-32601, `method not found: ${method}`);
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function main() {
  if (process.argv.includes('--selftest')) {
    const list = allWorkflows();
    const out = { dataDir: dataDir(), workflows: list.length, names: list.map(w => `${w.name} v${w.version}`) };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      try { handle(msg); } catch (e) { /* never let one bad message kill the server */ }
    }
  });
}

if (require.main === module) main();

// Exported so the small CLI (tools/workflow-cli.js) reads exactly the same way this server does.
module.exports = { dataDir, allWorkflows, findWorkflow, versionsOf, outline };
