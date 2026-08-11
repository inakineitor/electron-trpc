/// <reference types="vitest" />
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    coverage: {
      all: true,
      include: ['src/**/*'],
      reporter: ['text', 'cobertura', 'html'],
      reportsDirectory: path.resolve(import.meta.dirname, './coverage/'),
    },
  },
});
