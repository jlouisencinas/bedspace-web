import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// One id per build, baked into the bundle and written to dist/version.json: an open tab compares the two (src/lib/appVersionCheck.js).
const BUILD_ID = (process.env.VERCEL_GIT_COMMIT_SHA || 'local') + '-' + Date.now()

const versionFile = (buildId) => ({
  name: 'bedspace-version-file',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId }) })
  },
})

export default defineConfig(({ command }) => {
  const buildId = command === 'build' ? BUILD_ID : 'dev'
  return {
    plugins: [react(), versionFile(buildId)],
    define: { __APP_BUILD_ID__: JSON.stringify(buildId) },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
      },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.{js,jsx}', 'supabase/functions/_shared/**/*.test.ts'],
      setupFiles: ['./src/test/setup.js'],
    },
  }
})
