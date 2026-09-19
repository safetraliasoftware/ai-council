'use strict'

// VS Code, Cursor and other Electron-based editors put ELECTRON_RUN_AS_NODE=1
// in the integrated terminal. electron-vite then spawns Electron with that
// env inherited, so `require('electron')` is the npm stub (a binary path)
// and `app` is undefined. Strip it before launching.
delete process.env.ELECTRON_RUN_AS_NODE

const { spawn } = require('child_process')
const path = require('path')

const bin = path.join(path.dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js')
const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  cwd: path.resolve(__dirname, '..'),
  windowsHide: false
})
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
