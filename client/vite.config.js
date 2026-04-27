import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 8899,
    proxy: {
      '/api': 'http://localhost:7766',
      '/downloads': 'http://localhost:7766',
    },
  },
});
