import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [
    /*
     * MUST come before the react plugin. The router plugin generates
     * routeTree.gen.ts from the files in src/routes, and the react plugin would
     * otherwise transform the stale tree from the previous run.
     */
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    port: 5173,
    strictPort: true,

    fs: {
      /*
       * The Evidence page inlines `docs/evidence/*.md` via `import.meta.glob`,
       * which is outside this app's root. Vite's dev server refuses to serve
       * files outside the project root by default — correctly — so the repo
       * root is allowed explicitly.
       *
       * This only affects the dev server. In a production build the markdown is
       * already in the bundle, so nothing reads the filesystem at runtime.
       */
      allow: [fileURLToPath(new URL('../..', import.meta.url))],
    },

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
      '/v1': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/docs': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },

  build: {
    // Static output. No SSR, no server process for the frontend.
    outDir: 'dist',
    sourcemap: true,
  },
});
