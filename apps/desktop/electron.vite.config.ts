import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Prepended to the main-process bundle. If this file is still executed with
// ELECTRON_RUN_AS_NODE (editor terminals), re-spawn Electron as a real app
// so `require('electron').app` exists. See scripts/run-electron-vite.cjs.
const reexecIfRunAsNode =
  'if(process.env.ELECTRON_RUN_AS_NODE){delete process.env.ELECTRON_RUN_AS_NODE;const r=require("child_process").spawnSync(process.execPath,process.argv.slice(1),{stdio:"inherit",env:process.env,windowsHide:false});process.exit(r.status===null?1:r.status);}'

// Internal workspace packages point straight at TypeScript source (no build
// step of their own) - they must be bundled/compiled by electron-vite, not
// left as bare `require('@ai-council/...')` calls the Node runtime can't
// resolve to .ts files. Only real published npm deps get externalized.
const workspacePackages = [
  '@ai-council/shared',
  '@ai-council/council-core',
  '@ai-council/providers',
  '@ai-council/coding',
  '@ai-council/project-domain',
  '@ai-council/task-graph',
  '@ai-council/council-participants'
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        // Optional native accelerators for `ws` (pulled in transitively by
        // an SDK) - `ws` itself try/catches these requires at runtime, but
        // Rollup can't resolve them statically since they're not installed.
        external: ['bufferutil', 'utf-8-validate'],
        output: {
          // The provider SDKs (openai/undici) emit extra main-process chunks
          // that `require("./index.js")` — re-entering the Electron entry
          // before `app` exists.
          inlineDynamicImports: true,
          banner: reexecIfRunAsNode
        }
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
