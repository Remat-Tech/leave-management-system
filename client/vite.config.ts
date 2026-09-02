import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The development server, and the one decision in it that is not a default.
 *
 * **`/api` is proxied to the API rather than called cross-origin**, so that everything
 * the browser does happens on one origin. That is what makes two decisions on the server
 * side hold: `routes/app.ts` mounts no CORS, and the session cookie is `SameSite=Strict`,
 * which is standing in for a CSRF token and only works while no cross-origin request ever
 * carries it.
 *
 * The alternative — calling `http://localhost:3000` directly and relaxing both — would
 * mean development and production differing in exactly the arrangement that decides
 * whether a cookie is safe. In production the two are behind one host by deployment, and
 * this is the development equivalent rather than a convenience.
 *
 * `changeOrigin` is off deliberately: the API is on localhost either way, and rewriting
 * the Host header would hide a misconfiguration rather than surface it.
 */
export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.PORT ?? '3000'}`,
        changeOrigin: false,
      },
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
