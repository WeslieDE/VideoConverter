'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('videoConverter', {
  getLaunchPaths: () => ipcRenderer.invoke('get-launch-paths'),
  pickPaths: () => ipcRenderer.invoke('pick-paths'),
  getSystemFonts: () => ipcRenderer.invoke('get-system-fonts'),
  previewPaths: (paths) => ipcRenderer.invoke('preview-paths', paths),
  startConversion: (paths, settings) => ipcRenderer.invoke('start-conversion', { paths, settings }),
  cancelConversion: () => ipcRenderer.invoke('cancel-conversion'),
  onConversionEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('conversion-event', listener);
    return () => ipcRenderer.removeListener('conversion-event', listener);
  },
});
