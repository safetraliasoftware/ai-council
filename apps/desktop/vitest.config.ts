import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./src/renderer/src/i18n/test-setup.ts']
  }
})
