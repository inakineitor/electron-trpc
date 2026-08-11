/// <reference types="vitest" />
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  build: {
    // Importantly, `main` build runs first and empties the out dir
    emptyOutDir: false,
    lib: {
      entry: path.resolve(currentDirectory, './index.ts'),
      name: 'electron-trpc',
      formats: ['es', 'cjs'],
      fileName: (format) => ({ es: 'renderer.mjs', cjs: 'renderer.cjs' })[format as 'es' | 'cjs'],
    },
    outDir: path.resolve(currentDirectory, '../../dist'),
  },
});
