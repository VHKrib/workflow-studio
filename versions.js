// 版本记录：一条链路最近 20 版的底稿（谁改的、改了什么、当时整条链路长什么样）。
//
// 规矩（改这块要守住）：
// - 只留最近 20 版：更早的自动丢掉，不留全量历史。
// - 每一条都是「可以整条带回去」的快照：卡片、连线、模块、正文、内部实现、坐标、执行方。
// - 写：先写临时文件再换名，读的人不会读到写一半的 JSON；坏文件当没有，不挡画布。
// - 同一个版号再推一次就覆盖那一条（重来 / 重试不会留下两条一样版本号的行）。
// - 回滚也是一条新版本（不删后面的版本），所以回得去、也再回得来。
const fs = require('fs');
const path = require('path');

const KEEP = 20;
const safeId = id => String(id == null ? '' : id).replace(/[^\w.-]/g, '_').slice(0, 60) || 'link';

function createVersionStore(dir) {
  fs.mkdirSync(dir, { recursive: true });

  const fileOf = id => path.join(dir, safeId(id) + '.json');

  function read(id) {
    const file = fileOf(id);
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc && Array.isArray(doc.list)) return { id: String(doc.id || id), list: doc.list, file };
    } catch (_) { }                                     // 没有 / 坏了：当成还没记过版本
    return { id: String(id), list: [], file };
  }

  function write(id, doc) {
    const file = fileOf(id);
    const body = JSON.stringify(doc, null, 1) + '\n';
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);                           // 原子换名
    return file;
  }

  const trim = list => {
    const seen = new Set();
    const out = [];
    for (const e of list.slice().sort((a, b) => (a && a.v || 0) - (b && b.v || 0))) {
      if (!e || typeof e.v !== 'number' || seen.has(e.v)) continue;
      seen.add(e.v); out.push(e);
    }
    return out.slice(-KEEP);
  };

  // 推一条版本；返回这一条链路现在留着的版本（升序，最多 20 条）
  function push(id, entry) {
    if (!entry || typeof entry.v !== 'number') return { ok: false, error: '版本号不合法' };
    const doc = read(id);
    const before = doc.list.length;
    const list = trim(doc.list.filter(e => e.v !== entry.v).concat([entry]));
    const path_ = write(id, { schema: 'workflow-studio/versions@1', id: String(id), keep: KEEP, updated_at: new Date().toISOString(), list });
    return { ok: true, path: path_, list, dropped: Math.max(0, before + 1 - list.length) };
  }

  function list(id) {
    const doc = read(id);
    return { ok: true, path: doc.file, keep: KEEP, list: doc.list };
  }

  function drop(id) {
    try { fs.unlinkSync(fileOf(id)); } catch (_) { }
    return true;
  }

  return { dir, fileOf, read, push, list, drop };
}

module.exports = { createVersionStore, KEEP };
