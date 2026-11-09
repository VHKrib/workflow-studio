// 测试用 preload：给 live.html 一个最小的 window.tcflow 桩（不碰任何真实数据）
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('tcflow', {
  onLiveDoc: () => { },
  liveState: async () => ({ on: false }),
  liveList: async () => [],
  liveDocSave: async () => ({ ok: true }),
  livePeek: async () => ({ ok: false }),
  liveOpenPath: async () => ({ ok: true }),
  liveFollow: async () => ({ ok: true }),
  liveAnalyze: async () => ({ ok: true })
});
