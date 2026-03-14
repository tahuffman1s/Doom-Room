'use strict';
const { app, BrowserWindow } = require('electron');

const SERVER_URL = 'https://doom-room-production.up.railway.app/';

let win;

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'DOOM ROOM',
    autoHideMenuBar: true,
    fullscreen: false,
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadURL(SERVER_URL);

  // F11 toggles fullscreen (handy on Steam Deck)
  win.webContents.on('before-input-event', (_, input) => {
    if (input.key === 'F11' && input.type === 'keyDown') win.setFullScreen(!win.isFullScreen());
  });

  win.on('closed', () => { win = null; });
});

app.on('window-all-closed', () => app.quit());
