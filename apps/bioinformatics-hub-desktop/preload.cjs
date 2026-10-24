const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('workflowHub', {
  copyText: (text) => ipcRenderer.invoke('workflow:copyText', { text }),
  saveDraft: (draft) => ipcRenderer.invoke('workflow:saveDraft', { draft }),
  catalog: () => ipcRenderer.invoke('workflow:catalog'),
  resolve: (args) => ipcRenderer.invoke('workflow:resolve', args),
  answer: (args) => ipcRenderer.invoke('workflow:answer', args),
  resultsRegister: (args) => ipcRenderer.invoke('workflow:resultsRegister', args),
  resultsVerify: (args) => ipcRenderer.invoke('workflow:resultsVerify', args),
  resultsValidate: (args) => ipcRenderer.invoke('workflow:resultsValidate', args),
  resultsFinalize: (args) => ipcRenderer.invoke('workflow:resultsFinalize', args),
  resultsOpenAll: (args) => ipcRenderer.invoke('workflow:resultsOpenAll', args),
  thumbnail: (args) => ipcRenderer.invoke('workflow:thumbnail', args),
  results: (id) => ipcRenderer.invoke('workflow:results', { id }),
  openResult: (args) => ipcRenderer.invoke('workflow:openResult', args),
  reopenResult: (args) => ipcRenderer.invoke('workflow:reopenResult', args),
  archive: (args) => ipcRenderer.invoke('workflow:archive', args),
  capture: (args) => ipcRenderer.invoke('workflow:capture', args),
  settings: () => ipcRenderer.invoke('workflow:settings'),
  selectWorkspace: () => ipcRenderer.invoke('workflow:selectWorkspace'),
  saveSettings: (args) => ipcRenderer.invoke('workflow:saveSettings', args),
  probe: () => ipcRenderer.invoke('workflow:probe'),
  modelCheck: () => ipcRenderer.invoke('workflow:modelCheck'),
  browserCheck: () => ipcRenderer.invoke('workflow:browserCheck'),
  validate: (args) => ipcRenderer.invoke('workflow:validate', args),
  start: (args) => ipcRenderer.invoke('workflow:start', args),
  list: () => ipcRenderer.invoke('workflow:list'),
  load: (id) => ipcRenderer.invoke('workflow:load', { id }),
  clone: (id) => ipcRenderer.invoke('workflow:clone', { id }),
  control: (args) => ipcRenderer.invoke('workflow:control', args),
  activate: (args) => ipcRenderer.invoke('workflow:activate', args),
  pickInput: (kind) => ipcRenderer.invoke('workflow:pickInput', { kind }),
  reveal: (args) => ipcRenderer.invoke('workflow:reveal', args),
  export: (id) => ipcRenderer.invoke('workflow:export', { id }),
  delete: (id) => ipcRenderer.invoke('workflow:delete', { id }),
  showExport: (args) => ipcRenderer.invoke('workflow:showExport', args),
  onUpdate: (callback) => subscribe('workflow:update', callback),
})

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('事件回调必须是函数')
  const handler = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('bioinformaticsHub', {
  isDesktop: true,
  setLocale: (locale) => ipcRenderer.invoke('app:setLocale', locale),
  engineStatus: () => ipcRenderer.invoke('engine:status'),
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
