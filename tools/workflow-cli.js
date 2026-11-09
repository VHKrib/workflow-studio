#!/usr/bin/env node
// Read Workflow Studio workflows from a shell — for harnesses that cannot speak MCP
// (plain scripts, cron jobs, or an agent that only has a terminal).
//
//   node tools/workflow-cli.js list
//   node tools/workflow-cli.js show "隔板" [--json]
//   node tools/workflow-cli.js versions "隔板" [--v 3] [--json]
//
// Same data source as mcp/workflow-studio.js: links/<id>.json + versions/<id>.json.
// Read-only. WF_HOME overrides the data directory.
const { dataDir, allWorkflows, findWorkflow, versionsOf, outline } = require('../mcp/workflow-studio');

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const vIdx = argv.indexOf('--v');
const wantV = vIdx >= 0 ? Number(argv[vIdx + 1]) : null;
const args = argv.filter((a, i) => !a.startsWith('--') && !(vIdx >= 0 && i === vIdx + 1));
const [cmd, query] = args;

function out(data, text) {
  if (json) return console.log(JSON.stringify(data, null, 2));
  console.log(text);
}

if (cmd === 'list') {
  const list = allWorkflows().map(w => ({
    id: w.id, name: w.name, version: w.version,
    executor: w.agent_name || w.agent || '',
    cards: (w.cards || []).length, edges: (w.edges || []).length,
    updated_at: w.updated_at,
  })).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  out({ count: list.length, workflows: list },
    [`${list.length} workflows in ${dataDir()}`, ...list.map(w => `  v${w.version}  ${w.name}  (${w.cards} cards, ${w.edges} edges)`)].join('\n'));
} else if (cmd === 'show') {
  const w = findWorkflow(query);
  if (!w) { console.error(`no workflow matching "${query}"`); process.exit(1); }
  const { cards, edges } = outline(w);
  out({ id: w.id, name: w.name, version: w.version, executor: w.agent_name || w.agent || '', cards, edges },
    [`${w.name}  v${w.version}  ·  ${w.agent_name || w.agent || 'no executor'}`, '',
      ...cards.map(c => `[${c.kind}] ${c.title}\n      ${c.body}`),
      '', ...edges.map(e => `  ${e}`)].join('\n'));
} else if (cmd === 'versions') {
  const w = findWorkflow(query);
  if (!w) { console.error(`no workflow matching "${query}"`); process.exit(1); }
  const { doc } = versionsOf(w.id);
  const list = ((doc && doc.list) || []).slice().sort((a, b) => b.v - a.v).map(e => ({ v: e.v, at: e.at, by: e.by, what: e.what }));
  const payload = { id: w.id, name: w.name, current: w.version, versions: list };
  if (wantV != null) {
    const hit = ((doc && doc.list) || []).find(e => Number(e.v) === wantV);
    if (!hit) { console.error(`version ${wantV} not kept for "${w.name}"`); process.exit(1); }
    payload.snapshot = hit.snapshot;
  }
  out(payload, [`${w.name}  current v${w.version}  ·  ${list.length} kept`, ...list.map(e => `  v${e.v}  ${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')}  ${e.what || ''}`)].join('\n'));
} else {
  console.error('usage: workflow-cli.js list | show <name|id> | versions <name|id> [--v N]   [--json]');
  process.exit(1);
}
