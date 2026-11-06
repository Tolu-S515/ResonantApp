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
  // Finds chords for a song imported before chord detection; resolves with the updated session
  detectChords: (id) => ipcRenderer.invoke('session:detect-chords', id),
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

  // Recording takes on instrument tracks (native engine)
  recording: {
    // tracks: [{ index, inputs }]; options: { transpose }. Resolves { takes: [id] }
    start: (sessionId, tracks, options) => ipcRenderer.invoke('recording:start', sessionId, tracks, options),
    // segments: [{ epochMs, songTime }], the song time heard at each wall-clock time
    // playback (re)started from during the recording (it restarts at each loop wrap)
    reference: (segments) => ipcRenderer.invoke('recording:reference', segments),
    // Resolves { session, takes, warning } (session is null if the take was too short).
    // Without segments, uses the last ones sent with reference().
    stop: (segments) => ipcRenderer.invoke('recording:stop', segments),
    // takeId null: the track plays nothing
    setActiveTake: (sessionId, track, takeId) => ipcRenderer.invoke('recording:set-active-take', sessionId, track, takeId),
    // Moves the take's file to the Trash
    deleteTake: (sessionId, takeId) => ipcRenderer.invoke('recording:delete-take', sessionId, takeId),
    // Loopback calibration: start recording the input, play clicks, then finish with
    // when they were heard (wall-clock ms). Resolves { offsetMs, heard }
    startCalibration: (inputChannel) => ipcRenderer.invoke('recording:calibrate-start', inputChannel),
    finishCalibration: (expectedMs) => ipcRenderer.invoke('recording:calibrate-finish', expectedMs),
  },

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
