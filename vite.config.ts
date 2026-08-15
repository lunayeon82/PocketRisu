import { defineConfig } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import wasm from "vite-plugin-wasm";
import strip from '@rollup/plugin-strip';
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

// https://vitejs.dev/config/
export default defineConfig(({command, mode}) => {
  return {
    define: {
      '__APP_VERSION__': JSON.stringify(pkg.version),
      // Debug aid: lets a real device confirm it's actually running the JS
      // bundle from the latest deploy (vs a stale cached one) — baked in at
      // build time, so it changes on every rebuild regardless of package
      // version. See CLAUDE.md's durable-buffering-on-Vertex investigation.
      '__BUILD_TIME__': JSON.stringify(new Date().toISOString()),
    },
    plugins: [
      svelte({
        preprocess: vitePreprocess(),
        onwarn: (warning, handler) => {
          // disable a11y warnings
          if (warning.code.startsWith("a11y-")) return;
          handler(warning);
        },
      }),
      tailwindcss(),
      wasm(),
      command === 'build' ? strip({
        include: '**/*.(mjs|js|svelte|ts)',
        functions: ['console.log', 'console.debug', 'console.table', 'assert.*'],
      }) : null
    ],

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    // prevent vite from obscuring rust errors
    clearScreen: false,
    // tauri expects a fixed port, fail if that port is not available
    server: {
      host: '0.0.0.0', // listen on all addresses
      port: 5174,
      strictPort: true,
      // hmr: false,
    },
    // to make use of `TAURI_ENV_DEBUG` and other env variables
    // https://v2.tauri.app/reference/environment-variables/
    envPrefix: ["VITE_", "TAURI_"],
    build: {
      target:'baseline-widely-available',
      // don't minify for debug builds
      minify: process.env.TAURI_ENV_DEBUG === 'true' ? false : 'oxc',
      // produce sourcemaps for debug builds
      sourcemap: process.env.TAURI_ENV_DEBUG === 'true',
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        input: {
          main: 'index.html',
          settings: 'settings.html',
          chat: 'chat.html',
        },
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            // Only katex/highlight.js: both are already eager (imported at the
            // top of parser.svelte.ts, the core chat parser), so isolating them
            // just moves their bytes out of the app-code chunk for caching/
            // parallelism — no laziness to preserve, so no risk.
            //
            // monaco-editor/wasmoon/transformers/web-llm/pyodide/pdfjs-dist/three
            // are deliberately NOT bucketed here: they're only ever reached via
            // dynamic import(), and Rollup's default splitting already isolates
            // them into their own async chunks correctly. Naming them explicitly
            // was tried and caused Rollup to statically link those chunks into
            // the eager graph (confirmed via build: vendor-monaco and
            // vendor-wasmoon both ended up modulepreloaded on every entry,
            // undoing the wasmoon lazy-load fix) — so leave them alone.
            if (id.includes('/katex/')) return 'vendor-katex'
            if (id.includes('highlight.js')) return 'vendor-highlight'
          },
        },
      },
    },
    
    optimizeDeps:{
      exclude: [
        "@browsermt/bergamot-translator"
      ],
      needsInterop:[
        "@mlc-ai/web-tokenizers"
      ]
    },

    resolve:{
      alias:{
        'src':'/src',
        '$lib':'/src/lib',
      }
    },
    worker: {
      format: 'es'
    }
}
});
