'use strict';
const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');

// Required for AppImage (no setuid chrome-sandbox) and Steam Deck Game Mode
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');

const SERVER_URL = 'https://doom-room-production.up.railway.app/';

// Steam Deck on-screen keyboard via Steam protocol
ipcMain.on('keyboard-open',  () => shell.openExternal('steam://open/keyboard'));
ipcMain.on('keyboard-close', () => shell.openExternal('steam://close/keyboard'));

let win;

app.whenReady().then(() => {
  win = new BrowserWindow({
    title: 'DOOM ROOM',
    frame: false,
    fullscreen: true,
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadURL(SERVER_URL);

  // After the page loads, inject focus/blur handlers for the name input
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      (function () {
        const input = document.getElementById('name-input');
        if (!input || !window.electronAPI) return;
        input.addEventListener('focus', () => window.electronAPI.openKeyboard());
        input.addEventListener('blur',  () => window.electronAPI.closeKeyboard());
      })();
    `);
  });

  // F11 toggles fullscreen
  win.webContents.on('before-input-event', (_, input) => {
    if (input.key === 'F11' && input.type === 'keyDown') win.setFullScreen(!win.isFullScreen());
  });

  win.on('closed', () => { win = null; });
});

app.on('window-all-closed', () => app.quit());
