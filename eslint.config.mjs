/**
 * Flat ESLint config covering both packages:
 *  - functions/src  — TypeScript (Cloud Functions, ESM)
 *  - frontend/src   — Vue 3 SFCs + TypeScript
 *
 * Formatting is Prettier's job — lint rules here are correctness-only
 * (vue/flat/essential rather than the stylistic recommended preset).
 */
import pluginVue from 'eslint-plugin-vue'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'

export default defineConfigWithVueTs(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'functions/lib/**',
      'emulator-data/**',
      '**/*.d.ts',
    ],
  },
  pluginVue.configs['flat/essential'],
  vueTsConfigs.recommended,
  {
    rules: {
      // Intentional empty catches exist for best-effort paths (e.g. toast cleanup).
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Vendored shadcn-vue primitives keep their upstream single-word names.
    files: ['frontend/src/components/ui/**'],
    rules: { 'vue/multi-word-component-names': 'off' },
  },
)
