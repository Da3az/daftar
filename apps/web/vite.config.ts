import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/**
 * Where the dev server proxies API calls. Overridable so two stacks can run side
 * by side — the legacy API on its seeded database at :3000, and an exchange API
 * on `daftar_exchange` somewhere else — without editing this file.
 */
const apiTarget = process.env['API_PROXY_TARGET'] ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    port: 5173,
    strictPort: true,

    /*
     * The API is proxied rather than called cross-origin.
     *
     * Two reasons. The obvious one is that it keeps CORS out of development
     * entirely. The one that matters more: the production build is static files
     * served from the same origin as the API, so proxying in development means
     * requests are same-origin in both — a relative `/v1/...` fetch works
     * unchanged, and there is no `VITE_API_URL` that can be wrong in one
     * environment and right in the other.
     */
    proxy: {
      '/v1': { target: apiTarget, changeOrigin: true },
      '/health': { target: apiTarget, changeOrigin: true },
      '/docs': { target: apiTarget, changeOrigin: true },
    },
  },

  build: {
    // Static output. No SSR, no server process for the frontend.
    outDir: 'dist',
    sourcemap: true,
  },
});
