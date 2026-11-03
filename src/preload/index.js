import { contextBridge, ipcRenderer, webUtils } from 'electron'

// The only API the renderer can use to reach Electron.
// Exposed on window.resonant.
contextBridge.exposeInMainWorld('resonant', {
  // File objects (from <input type="file"> or drag-and-drop) don't expose their
  // disk path to the page; this resolves it so the file can be processed later.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // Copies the song into a new session folder and starts processing it
  importSong: (path) => ipcRenderer.invoke('session:import', path),
  // Stops processing a session (or removes it from the queue)
  cancelProcessing: (id) => ipcRenderer.invoke('session:cancel', id),
  // Saves song name / artist / time signature
  updateSessionDetails: (id, details) => ipcRenderer.invoke('session:update-details', id, details),
  // All sessions, newest first
  listSessions: () => ipcRenderer.invoke('session:list'),
  // Reads a session's current state from session.json
  getSession: (id) => ipcRenderer.invoke('session:get', id),
  // Calls callback(session) whenever a session changes. Returns an unsubscribe function.
  onSessionUpdated: (callback) => {
    const listener = (_event, session) => callback(session)
    ipcRenderer.on('session:updated', listener)
    return () => ipcRenderer.removeListener('session:updated', listener)
  },
})
