// 链路状态文件：一条链路的完整状态落成一份可读底稿，人和 agent 共用。
//
// 规矩（改这块要守住）：
// - 画布是唯一写入方；agent / 人只能读。外面改了文件，画布认领回来（版本号更大才认）。
// - 写：先写临时文件再换名，读的人永远读到完整的一份，不会读到写一半的 JSON。
// - 读：内容解析不了就退回上一份好的（lastGood），坏文件绝不推给画布。
// - 自己刚写的文件不当成「外部改动」（比对内容 hash），否则画布和文件会互相推来推去。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const hash = s => crypto.createHash('sha1').update(s).digest('hex');
const safeId = id => String(id == null ? '' : id).replace(/[^\w.-]/g, '_').slice(0, 60) || 'link';

function createLinkStore(dir, { pollMs = 400 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const lastGood = new Map();     // file → { doc, hash }
  const selfHash = new Map();     // file → hash（自己刚写的内容）
  const sigs = new Map();         // file → "mtime:size"：变了才去读
  let timer = null;
  let watcher = null;
  let onChange = null;

  const fileOf = id => path.join(dir, safeId(id) + '.json');

  function write(id, doc) {
    const file = fileOf(id);
    const body = JSON.stringify(doc, null, 2) + '\n';
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);                       // 原子换名
    const h = hash(body);
    lastGood.set(file, { doc, hash: h });
    selfHash.set(file, h);
    try { const st = fs.statSync(file); sigs.set(file, st.mtimeMs + ':' + st.size); } catch (_) { }
    return { ok: true, path: file, bytes: Buffer.byteLength(body) };
  }

  function read(id) {
    const file = fileOf(id);
    let body;
    try { body = fs.readFileSync(file, 'utf8'); }
    catch (e) { const g = lastGood.get(file); return { ok: false, path: file, doc: g ? g.doc : null, error: String(e.message || e), missing: true }; }
    try {
      const doc = JSON.parse(body);
      lastGood.set(file, { doc, hash: hash(body) });
      return { ok: true, path: file, doc };
    } catch (e) {
      // 坏文件：画布继续用上一份好的
      const g = lastGood.get(file);
      return { ok: !!g, path: file, doc: g ? g.doc : null, error: '状态文件读不了：' + String(e.message || e), stale: true };
    }
  }

  function drop(id) {
    const file = fileOf(id);
    try { fs.unlinkSync(file); } catch (_) { }
    lastGood.delete(file); selfHash.delete(file); sigs.delete(file);
  }

  function scan(silent) {
    let names = [];
    try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (_) { return; }
    for (const name of names) {
      const file = path.join(dir, name);
      let st;
      try { st = fs.statSync(file); } catch (_) { continue; }          // 换名瞬间读不到：下一轮再说
      const sig = st.mtimeMs + ':' + st.size;
      if (sigs.get(file) === sig) continue;
      sigs.set(file, sig);
      let body;
      try { body = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
      const h = hash(body);
      if (h === selfHash.get(file)) continue;                         // 自己刚写的
      let doc;
      try { doc = JSON.parse(body); } catch (_) { continue; }          // 坏文件：不推给画布
      if (!doc || typeof doc !== 'object') continue;
      lastGood.set(file, { doc, hash: h });
      if (!silent && onChange) onChange({ id: String(doc.id || name.replace(/\.json$/, '')), doc, path: file, at: Date.now() });
    }
  }

  function startWatching(cb) {
    onChange = cb;
    scan(true);                                                        // 已有的文件先静默登记：启动时不把旧文件当成外部改动推上来
    timer = setInterval(scan, pollMs);
    try { watcher = fs.watch(dir, () => scan()); } catch (_) { }
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (watcher) try { watcher.close(); } catch (_) { }
    timer = null; watcher = null;
  }

  return { dir, fileOf, write, read, drop, scan, startWatching, stop };
}

module.exports = { createLinkStore };
