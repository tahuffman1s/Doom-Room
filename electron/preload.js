'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal API into the page's window context
contextBridge.exposeInMainWorld('electronAPI', {
  openKeyboard:  () => ipcRenderer.send('keyboard-open'),
  closeKeyboard: () => ipcRenderer.send('keyboard-close'),
});
