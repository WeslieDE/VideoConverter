'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const converter = require('./converter');

let mainWindow = null;
let currentAbortController = null;

function getLaunchPaths() {
  const raw = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2);
  return raw.filter((arg) => arg && !arg.startsWith('-'));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 840,
    minWidth: 480,
    minHeight: 560,
    backgroundColor: '#15130f',
    title: 'Video Verkleinern',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

ipcMain.handle('get-launch-paths', () => getLaunchPaths());

ipcMain.handle('pick-paths', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Videodatei oder Ordner wählen',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [{ name: 'Videos', extensions: converter.VIDEO_EXTENSIONS }],
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle('get-system-fonts', () => {
  return new Promise((resolve) => {
    execFile('fc-list', [':', 'family'], { maxBuffer: 1024 * 1024 * 8 }, (err, stdout) => {
      if (err) {
        resolve(['DynaPuff']);
        return;
      }
      const families = new Set();
      for (const rawLine of stdout.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        for (const part of line.split(',')) {
          const name = part.trim();
          if (name) families.add(name);
        }
      }
      if (families.size === 0) families.add('DynaPuff');
      resolve(Array.from(families).sort((a, b) => a.localeCompare(b, 'de')));
    });
  });
});

ipcMain.handle('preview-paths', (_event, inputPaths) => {
  const files = converter.collectFiles(inputPaths);
  return files;
});

ipcMain.handle('start-conversion', async (event, { paths: inputPaths, settings }) => {
  if (currentAbortController) {
    return { started: false, reason: 'Es läuft bereits eine Konvertierung.' };
  }
  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;

  converter
    .convertAll(inputPaths, settings, (evt) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('conversion-event', evt);
    }, signal)
    .catch((err) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('conversion-event', { type: 'fatal-error', error: err.message });
    })
    .finally(() => {
      currentAbortController = null;
    });

  return { started: true };
});

ipcMain.handle('cancel-conversion', () => {
  if (currentAbortController) {
    currentAbortController.abort();
    return true;
  }
  return false;
});
