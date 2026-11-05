import { contextBridge, ipcRenderer, webUtils } from 'electron'

// Listens on an IPC channel; returns an unsubscribe function
function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

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

  // Key change: resolves with { files: { trackId: path } } once that key is rendered
  // (or { cancelled: true } if a newer request replaced it)
  prepareRender: (id, transpose) => ipcRenderer.invoke('render:prepare', id, transpose),
  // callback({ sessionId, name, done, total }) as tracks finish rendering
  onRenderProgress: (callback) => subscribe('render:progress', callback),

  // Audio interface and instrument monitoring (native engine)
  audio: {
    // [{ name, inputUid, outputUid, inputChannels, outputChannels, sampleRate, split }]
    listInterfaces: () => ipcRenderer.invoke('audio:list-interfaces'),
    // { settings: { inputUid, outputUid, name, bufferFrames }, info (while running) | null, error | null }
    getState: () => ipcRenderer.invoke('audio:get-state'),
    // Saves any of { inputUid, outputUid, name, bufferFrames }; reconnects with them
    setDevice: (changes) => ipcRenderer.invoke('audio:set-device', changes),
    // Starts/stops the engine to match what's plugged in; call when devices change
    connect: () => ipcRenderer.invoke('audio:connect'),
    // settings: { left, right (-1 for mono), gain, pan, monitor }; channels are 0-based
    setTrack: (index, settings) => ipcRenderer.invoke('audio:set-track', index, settings),
    clearTrack: (index) => ipcRenderer.invoke('audio:clear-track', index),
    // Instrument tracks: [{ inputs: [0] | [0, 1], gain, pan }], saved app-wide
    getInstruments: () => ipcRenderer.invoke('instruments:get'),
    saveInstruments: (tracks) => ipcRenderer.invoke('instruments:save', tracks),
    // callback(state) on any change, including the engine stopping on its own
    onState: (callback) => subscribe('audio:state', callback),
    // callback({ tracks: [{ index, left, right }], inputs: [peak per channel] }) ~30 times a second
    onMeters: (callback) => subscribe('audio:meters', callback),
  },
})
