import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Internal workspace packages point straight at TypeScript source (no build
// step of their own) - they must be bundled/compiled by electron-vite, not
// left as bare `require('@ai-council/...')` calls the Node runtime can't
// resolve to .ts files. Only real published npm deps get externalized.
const workspacePackages = [
  '@ai-council/shared',
  '@ai-council/council-core',
  '@ai-council/providers',
  '@ai-council/coding'
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        // Optional native accelerators for `ws` (pulled in transitively by
        // an SDK) - `ws` itself try/catches these requires at runtime, but
        // Rollup can't resolve them statically since they're not installed.
        external: ['bufferutil', 'utf-8-validate']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
