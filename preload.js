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
});
