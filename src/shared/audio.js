// Shared by the main process and the renderer.

export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'mp4', 'm4a', 'aac', 'flac', 'ogg']

// Accepts a file name or a full path (macOS or Windows separators)
export function isAudioFile(name) {
  const fileName = name.split(/[\\/]/).pop()
  const dot = fileName.lastIndexOf('.')
  // No dot means no extension; a leading dot is a hidden file, not an extension
  if (dot <= 0) return false
  return AUDIO_EXTENSIONS.includes(fileName.slice(dot + 1).toLowerCase())
}
