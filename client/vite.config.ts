import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:8765',
        ws: true,
      },
      '/health': {
        target: 'http://localhost:8765',
      },
    },
  },
});
