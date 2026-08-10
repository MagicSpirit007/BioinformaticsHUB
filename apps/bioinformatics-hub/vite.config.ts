import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import fs from 'node:fs'

const SITE_CATALOG_ID = 'virtual:site-catalog'
const RESOLVED_SITE_CATALOG_ID = `\0${SITE_CATALOG_ID}`

function bundledSiteCatalog() {
  return {
    name: 'bioinformatics-hub-site-catalog',
    resolveId(id: string) {
      return id === SITE_CATALOG_ID ? RESOLVED_SITE_CATALOG_ID : null
    },
    load(id: string) {
      if (id !== RESOLVED_SITE_CATALOG_ID) return null
      const raw = fs.readFileSync(path.resolve(__dirname, 'public/site-catalog.json'), 'utf8')
      return `export default ${raw}`
    },
  }
}

export default defineConfig({
  // Relative base so Electron loadFile / file:// can resolve assets
  base: './',
  // Bundle the public catalogue into the UI JavaScript as well as copying the
  // JSON to dist. This keeps Electron file:// builds independent of fetch().
  plugins: [react(), bundledSiteCatalog()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    open: true,
  },
})
