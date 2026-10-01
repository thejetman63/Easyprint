const { contextBridge, webUtils } = require('electron');

// Small, safe bridge between the window and the computer.
// Later steps add slicing (Orca) and USB printing here.
contextBridge.exposeInMainWorld('easyprint', {
  pathForFile: (file) => webUtils.getPathForFile(file),
});
