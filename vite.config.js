import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During development, the browser only talks to the Vite dev server (port 5173).
// Any request to /api is forwarded to the Express proxy (port 8787), which
// holds the ANTHROPIC_API_KEY. That way the key never reaches the browser and
// you only have to open one URL.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
