import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // The app shell is precached, so the app opens with no network. The
    // service worker registers from its own file, never an inline script.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script',
      includeAssets: ['icon.svg', 'apple-touch-icon.png', 'fonts/*.woff2'],
      manifest: {
        name: 'DFAI Lite',
        short_name: 'DFAI Lite',
        description: 'Fast markdown notes over a GitHub repository.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#f6f6f7',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
        shortcuts: [{ name: 'New note', url: '/#/new' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: 'index.html',
      },
    }),
  ],
  // The one chunk past Vite's 500 kB is CodeMirror's, loaded after the first paint.
  build: { chunkSizeWarningLimit: 600 },
  preview: { port: 4791, strictPort: true },
});
