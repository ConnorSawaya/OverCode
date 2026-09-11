import { fileURLToPath, URL } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import solidPlugin from "vite-plugin-solid"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: fileURLToPath(new URL("../app/public", import.meta.url)),
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../app/src", import.meta.url)),
    },
  },
  plugins: [tailwindcss(), solidPlugin()],
  build: {
    target: "esnext",
    outDir: fileURLToPath(new URL("../app/dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
  define: {
    "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify("prod"),
    "import.meta.env.VITE_OVERCODE_MOBILE_UPDATE_URL": JSON.stringify(
      process.env.VITE_OVERCODE_MOBILE_UPDATE_URL ??
        "https://raw.githubusercontent.com/ConnorSawaya/overcode/overcode-rebrand/packages/mobile/update.json",
    ),
  },
  optimizeDeps: {
    include: ["solid-js"],
  },
})
