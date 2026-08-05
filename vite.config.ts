import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig({
    plugins: [react(), tailwindcss()],
    define: {
      __CIRQLE_DEPLOYMENT_ENV__: JSON.stringify(
        process.env.VERCEL_ENV || 'local',
      ),
    },
    build: {
      manifest: true,
      // esbuild 0.28 does not downlevel destructuring for Safari 14.0.
      // Safari 14.1 is the oldest supported WebKit release.
      target: [
        'es2020',
        'chrome87',
        'edge88',
        'firefox78',
        'safari14.1',
      ],
      rollupOptions: {
        output: {
          manualChunks(id) {
            const moduleId = id.replace(/\\/g, '/');
            if (!moduleId.includes('/node_modules/')) return undefined;
            if (
              moduleId.includes('/node_modules/firebase/firestore') ||
              moduleId.includes('/node_modules/@firebase/firestore')
            ) {
              return 'vendor-firestore';
            }
            if (
              moduleId.includes('/node_modules/firebase/auth') ||
              moduleId.includes('/node_modules/@firebase/auth')
            ) {
              return 'vendor-firebase-auth';
            }
            if (
              moduleId.includes('/node_modules/firebase/') ||
              moduleId.includes('/node_modules/@firebase/')
            ) {
              return 'vendor-firebase-core';
            }
            if (
              moduleId.includes('/node_modules/react/') ||
              moduleId.includes('/node_modules/react-dom/') ||
              moduleId.includes('/node_modules/react-router')
            ) {
              return 'vendor-react';
            }
            if (moduleId.includes('/node_modules/framer-motion/')) {
              return 'vendor-motion';
            }
            if (moduleId.includes('/node_modules/lucide-react/')) {
              return 'vendor-icons';
            }
            return undefined;
          },
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
});
