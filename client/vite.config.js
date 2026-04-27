import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Output straight into the Express server's static folder
    outDir: path.resolve(__dirname, '../server/public'),
    emptyOutDir: true,
  },
  // In dev, proxy /api calls to the Express backend
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
