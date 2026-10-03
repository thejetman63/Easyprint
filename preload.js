const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Small, safe bridge between the window and the computer.
contextBridge.exposeInMainWorld('easyprint', {
  pathForFile: (file) => webUtils.getPathForFile(file),
  choices: () => ipcRenderer.invoke('choices'),
  orcaStatus: () => ipcRenderer.invoke('orca:status'),
  slice: (job) => ipcRenderer.invoke('orca:slice', job),
  onSliceLog: (fn) => ipcRenderer.on('orca:log', (_e, t) => fn(t)),
  saveGcode: (gcodePath) => ipcRenderer.invoke('gcode:save', { gcodePath }),
  openFolder: (dir) => ipcRenderer.invoke('folder:open', dir),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  browseOrca: () => ipcRenderer.invoke('orca:browse'),
  printer: {
    connect: () => ipcRenderer.invoke('printer:connect'),
    disconnect: () => ipcRenderer.invoke('printer:disconnect'),
    status: () => ipcRenderer.invoke('printer:status'),
    print: (gcodePath, estimateSeconds) => ipcRenderer.invoke('printer:print', { gcodePath, estimateSeconds }),
    pause: () => ipcRenderer.invoke('printer:pause'),
    resume: () => ipcRenderer.invoke('printer:resume'),
    stop: () => ipcRenderer.invoke('printer:stop'),
    log: () => ipcRenderer.invoke('printer:log'),
    openGcode: () => ipcRenderer.invoke('gcode:open'),
    onStatus: (fn) => ipcRenderer.on('printer:status', (_e, s) => fn(s)),
    onProblem: (fn) => ipcRenderer.on('printer:problem', (_e, m) => fn(m)),
    onDone: (fn) => ipcRenderer.on('printer:done', () => fn()),
  },
});
