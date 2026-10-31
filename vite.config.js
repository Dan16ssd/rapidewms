import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// `npm run dev:lan` serves over HTTPS on the local network so phones can use
// the camera (browsers only allow it on https or localhost).
export default defineConfig(({ mode }) => ({
  plugins: mode == "lan" ? [basicSsl()] : [],
  // `npm run share` puts the dev server behind a Cloudflare tunnel (real HTTPS).
  server: { allowedHosts: [".trycloudflare.com"] },
}));
