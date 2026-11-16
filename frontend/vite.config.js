import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: {
    port: 5173, // the API's CORS allow-list expects this port
    strictPort: true,
    fs: { allow: [".", "../config"] }, // mock mode reads the shared station/threshold config
  },
});
