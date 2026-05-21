'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, args) => ipcRenderer.invoke(channel, args || {}),
  on: (channel, callback) => ipcRenderer.on(channel, (_, data) => callback(data)),
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  mediaUrl: (filePath) => {
    if (!filePath) return null;
    return 'safe-file://x?p=' + encodeURIComponent(filePath);
  },
});
