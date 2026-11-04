import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // audio-host runs in its own utility process (see src/main/audio-host.js)
        input: {
          index: resolve('src/main/index.js'),
          'audio-host': resolve('src/main/audio-host.js'),
        },
      },
    },
  },
  preload: {},
  renderer: {
    plugins: [react()],
  },
})
