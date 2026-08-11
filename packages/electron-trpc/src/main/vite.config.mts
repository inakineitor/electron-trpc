/// <reference types="vitest" />
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  build: {
    lib: {
      entry: path.resolve(currentDirectory, './index.ts'),
      name: 'electron-trpc',
      formats: ['es', 'cjs'],
      fileName: (format) => ({ es: 'main.mjs', cjs: 'main.cjs' })[format as 'es' | 'cjs'],
    },
    outDir: path.resolve(currentDirectory, '../../dist'),
    rollupOptions: {
      external: ['electron'],
    },
  },
});
