import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";

// `npm run dev:lan` serves over HTTPS on the local network so phones can use
// the camera (browsers only allow it on https or localhost).
export default defineConfig(({ mode }) => ({
  plugins: [
    ...(mode == "lan" ? [basicSsl()] : []),
    // Installable app: a shop gets RAPIDÉWMS in the Windows Start menu or on an
    // Android home screen, in its own window, and it opens without internet.
    //
    // The service worker precaches the app itself — including the Lao font and
    // the scanner and export chunks, which are loaded on demand and would
    // otherwise need the network the first time they are used. It deliberately
    // does NOT cache Supabase responses: stale stock is worse than no stock.
    // Until the offline write queue exists, the app opens offline but still
    // needs the network to load or save a shop's real data.
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["icon.svg", "icon-maskable.svg"],
      manifest: {
        name: "RAPIDÉWMS",
        short_name: "RAPIDÉWMS",
        description: "Inventory and warehouse app for small shops in Laos.",
        theme_color: "#07050f",
        background_color: "#06040d",
        display: "standalone",
        // Relative, so the same build works at the site root and under the
        // /rapidewms/ sub-path that GitHub Pages serves.
        start_url: ".",
        scope: ".",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
        ],
      },
      workbox: {
        // The barcode decoder's WebAssembly is precached: scanning is daily
        // work and has to keep going when the connection drops.
        globPatterns: ["**/*.{js,css,html,svg,woff2}", "**/assets/zxing_reader-*.wasm"],
        globIgnores: [
          // Every browser that can run this app reads woff2; the .woff copies
          // Fontsource ships beside them would be precached and never used.
          "**/*.woff",
          // The export libraries are ~1.4 MB together and a shop opens them
          // rarely. Precaching them would put that on every install, over a
          // phone connection. They are cached on first use instead (below), so
          // the second export works offline and the first still needs internet.
          // The scanner chunk is NOT here: scanning is daily work in a shop and
          // has to keep working when the connection drops.
          "**/assets/xlsx-*.js",
          "**/assets/jspdf*.js",
          "**/assets/jszip*.js",
          "**/assets/html2canvas-*.js",
          "**/assets/index.es-*.js",
          "**/assets/purify.es-*.js",
          // The on-device AI model's runtime (~580 KB, plus a 27 MB engine and
          // the model itself). Only shops that use "Identify" ever load it.
          "**/assets/transformers.web-*.js",
        ],
        // Serve the app shell for a navigation the network can't answer.
        navigateFallback: "index.html",
        runtimeCaching: [
          {
            // Filenames carry a content hash, so a cached copy can never be stale.
            urlPattern: /\/assets\/(xlsx|jspdf|jszip|html2canvas|index\.es|purify\.es)[-.][^/]*\.js$/,
            handler: "CacheFirst",
            options: {
              cacheName: "rapidewms-export-libs",
              expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 180 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // The AI runtime and its engine, kept after first use.
            urlPattern: /\/assets\/(transformers\.web|ort-wasm)[-.][^/]*$/,
            handler: "CacheFirst",
            options: {
              cacheName: "rapidewms-ai-runtime",
              expiration: { maxEntries: 6, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // The date reader's engine and English data, fetched from the CDN
            // the first time a date is read and kept, so later reads work offline.
            // (The AI model's own files are kept by the library in its own cache.)
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/(tesseract\.js|tesseract\.js-core|@tesseract\.js-data)@/,
            handler: "CacheFirst",
            options: {
              cacheName: "rapidewms-ocr",
              expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  // `npm run share` puts the dev server behind a Cloudflare tunnel (real HTTPS).
  server: { allowedHosts: [".trycloudflare.com"] },
}));
