import { app, BrowserWindow, ipcMain } from 'electron'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CancelledError, createJobQueue, runProcessing } from './processing.js'
import { handleSessionProtocol, registerSchemePrivileges } from './protocol.js'
import { sanitizeDetails } from '../shared/session.js'
import { createSession, isSessionId, listSessions, readSession, sessionPath, updateSession } from './sessions.js'

// ~/Library/Application Support/Resonant/sessions on macOS
const sessionsDir = () => join(app.getPath('userData'), 'sessions')

// Dev only: uses the project's Python venv. Packaging will need a bundled interpreter.
const processingDir = () => join(app.getAppPath(), 'processing')
const pythonPath = () => join(processingDir(), '.venv', 'bin', 'python')

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
      signal,
      onProgress: (stage, percent) => queueUpdate({ status: stage, progress: percent ?? null }),
      // Saved right away so the reference plays (with its waveform) while analysis and Demucs run
      onReference: ({ reference, peaks }) => {
        files = { ...files, reference, peaks: { ...files.peaks, reference: peaks } }
        queueUpdate({ files })
      },
      // Saved right away so key/BPM show while Demucs is still running
      onAnalysis: (analysis) => queueUpdate({ analysis }),
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

ipcMain.handle('session:list', () => listSessions(sessionsDir()))

ipcMain.handle('session:get', async (_event, id) => {
  if (!isSessionId(id)) throw new Error('Invalid session id')
  return readSession(sessionsDir(), id)
})

app.whenReady().then(() => {
  handleSessionProtocol(sessionsDir)
  createWindow()

  // macOS: re-open a window when the dock icon is clicked and none are open
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
