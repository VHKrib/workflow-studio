#!/usr/bin/env node
// Workflow Studio · MCP server (stdio, zero dependencies)
//
// Exposes the workflows this app writes to disk as tools any MCP client can call:
// Claude Code, Codex, OpenClaw, or anything else that speaks MCP over stdio.
//
//   node mcp/workflow-studio.js                # read + write
//   node mcp/workflow-studio.js --read-only    # reads only (no write tools listed)
//   node mcp/workflow-studio.js --selftest     # print what it can see, for a quick check
//
// Write rules, the same ones the app itself follows:
// - the canvas writes the shared state file atomically; a foreign writer is adopted only when the version is higher;
// - every write here bumps the version by one and appends a snapshot, so the app can roll it back;
// - writes are optimistic: the caller passes the version it read, and a stale version is refused untouched.
//
// Env: WF_HOME overrides the data directory (isolated instance, copy, or test fixture).
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROTOCOL = '2024-11-05';
const SERVER = { name: 'workflow-studio', version: require('../package.json').version };
const READ_ONLY = process.argv.includes('--read-only');
const KEEP = 20;
const KINDS = ['in', 'proc', 'out'];

function dataDir() {
  if (process.env.WF_HOME) return process.env.WF_HOME;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'workflow-studio');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'workflow-studio');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'workflow-studio');
}

const linksDir = () => path.join(dataDir(), 'links');
const versionsDir = () => path.join(dataDir(), 'versions');
const safeId = id => String(id == null ? '' : id).replace(/[^\w.-]/g, '_').slice(0, 60) || 'flow';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function filesIn(dir) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.')).map(f => path.join(dir, f)); }
  catch (e) { return []; }
}
function atomicWrite(file, body) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);                 // readers never see a half-written file
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
  const file = path.join(versionsDir(), safeId(id) + '.json');
  return { file, doc: readJson(file) };
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

// ---------- validation ----------

function validateCards(cards) {
  if (!Array.isArray(cards)) return 'cards must be an array';
  if (!cards.length) return 'cards must not be empty';
  const seen = new Set();
  for (const c of cards) {
    if (!c || typeof c !== 'object') return 'each card must be an object';
    if (!c.id || typeof c.id !== 'string') return 'each card needs a string id';
    if (seen.has(c.id)) return `duplicate card id "${c.id}"`;
    seen.add(c.id);
    if (!KINDS.includes(c.kind)) return `card "${c.id}" has kind "${c.kind}" (expected in|proc|out)`;
    if (typeof c.title !== 'string' || !c.title.trim()) return `card "${c.id}" needs a title`;
    if (c.body != null && typeof c.body !== 'string') return `card "${c.id}" body must be a string`;
    if (c.mods != null && !Array.isArray(c.mods)) return `card "${c.id}" mods must be an array`;
  }
  return '';
}

function validateEdges(edges, cards) {
  if (!Array.isArray(edges)) return 'edges must be an array';
  const ids = new Set(cards.map(c => c.id));
  for (const e of edges) {
    const from = Array.isArray(e) ? e[0] : e && e.from;
    const to = Array.isArray(e) ? e[1] : e && e.to;
    if (!ids.has(from)) return `edge from unknown card "${from}"`;
    if (!ids.has(to)) return `edge to unknown card "${to}"`;
    if (from === to) return `edge "${from}" points at itself`;
  }
  return '';
}

// ---------- writing ----------

// One writer at a time across processes: an exclusive lock file next to the data.
function withLock(id, fn) {
  const dir = path.join(dataDir(), '.locks');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
  const file = path.join(dir, safeId(id) + '.lock');
  const deadline = Date.now() + 2000;
  let fd = null;
  while (fd == null) {
    try { fd = fs.openSync(file, 'wx'); }
    catch (e) {
      if (Date.now() > deadline) throw new Error('workflow is being written by someone else, try again');
    }
  }
  try { return fn(); } finally {
    try { fs.closeSync(fd); } catch (e) { }
    try { fs.unlinkSync(file); } catch (e) { }
  }
}

function pushVersion(next, { by, what }) {
  const { file, doc } = versionsOf(next.id);
  const list = ((doc && doc.list) || []).filter(e => Number(e.v) !== Number(next.version));
  list.push({
    v: next.version,
    at: next.updated_at,
    by: by || 'mcp',
    what: what || 'changed via MCP',
    snapshot: { name: next.name, agent: next.agent, agent_name: next.agent_name, cards: next.cards, edges: next.edges },
  });
  list.sort((a, b) => a.v - b.v);
  const body = JSON.stringify({
    schema: (doc && doc.schema) || 4,
    id: next.id,
    keep: KEEP,
    updated_at: Date.now(),
    list: list.slice(-KEEP),
  }, null, 2) + '\n';
  atomicWrite(file, body);
  return file;
}

// The one place that writes a new state: bump version, write the state file, append a snapshot.
function commit(w, patch, { by, what, expected }) {
  if (Number(w.version || 1) !== Number(expected)) {
    return { error: `version mismatch: expected ${expected}, current ${w.version}`, current_version: w.version, id: w.id };
  }
  const next = Object.assign({}, w, patch, { version: Number(w.version || 1) + 1, updated_at: Date.now() });
  const cards = next.cards || [];
  next.summary = {
    cards: cards.length,
    edges: (next.edges || []).length,
    by_kind: KINDS.reduce((acc, k) => { acc[k] = cards.filter(c => c.kind === k).length; return acc; }, {}),
    executor: next.agent_name || next.agent || '',
  };
  const linkFile = path.join(linksDir(), safeId(next.id) + '.json');
  atomicWrite(linkFile, JSON.stringify(next, null, 2) + '\n');
  const versionsFile = pushVersion(next, { by, what });
  return { ok: true, id: next.id, name: next.name, version: next.version, link: linkFile, versions: versionsFile };
}

// ---------- tools ----------

const READ_TOOLS = [
  {
    name: 'list_workflows',
    description: 'List the workflows in this Workflow Studio install: id, name, current version, executor, card/edge counts and when it last changed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_workflow',
    description: 'Read one workflow in full: name, executor, version, every card (kind, title, plain body, internal wiring, modules) and the edges between them. Accepts an id, an exact name or part of a name.',
    inputSchema: {
      type: 'object',
      properties: { workflow: { type: 'string', description: 'workflow id, name, or part of the name' } },
      required: ['workflow'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_versions',
    description: 'List the kept versions of one workflow (newest first: number, time, who changed it, what changed). Pass "v" to also get that version\'s full snapshot.',
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

const WRITE_TOOLS = [
  {
    name: 'save_workflow',
    description: 'Replace a workflow\'s cards/edges (or its name/executor) and record a new version. Pass the version you read as expected_version; if the workflow moved on since then, the write is refused and nothing changes.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'workflow id, name, or part of the name' },
        expected_version: { type: 'number', description: 'the version you read (optimistic concurrency check)' },
        cards: { type: 'array', description: 'full card list; replaces the existing one' },
        edges: { type: 'array', description: 'full edge list, [fromId, toId] pairs' },
        name: { type: 'string', description: 'optional new name' },
        executor: { type: 'string', description: 'optional new executor agent id' },
        note: { type: 'string', description: 'what changed, recorded in the version list' },
      },
      required: ['workflow', 'expected_version'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_card',
    description: 'Change one card in place (title, plain body, internal wiring, modules) and record a new version. Only the fields you pass are replaced. Pass expected_version; a stale version is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'workflow id, name, or part of the name' },
        card_id: { type: 'string', description: 'id of the card to change' },
        expected_version: { type: 'number', description: 'the version you read' },
        title: { type: 'string' },
        body: { type: 'string', description: 'plain-language body: what goes in / what happens / what comes out' },
        impl: { type: 'string', description: 'internal wiring: commands, paths, field names' },
        mods: { type: 'array', description: 'modules: [{ type: "mat"|"tool"|"how"|"res", name }] or plain strings' },
        note: { type: 'string', description: 'what changed, recorded in the version list' },
      },
      required: ['workflow', 'card_id', 'expected_version'],
      additionalProperties: false,
    },
  },
  {
    name: 'rollback_workflow',
    description: 'Restore a workflow to one of its kept versions and record the rollback as a new version (so it can be undone again). Pass expected_version; a stale version is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'workflow id, name, or part of the name' },
        to_version: { type: 'number', description: 'version number to restore' },
        expected_version: { type: 'number', description: 'the version you read' },
        note: { type: 'string', description: 'why, recorded in the version list' },
      },
      required: ['workflow', 'to_version', 'expected_version'],
      additionalProperties: false,
    },
  },
];

const TOOLS = READ_ONLY ? READ_TOOLS : READ_TOOLS.concat(WRITE_TOOLS);

function ok(data) { return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }; }
function bad(payload) { return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true }; }

function callTool(name, args) {
  const a = args || {};

  if (name === 'list_workflows') {
    const list = allWorkflows().map(w => ({
      id: w.id, name: w.name, version: w.version,
      executor: w.agent_name || w.agent || '',
      updated_at: w.updated_at,
      cards: (w.cards || []).length, edges: (w.edges || []).length,
    })).sort((x, y) => (y.updated_at || 0) - (x.updated_at || 0));
    return ok({ count: list.length, workflows: list });
  }

  if (name === 'get_workflow') {
    const w = findWorkflow(a.workflow);
    if (!w) return bad({ error: `no workflow matching "${a.workflow}"` });
    const { cards, edges } = outline(w);
    const vdoc = versionsOf(w.id).doc;
    return ok({
      id: w.id, name: w.name, version: w.version,
      executor: w.agent_name || w.agent || '',
      updated_at: w.updated_at, summary: w.summary || null,
      cards, edges,
      versions: (vdoc && vdoc.list || []).length,
    });
  }

  if (name === 'get_versions') {
    const w = findWorkflow(a.workflow);
    if (!w) return bad({ error: `no workflow matching "${a.workflow}"` });
    const { doc } = versionsOf(w.id);
    const list = ((doc && doc.list) || []).slice().sort((x, y) => y.v - x.v).map(e => ({ v: e.v, at: e.at, by: e.by, what: e.what }));
    const out = { id: w.id, name: w.name, current: w.version, kept: list.length, versions: list };
    if (a.v != null) {
      const hit = ((doc && doc.list) || []).find(e => Number(e.v) === Number(a.v));
      if (!hit) return bad({ error: `version ${a.v} not kept for "${w.name}"` });
      out.snapshot = hit.snapshot || null;
    }
    return ok(out);
  }

  if (name === 'save_workflow' || name === 'update_card' || name === 'rollback_workflow') {
    if (READ_ONLY) return bad({ error: 'this server runs with --read-only; write tools are not available' });
    const found = findWorkflow(a.workflow);
    if (!found) return bad({ error: `no workflow matching "${a.workflow}"` });
    if (a.expected_version == null) return bad({ error: 'expected_version is required for every write' });

    try {
      return withLock(found.id, () => {
        const current = findWorkflow(found.id);                 // re-read inside the lock
        if (!current) return bad({ error: 'workflow disappeared before the write' });

        if (name === 'save_workflow') {
          if (a.cards != null) {
            const err = validateCards(a.cards);
            if (err) return bad({ error: err });
          }
          const cards = a.cards != null ? a.cards : (current.cards || []);
          if (a.edges != null) {
            const err = validateEdges(a.edges, cards);
            if (err) return bad({ error: err });
          }
          const patch = {};
          if (a.cards != null) patch.cards = cards;
          if (a.edges != null) patch.edges = a.edges;
          if (a.name != null) patch.name = String(a.name);
          if (a.executor != null) { patch.agent = String(a.executor); patch.agent_name = String(a.executor); }
          const res = commit(current, patch, { by: 'mcp', what: a.note || 'saved via MCP', expected: a.expected_version });
          return res.error ? bad(res) : ok(res);
        }

        if (name === 'update_card') {
          const cards = (current.cards || []).map(c => Object.assign({}, c));
          const card = cards.find(c => c.id === a.card_id);
          if (!card) return bad({ error: `no card "${a.card_id}" in "${current.name}"` });
          if (a.title != null) card.title = String(a.title);
          if (a.body != null) card.body = String(a.body);
          if (a.impl != null) card.impl = String(a.impl);
          if (a.mods != null) {
            card.mods = a.mods.map(m => typeof m === 'string'
              ? { type: card.kind === 'in' ? 'mat' : (card.kind === 'out' ? 'res' : 'how'), name: m }
              : m);
          }
          const err = validateCards(cards);
          if (err) return bad({ error: err });
          const res = commit(current, { cards }, { by: 'mcp', what: a.note || `edited card "${card.title}" via MCP`, expected: a.expected_version });
          return res.error ? bad(res) : ok(Object.assign(res, { card: card.id }));
        }

        // rollback_workflow
        const { doc } = versionsOf(current.id);
        const hit = ((doc && doc.list) || []).find(e => Number(e.v) === Number(a.to_version));
        if (!hit || !hit.snapshot) return bad({ error: `version ${a.to_version} not kept for "${current.name}"` });
        const snap = hit.snapshot;
        const err = validateCards(snap.cards || []);
        if (err) return bad({ error: `snapshot v${a.to_version} is not usable: ${err}` });
        const res = commit(current, {
          cards: snap.cards,
          edges: snap.edges || [],
          name: snap.name || current.name,
          agent: snap.agent,
          agent_name: snap.agent_name,
        }, { by: 'mcp', what: a.note || `rolled back to v${a.to_version} via MCP`, expected: a.expected_version });
        return res.error ? bad(res) : ok(Object.assign(res, { restored_from: Number(a.to_version) }));
      });
    } catch (e) {
      return bad({ error: String((e && e.message) || e) });
    }
  }

  return bad({ error: `unknown tool "${name}"` });
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
    try { return reply(callTool(params && params.name, (params && params.arguments) || {})); }
    catch (e) { return fail(-32603, String((e && e.message) || e)); }
  }
  return fail(-32601, `method not found: ${method}`);
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function main() {
  if (process.argv.includes('--selftest')) {
    const list = allWorkflows();
    process.stdout.write(JSON.stringify({
      dataDir: dataDir(), readOnly: READ_ONLY, workflows: list.length,
      names: list.slice(0, 20).map(w => `${w.name} v${w.version}`),
    }, null, 2) + '\n');
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

// Exported so the small CLI (tools/workflow-cli.js) and the tests read exactly the way this server does.
module.exports = { dataDir, allWorkflows, findWorkflow, versionsOf, outline, validateCards, validateEdges, commit, withLock };
