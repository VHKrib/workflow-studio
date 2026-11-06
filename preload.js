const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tcflow', {
  listAgents: () => ipcRenderer.invoke('agents:list'),
  askAgent: (payload) => ipcRenderer.invoke('agent:ask', payload),
  saveFlow: (flow) => ipcRenderer.invoke('flow:save', flow),
  openFlow: () => ipcRenderer.invoke('flow:open'),
});
