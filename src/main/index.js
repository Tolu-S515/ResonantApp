import { app, BrowserWindow, dialog, ipcMain, shell, systemPreferences, utilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createAudioController, createAudioHost } from './audio.js'
import { CancelledError, createJobQueue, runChordDetection, runProcessing } from './processing.js'
import { handleSessionProtocol, registerSchemePrivileges } from './protocol.js'
import { createRecorder } from './recordings.js'
import { RenderCancelledError, createRenderer } from './renders.js'
import { DEFAULT_INSTRUMENTS, sanitizeDeviceSettings, sanitizeInstruments, sanitizeTrack } from '../shared/audio-settings.js'
import { MAX_TRANSPOSE, sanitizeDetails } from '../shared/session.js'
import { readSettings, updateSettings } from './settings.js'
import { createSession, isSessionId, listSessions, readSession, sessionPath, updateSession } from './sessions.js'

// ~/Library/Application Support/Resonant/sessions on macOS
const sessionsDir = () => join(app.getPath('userData'), 'sessions')

// Dev only: uses the project's Python venv. Packaging will need a bundled interpreter.
const processingDir = () => join(app.getAppPath(), 'processing')
const pythonPath = () => join(processingDir(), '.venv', 'bin', 'python')

// Dev only: built by `npm run build:chordino`. Chords are skipped while it's missing.
const chordinoPath = () => join(app.getAppPath(), 'native', 'chordino', 'build', 'chordino')
const availableChordino = () => (existsSync(chordinoPath()) ? chordinoPath() : undefined)

// Dev only: built by `npm run build:native`. Packaging will need to ship it unpacked.
const audioAddonPath = () => join(app.getAppPath(), 'native', 'audio-engine', 'build', 'Release', 'resonant_audio.node')

// Native audio engine (instrument monitoring), in its own process
const audioHost = createAudioHost({
  fork: () => {
    if (!existsSync(audioAddonPath())) throw new Error('The audio engine isn\'t built. Run: npm run build:native')
    return utilityProcess.fork(join(__dirname, 'audio-host.js'), [], {
      serviceName: 'Resonant Audio',
      env: { ...process.env, RESONANT_AUDIO_ADDON: audioAddonPath() },
    })
  },
  onMessage: (message) => audio.handleMessage(message),
  onExit: (crashed) => audio.handleExit(crashed),
})

// Every window hears about audio state and meters
const sendToWindows = (channel, data) => {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, data)
}

const audio = createAudioController({
  host: audioHost,
  readAudio: async () => (await readSettings(app.getPath('userData'))).audio,
  saveAudio: (changes) => updateSettings(app.getPath('userData'), 'audio', changes),
  // Interface inputs count as the microphone for macOS privacy
  ensureMicAccess: async () => {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return
    if (status === 'not-determined' && (await systemPreferences.askForMediaAccess('microphone'))) return
    throw new Error('Resonant needs microphone access to hear your interface. Allow it in System Settings → Privacy & Security → Microphone.')
  },
  send: sendToWindows,
})

// Recording takes (written by the engine) and the loopback calibration
const recorder = createRecorder({
  call: (method, ...args) => audioHost.call(method, ...args),
  audioState: () => audio.state(),
  sessionsDir,
  saveAudio: async (changes) => {
    await updateSettings(app.getPath('userData'), 'audio', changes)
    sendToWindows('audio:state', await audio.state())
  },
  trash: (path) => shell.trashItem(path),
  tempDir: () => app.getPath('temp'),
})

// Key changes (Rubber Band renders of the stems)
const renderer = createRenderer({
  sessionsDir,
  onProgress: (sessionId, progress) => sendToWindows('render:progress', { sessionId, ...progress }),
})

const enqueue = createJobQueue()
// Session id → AbortController, for every job that is queued or running
const jobs = new Map()

registerSchemePrivileges()

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Resonant',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Block the window from navigating away, e.g. when a file is dropped outside the dropzone
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  // Dev: load from the Vite dev server (hot reload). Prod: load the built files.
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Saves a change to session.json and pushes the new state to the window that started it
async function updateAndNotify(webContents, id, changes) {
  const session = await updateSession(sessionsDir(), id, changes)
  if (!webContents.isDestroyed()) webContents.send('session:updated', session)
  return session
}

async function processSession(webContents, session, signal) {
  const { id } = session
  // Callbacks fire synchronously as lines arrive; chain their writes so they
  // land in order and a late one can't overwrite the final result
  let writes = Promise.resolve()
  const queueUpdate = (changes) => {
    writes = writes.then(() => updateAndNotify(webContents, id, changes))
  }
  // Built up as processing produces files; always saved whole so updates never drop a key
  let files = { ...session.files }

  try {
    const result = await runProcessing({
      pythonPath: pythonPath(),
      scriptPath: join(processingDir(), 'process.py'),
      inputPath: sessionPath(sessionsDir(), id, session.files.original),
      outputDir: sessionPath(sessionsDir(), id),
      chordinoPath: availableChordino(),
      signal,
      onProgress: (stage, percent) => queueUpdate({ status: stage, progress: percent ?? null }),
      // Saved right away so the reference plays (with its waveform) while analysis and Demucs run
      onReference: ({ reference, peaks }) => {
        files = { ...files, reference, peaks: { ...files.peaks, reference: peaks } }
        queueUpdate({ files })
      },
      // Saved right away so key/BPM show while Demucs is still running
      onAnalysis: (analysis) => queueUpdate({ analysis }),
      onChords: (chords) => queueUpdate({ chords }),
    })
    await writes
    files = { ...files, stems: result.stems, peaks: { ...files.peaks, ...result.peaks } }
    await updateAndNotify(webContents, id, { status: 'ready', progress: null, files, error: null })
  } catch (err) {
    await writes.catch(() => {})
    if (err instanceof CancelledError) {
      // Remove half-written output; the original (and reference.wav, if finished) stay
      await Promise.all(
        ['stems.tmp', 'reference.tmp.wav'].map((name) =>
          rm(sessionPath(sessionsDir(), id, name), { recursive: true, force: true }),
        ),
      )
      await updateAndNotify(webContents, id, { status: 'cancelled', progress: null, error: null })
      return
    }
    await updateAndNotify(webContents, id, { status: 'failed', progress: null, error: err.message })
  }
}

ipcMain.handle('session:import', async (event, sourcePath) => {
  const session = await createSession(sessionsDir(), sourcePath)
  // Start processing in the background; the UI follows along via 'session:updated'
  const controller = new AbortController()
  jobs.set(session.id, controller)
  enqueue(() => processSession(event.sender, session, controller.signal)).finally(() =>
    jobs.delete(session.id),
  )
  return session
})

// Stops a running job, or drops it from the queue if it hasn't started.
// The session ends up with status 'cancelled' (sent via 'session:updated').
ipcMain.handle('session:cancel', (_event, id) => {
  if (!isSessionId(id)) throw new Error('Invalid session id')
  jobs.get(id)?.abort()
})

// Song details form: name, artist, time signature. Only those fields can be changed this way.
ipcMain.handle('session:update-details', async (event, id, details) => {
  if (!isSessionId(id)) throw new Error('Invalid session id')
  return updateAndNotify(event.sender, id, sanitizeDetails(details))
})

// Chords for a song imported before chord detection existed (its stems are reused).
// Runs in the processing queue; repeated requests share one run. Resolves with the
// updated session, which every window also gets via 'session:updated'.
const chordJobs = new Map() // session id → promise
const needsChords = (session) => session.status === 'ready' && !!session.files.stems && session.chords == null

function findChords(id) {
  if (!chordJobs.has(id)) {
    const job = (async () => {
      const session = await readSession(sessionsDir(), id)
      if (!needsChords(session)) {
        if (session.chords != null) return session
        throw new Error('Chords are found once stem splitting finishes')
      }
      const chordino = availableChordino()
      if (!chordino) throw new Error("Chord detection isn't built. Run: npm run build:chordino")
      const chords = await enqueue(() =>
        runChordDetection({
          pythonPath: pythonPath(),
          scriptPath: join(processingDir(), 'process.py'),
          outputDir: sessionPath(sessionsDir(), id),
          chordinoPath: chordino,
        }),
      )
      const updated = await updateSession(sessionsDir(), id, { chords })
      sendToWindows('session:updated', updated)
      return updated
    })()
    chordJobs.set(id, job)
    job.finally(() => chordJobs.delete(id)).catch(() => {})
  }
  return chordJobs.get(id)
}

// At startup: queue every older song that has stems but no chords yet
async function backfillChords() {
  if (!availableChordino()) return
  for (const session of await listSessions(sessionsDir())) {
    if (needsChords(session)) findChords(session.id).catch((err) => console.warn(`Chords for ${session.id}: ${err.message}`))
  }
}

ipcMain.handle('session:detect-chords', (_event, id) => {
  if (!isSessionId(id)) throw new Error('Invalid session id')
  return findChords(id)
})

ipcMain.handle('session:list', () => listSessions(sessionsDir()))

ipcMain.handle('session:get', async (_event, id) => {
  if (!isSessionId(id)) throw new Error('Invalid session id')
  return readSession(sessionsDir(), id)
})

// Resolves with { trackId: file path in the session } in this key, rendering first if
// needed. (Speed is applied live in the player, so renders are always at 100%.) A newer
// request for the session cancels this one: it then resolves with { cancelled: true }
// (a rejection would log an error in the page).
ipcMain.handle('render:prepare', async (_event, id, transpose) => {
  if (!isSessionId(id)) throw new Error('Invalid session id')
  if (!Number.isInteger(transpose) || Math.abs(transpose) > MAX_TRANSPOSE) throw new Error('Invalid key change')
  const session = await readSession(sessionsDir(), id)
  if (!session.files.reference) throw new Error("The song hasn't finished importing yet")
  if (!['ready', 'cancelled', 'failed'].includes(session.status)) {
    throw new Error('Key changes are available once stem splitting finishes')
  }
  try {
    return { files: await renderer.prepare(id, session.files, 1, transpose) }
  } catch (err) {
    if (err instanceof RenderCancelledError) return { cancelled: true }
    throw err
  }
})

// Audio interface and instrument monitoring (native engine)
ipcMain.handle('audio:list-interfaces', () => audio.listInterfaces())
ipcMain.handle('audio:get-state', () => audio.state())
ipcMain.handle('audio:set-device', (_event, changes) => audio.setDevice(sanitizeDeviceSettings(changes)))
ipcMain.handle('audio:connect', () => audio.connect())
ipcMain.handle('instruments:get', async () => {
  const { tracks } = (await readSettings(app.getPath('userData'))).instruments
  try {
    return sanitizeInstruments(tracks)
  } catch {
    return DEFAULT_INSTRUMENTS // hand-edited or from an older version
  }
})
ipcMain.handle('instruments:save', async (_event, tracks) => {
  await updateSettings(app.getPath('userData'), 'instruments', { tracks: sanitizeInstruments(tracks) })
})
ipcMain.handle('audio:set-track', (_event, index, settings) => audio.setTrack(index, sanitizeTrack(index, settings)))
ipcMain.handle('audio:clear-track', (_event, index) => {
  sanitizeTrack(index, { left: 0, right: -1, gain: 1, pan: 0, monitor: true }) // validates the index
  return audio.clearTrack(index)
})

// Recording. The page that starts it stops it; if that page closes or reloads
// first, what was recorded is still saved.
let stopWatchingRecorder = () => {}
function watchRecorder(webContents) {
  const abandon = () => {
    stopWatchingRecorder()
    recorder
      .abandon()
      .then((result) => result?.session && sendToWindows('session:updated', result.session))
      .catch((err) => console.warn(`Recording: ${err.message}`))
  }
  webContents.once('destroyed', abandon)
  webContents.once('did-start-loading', abandon)
  stopWatchingRecorder = () => {
    webContents.off('destroyed', abandon)
    webContents.off('did-start-loading', abandon)
    stopWatchingRecorder = () => {}
  }
}

ipcMain.handle('recording:start', async (event, sessionId, tracks, options) => {
  const result = await recorder.start(sessionId, tracks, options)
  watchRecorder(event.sender)
  return result
})
ipcMain.handle('recording:reference', (_event, reference) => recorder.reference(reference))
ipcMain.handle('recording:stop', async (_event, segments) => {
  stopWatchingRecorder()
  const result = await recorder.stop({ segments })
  if (result?.session) sendToWindows('session:updated', result.session)
  return result
})
ipcMain.handle('recording:set-active-take', async (_event, sessionId, track, takeId) => {
  const session = await recorder.setActiveTake(sessionId, track, takeId)
  sendToWindows('session:updated', session)
  return session
})
ipcMain.handle('recording:delete-take', async (_event, sessionId, takeId) => {
  const session = await recorder.deleteTake(sessionId, takeId)
  sendToWindows('session:updated', session)
  return session
})
ipcMain.handle('recording:calibrate-start', async (event, inputChannel) => {
  await recorder.startCalibration(inputChannel)
  watchRecorder(event.sender)
})
ipcMain.handle('recording:calibrate-finish', (_event, expectedMs) => {
  stopWatchingRecorder()
  return recorder.finishCalibration(expectedMs)
})

// Export: the page renders the WAV; main asks where to save it. Resolves with the
// saved path, or null if the dialog was cancelled.
const MAX_EXPORT_BYTES = 2 * 1024 ** 3
const savedExports = new Set() // paths this run saved, the only ones reveal will show
ipcMain.handle('export:save', async (event, name, data) => {
  if (typeof name !== 'string' || !name.endsWith('.wav') || name.length > 255) throw new Error('Invalid file name')
  if (!(data instanceof ArrayBuffer || ArrayBuffer.isView(data)) || data.byteLength > MAX_EXPORT_BYTES) {
    throw new Error('Invalid export')
  }
  const window = BrowserWindow.fromWebContents(event.sender)
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: 'Export',
    defaultPath: join(app.getPath('downloads'), basename(name)),
    filters: [{ name: 'WAV audio', extensions: ['wav'] }],
  })
  if (canceled || !filePath) return null
  await writeFile(filePath, data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  savedExports.add(filePath)
  return filePath
})
ipcMain.handle('export:reveal', (_event, path) => {
  if (savedExports.has(path)) shell.showItemInFolder(path)
})

app.whenReady().then(() => {
  handleSessionProtocol(sessionsDir)
  createWindow()
  // Open the chosen audio interface, if there is one
  audio.connect()
  // Chords for songs imported before chord detection existed
  backfillChords().catch((err) => console.warn(`Chord backfill: ${err.message}`))

  // macOS: re-open a window when the dock icon is clicked and none are open
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Stop the engine (and release the interface) when the app quits
app.on('will-quit', () => {
  audioHost.kill()
  renderer.cancelAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
