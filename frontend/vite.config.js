import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Safety net: VITE_* values end up in the public JavaScript, so refuse to
  // build if anyone puts the simulator control token there.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  if (env.VITE_SIM_CONTROL_TOKEN) {
    throw new Error("VITE_SIM_CONTROL_TOKEN must not be set: it would be published in the website bundle. Remove it from .env files.");
  }
  return config;
});

const config = {
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: {
    port: 5173, // the API's CORS allow-list expects this port
    strictPort: true,
    fs: { allow: [".", "../config"] }, // mock mode reads the shared station/threshold config
  },
};
