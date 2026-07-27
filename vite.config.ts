import { defineConfig } from "vite";
import { nitro } from "nitro/vite";
import { solidStart } from "@solidjs/start/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    solidStart(),
    tailwindcss(),
    nitro({
      features: {
        websocket: true,
      },
      routes: {
        "/api/refresh": "./server/routes/api/refresh.ts",
        "/api/refresh-status": "./server/routes/api/refresh-status.ts",
      },
    }),
  ]
});
