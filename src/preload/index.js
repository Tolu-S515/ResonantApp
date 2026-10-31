import { contextBridge, webUtils } from 'electron'

// The only API the renderer can use to reach Electron.
// Exposed on window.resonant.
contextBridge.exposeInMainWorld('resonant', {
  // File objects (from <input type="file"> or drag-and-drop) don't expose their
  // disk path to the page; this resolves it so the file can be processed later.
  getPathForFile: (file) => webUtils.getPathForFile(file),
})
