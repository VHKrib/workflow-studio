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
  saveFlow: (flow) => ipcRenderer.invoke('flow:save', flow),
  openFlow: () => ipcRenderer.invoke('flow:open'),
});
