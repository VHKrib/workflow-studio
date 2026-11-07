const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tcflow', {
  listAgents: () => ipcRenderer.invoke('agents:list'),
  askAgent: (payload) => ipcRenderer.invoke('agent:ask', payload),
  // 流式：边跑边推事件（Hermes 的对话框效果）
  askAgentStream: (payload) => ipcRenderer.invoke('agent:stream', payload),
  cancelAgent: (runId) => ipcRenderer.invoke('agent:cancel', runId),
  onAgentEvent: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('agent:event', h);
    return () => ipcRenderer.removeListener('agent:event', h);
  },
  // 只读：读一个 agent 的工作链路原料
  readAgentChain: (id) => ipcRenderer.invoke('agent:chain', id),
  // 一次分析最多等多久（毫秒）。默认 150 秒；WF_READ_TIMEOUT_MS 只给验收把上限调小用，界面上没有开关。
  readTimeoutMs: Math.max(5000, Number(process.env.WF_READ_TIMEOUT_MS) || 150000),
  // 共享链路状态文件（人和 agent 共用一份底稿；画布写、人/agent 读）
  linkDir: () => ipcRenderer.invoke('link:dir'),
  linkPath: (id) => ipcRenderer.invoke('link:path', id),
  linkWrite: (payload) => ipcRenderer.invoke('link:write', payload),
  linkRead: (id) => ipcRenderer.invoke('link:read', id),
  linkDrop: (id) => ipcRenderer.invoke('link:drop', id),
  // 版本记录：最近 20 版（推一条 → 主进程裁到 20 条再把整份列表返回来）
  versionList: (id) => ipcRenderer.invoke('version:list', id),
  versionPush: (payload) => ipcRenderer.invoke('version:push', payload),
  versionDrop: (id) => ipcRenderer.invoke('version:drop', id),
  onLinkExternal: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('link:external', h);
    return () => ipcRenderer.removeListener('link:external', h);
  },
  // 独立实时画布（只读）：开窗 / 列最近有活动的对话 / 上次的选中与开关 / 跟随 / 单次取一份
  openLive: () => ipcRenderer.invoke('live:open'),
  liveList: () => ipcRenderer.invoke('live:list'),
  liveState: () => ipcRenderer.invoke('live:state'),
  liveFollow: (payload) => ipcRenderer.invoke('live:follow', payload),
  liveSnapshot: (payload) => ipcRenderer.invoke('live:snapshot', payload),
  liveAnalyze: (payload) => ipcRenderer.invoke('live:analyze', payload),
  onLiveDoc: (cb) => {
    const h = (_e, doc) => cb(doc);
    ipcRenderer.on('live:doc', h);
    return () => ipcRenderer.removeListener('live:doc', h);
  },
  saveFlow: (flow) => ipcRenderer.invoke('flow:save', flow),
  openFlow: () => ipcRenderer.invoke('flow:open'),
});
