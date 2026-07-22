// @ts-check

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig({
  files: ['src/**/*.{js,ts}'],
  extends: [
    js.configs.recommended,
    tseslint.configs.recommendedTypeChecked,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked
  ],
  rules: {
    "@typescript-eslint/switch-exhaustiveness-check": "error"
  },
  languageOptions: {
    parserOptions: {
      projectService: true
    }
  }
});
