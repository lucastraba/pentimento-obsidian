import { defineConfig } from 'eslint/config'
import obsidianmd from 'eslint-plugin-obsidianmd'

// The rules Obsidian's plugin review applies, including the type-checked ones.
export default defineConfig([
  { ignores: ['main.js', 'node_modules/**', 'test/**', '*.mjs'] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.*'] },
      },
    },
  },
])
