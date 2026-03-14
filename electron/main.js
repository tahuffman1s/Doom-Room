'use strict';
const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');

// GAMESCOPE_WAYLAND_DISPLAY is set by gamescope (Steam Deck Game Mode)
const isGameMode = !!process.env.GAMESCOPE_WAYLAND_DISPLAY;

// Required for AppImage (no setuid chrome-sandbox)
app.commandLine.appendSwitch('no-sandbox');
// In gamescope use X11 (XWayland); on desktop let Electron auto-detect
app.commandLine.appendSwitch('ozone-platform-hint', isGameMode ? 'x11' : 'auto');
// gamescope GPU sandbox causes gray screen — disable it in game mode
if (isGameMode) app.commandLine.appendSwitch('disable-gpu-sandbox');

const SERVER_URL = 'https://doom-room-production.up.railway.app/';

// Steam on-screen keyboard — only in Game Mode (gamescope)
ipcMain.on('keyboard-open',  () => { if (isGameMode) shell.openExternal('steam://open/keyboard'); });
ipcMain.on('keyboard-close', () => { if (isGameMode) shell.openExternal('steam://close/keyboard'); });
// Intentional quit from in-game menu — destroy bypasses the close-event guard
ipcMain.on('quit', () => { if (win) win.destroy(); });

let win;

app.whenReady().then(() => {
  win = new BrowserWindow({
    title: 'DOOM ROOM',
    frame: false,
    // Game mode: fullscreen tells gamescope to fill the display.
    // Desktop: maximize() so Escape only affects pointer lock, not the window.
    fullscreen: isGameMode,
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (!isGameMode) win.maximize();
  win.loadURL(SERVER_URL);

  // Block accidental closes (Ctrl+W etc.) — quit must go through IPC
  win.on('close', (e) => e.preventDefault());

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

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') win.setFullScreen(!win.isFullScreen());
    // Block Ctrl+R (page reload) — Ctrl+W is handled via the close event instead
    if (input.control && (input.key === 'r' || input.key === 'R')) event.preventDefault();
  });

  win.on('closed', () => { win = null; });
});

app.on('window-all-closed', () => app.quit());
