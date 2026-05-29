import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'


function loadForumConfig(desktop) {
  const file = path.join(desktop, 'forum.config.env')
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

export default defineConfig(() => {
  const desktop = path.resolve(__dirname, '..')
  const forum = loadForumConfig(desktop)
  for (const [key, value] of Object.entries(forum)) {
    if (key.startsWith('VITE_') && process.env[key] === undefined) {
      process.env[key] = value
    }
  }

  return {
    plugins: [react()],
    base: process.env.VITE_BASE || '/',
    server: {
      sourcemapIgnoreList(sourcePath) {
        return sourcePath.includes('node_modules/@duckdb')
      },
    },
    build: {
      // @capacitor-community/sqlite is loaded via a dynamic import in
      // pod-adapter-capacitor.js, which is itself only fetched on native
      // (Android / iOS) — see loadAdapter() in pod-adapter.js. We MUST
      // bundle the plugin's JS bridge into that lazy chunk; a bare module
      // specifier left in the output cannot be resolved by the WebView
      // at runtime ("failed to resolve module specifier"). Bundling it
      // does not bloat the browser path because the chunk is never
      // fetched there.
    },
  };
})