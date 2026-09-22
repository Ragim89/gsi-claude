import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const pkg = (p: string) => fileURLToPath(new URL(`../../packages/${p}`, import.meta.url));

// Workspace packages are consumed as TypeScript source (no pre-build step for the web app).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@gsi/ui-kit/react', replacement: pkg('ui-kit/src/react/index.tsx') },
      { find: '@gsi/ui-kit', replacement: pkg('ui-kit/src/index.ts') },
      { find: '@gsi/shared-types', replacement: pkg('shared-types/src/index.ts') },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:3000', changeOrigin: true },
    },
  },
});
