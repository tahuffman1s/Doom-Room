'use strict';
const { app, BrowserWindow, globalShortcut } = require('electron');
const path = require('path');

// Boot the game server in-process — it starts listening on PORT (default 8080)
require(path.join(__dirname, '../server.js'));

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

  // Give the server ~600ms to bind before loading the page
  setTimeout(() => {
    const port = process.env.PORT || 8080;
    win.loadURL(`http://localhost:${port}`);
  }, 600);

  // F11 toggles fullscreen (handy on Steam Deck)
  win.webContents.on('before-input-event', (_, input) => {
    if (input.key === 'F11' && input.type === 'keyDown') win.setFullScreen(!win.isFullScreen());
  });

  win.on('closed', () => { win = null; });
});

app.on('window-all-closed', () => app.quit());
