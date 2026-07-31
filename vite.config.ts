import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        /**
         * Vendor chunking.
         *
         * These libraries change far less often than application code, so
         * splitting them lets a redeploy reuse the cached copies. Supabase is
         * separated because local demo mode never executes it — the browser
         * still fetches it, but it parses in its own chunk rather than
         * inflating the entry bundle.
         */
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-supabase': ['@supabase/supabase-js'],
          'vendor-ui': ['@radix-ui/react-dialog', '@radix-ui/react-slot', 'lucide-react'],
        },
      },
    },
    // The entry chunk is the thing an operator waits for; warn if it grows.
    chunkSizeWarningLimit: 350,
  },
})
