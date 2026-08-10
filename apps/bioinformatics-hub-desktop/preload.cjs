const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('事件回调必须是函数')
  const handler = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('bioinformaticsHub', {
  isDesktop: true,
  sessionStart: (args) => ipcRenderer.invoke('session:start', args),
  sessionCancel: (sessionId) => ipcRenderer.invoke('session:cancel', sessionId),
  loadSession: (sessionId) => ipcRenderer.invoke('session:load', sessionId),
  listSessions: () => ipcRenderer.invoke('session:list'),
  openSite: (payload) => ipcRenderer.invoke('site:open', payload),
  saveSiteResult: (payload) => ipcRenderer.invoke('site:saveResult', payload),
  revealArtifact: (payload) => ipcRenderer.invoke('artifact:reveal', payload),
  exportResearchBundle: (sessionIdOrDir) =>
    ipcRenderer.invoke('fs:exportResearchBundle', sessionIdOrDir),
  pickFasta: () => ipcRenderer.invoke('fs:pickFasta'),
  pickAlignment: () => ipcRenderer.invoke('fs:pickAlignment'),
  onSessionUpdate: (callback) => subscribe('session:update', callback),
  onLog: (callback) => subscribe('session:log', callback),
  onSessionDone: (callback) => subscribe('session:done', callback),
  onSessionCancelled: (callback) => subscribe('session:cancelled', callback),
  onSessionError: (callback) => subscribe('session:error', callback),
})
