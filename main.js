const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROFILES_DIR = path.join(os.homedir(), '.hermes', 'profiles');
const HERMES = path.join(os.homedir(), '.hermes', 'hermes-agent', '.hermes', 'bin', 'hermes');

/** 读本机 profile 列表：id + 显示名 + 所属部门 + 描述 */
let WHITELIST = null;
function loadWhitelist() {
  if (WHITELIST) return WHITELIST;
  WHITELIST = new Set();
  try {
    const cfg = fs.readFileSync(path.join(os.homedir(), '.hermes', 'config.yaml'), 'utf8');
    const m = cfg.match(/dispatch_profiles:\s*\[([\s\S]*?)\]/);
    if (m) m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean).forEach(x => WHITELIST.add(x));
  } catch (e) {}
  return WHITELIST;
}

function listAgents() {
  const out = [];
  const wl = loadWhitelist();
  let dirs = [];
  try { dirs = fs.readdirSync(PROFILES_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch (e) { return out; }
  for (const id of dirs.sort()) {
    const p = path.join(PROFILES_DIR, id, 'profile.yaml');
    let yaml = '';
    try { yaml = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
    const pick = (re) => { const m = yaml.match(re); return m ? m[1].trim() : ''; };
    const desc = (pick(/^description:\s*(.+)$/m) || '').replace(/^['"]|['"]$/g, '');
    out.push({
      id,
      name: pick(/^display_name:\s*(.+)$/m) || id,
      section: pick(/sectionName:\s*(.+)$/m) || '',
      desc: desc.slice(0, 160),
      stopped: (wl.size > 0 && !wl.has(id)) || /已停用|decommissioned/i.test(desc),
      hasSoul: fs.existsSync(path.join(PROFILES_DIR, id, 'SOUL.md')),
    });
  }
  return out;
}

/** 只读：跑一次 agent，问它对某个环节的意见（不触发任何付费动作） */
function askAgent({ profile, prompt, timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    if (!fs.existsSync(HERMES)) return resolve({ ok: false, error: 'hermes 入口不存在: ' + HERMES });
    const child = execFile(HERMES, ['-p', profile, 'chat', '-q', prompt],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env } },
      (err, stdout, stderr) => {
        resolve({ ok: !err, code: err ? (err.code || 'err') : 0, text: (stdout || stderr || '').slice(-20000) });
      });
    child.on('error', e => resolve({ ok: false, error: String(e) }));
  });
}

/** 流式：边跑边把事件推给渲染层（Hermes 的对话框效果靠它） */
const runs = new Map();
ipcMain.handle('agent:stream', (e, { profile, prompt, runId, timeoutMs = 180000 }) => new Promise((resolve) => {
  if (!fs.existsSync(HERMES)) return resolve({ ok: false, error: 'hermes 入口不存在: ' + HERMES });
  const child = spawn(HERMES, ['-p', profile, 'chat', '--format', 'stream-json', '-q', prompt], { env: { ...process.env } });
  runs.set(runId, child);
  let buf = '', finalText = '', tokens = null, err = '';
  const send = ev => { try { if (!e.sender.isDestroyed()) e.sender.send('agent:event', { runId, ev }); } catch (_) { } };
  const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) { } }, timeoutMs);
  child.stdout.on('data', d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      if (o.type === 'result') { finalText = o.text || ''; tokens = o.tokens || null; }
      send(o);
    }
  });
  child.stderr.on('data', d => { err += d.toString('utf8'); });
  child.on('error', e2 => { clearTimeout(timer); runs.delete(runId); resolve({ ok: false, error: String(e2) }); });
  child.on('close', code => {
    clearTimeout(timer); runs.delete(runId);
    resolve({ ok: code === 0, code, text: finalText, tokens, error: err.slice(-2000) });
  });
}));
ipcMain.handle('agent:cancel', (_e, runId) => {
  const c = runs.get(runId);
  if (!c) return false;
  try { c.kill('SIGTERM'); } catch (_) { }
  return true;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1320, height: 880, minWidth: 1000, minHeight: 640,
    title: 'TC 工作流台',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f3ef',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setBounds({ x: 20, y: 44, width: 1380, height: 880 });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('agents:list', () => listAgents());
ipcMain.handle('agent:ask', (_e, payload) => askAgent(payload));
ipcMain.handle('flow:save', async (_e, flow) => {
  const r = await dialog.showSaveDialog({ title: '保存工作流', defaultPath: path.join(os.homedir(), '工作流-' + (flow.name || 'untitled') + '.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.writeFileSync(r.filePath, JSON.stringify(flow, null, 2), 'utf8');
  return { ok: true, path: r.filePath };
});
ipcMain.handle('flow:open', async () => {
  const r = await dialog.showOpenDialog({ title: '打开工作流', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  try { return { ok: true, path: r.filePaths[0], flow: JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')) }; }
  catch (e) { return { ok: false, error: String(e) }; }
});
