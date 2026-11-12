import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  base: "/flyneuro/",
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist-static", emptyOutDir: true },
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
})
