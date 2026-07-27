import path from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Shared backend/frontend wire contracts — single source of truth.
      '@contracts': path.resolve(__dirname, '../functions/src/shared/contracts.ts'),
    },
  },
})
