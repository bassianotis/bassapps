import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Bassapps sign-in pages (sign in, Account). In development Vite serves them and passes
// /door-api to the service (service/bin/door.ts) as one origin; built, the service serves them
// itself (DOOR_STATIC=dist).
const port = Number(process.env.DOOR_UI_PORT ?? 5175)
const service = process.env.DOOR_API ?? 'http://127.0.0.1:3102'

export default defineConfig({
  root: 'pages',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port,
    strictPort: true,
    proxy: {
      // Keep the browser's Host (the service checks Origin against it) and pass its address on
      '/door-api': { target: service, changeOrigin: false, xfwd: true },
    },
  },
})
