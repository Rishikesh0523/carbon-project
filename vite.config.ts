import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      // Include all necessary polyfills for Solana/Anchor
      include: ['buffer', 'crypto', 'util', 'stream', 'events'],
      // Whether to polyfill specific globals.
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      // Whether to polyfill `node:` protocol imports.
      protocolImports: true,
    })
  ],
  define: {
    global: 'globalThis',
    // Explicitly define process.env for compatibility
    'process.env': {},
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  optimizeDeps: {
    include: ['@solana/web3.js', '@coral-xyz/anchor', 'bn.js'],
  },
})