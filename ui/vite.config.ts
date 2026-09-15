import { execFileSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'
export default defineConfig({
  // DBX renders the workbench from an about:srcdoc iframe during preview.
  // Relative ES module imports resolve against about:srcdoc and silently leave
  // the iframe empty, so preview assets must use the dev server origin.
  base: process.env.DBX_PREVIEW_ORIGIN || './',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { environment: 'jsdom', globals: true, setupFiles: './src/test-setup.ts' },
  plugins: [react(), tailwindcss(), { name: 'dbx-build-signal', closeBundle() { execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/inline-ui-assets.mjs', import.meta.url))], {stdio: 'inherit'}); console.log('DBX_UI_BUILD_SUCCESS') } }],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    assetsInlineLimit: 100_000_000,
    modulePreload: false,
    // The DBX preview embeds the document as about:srcdoc. Keep the runtime
    // in one inline module so it does not need to resolve/import sibling files
    // from the opaque srcdoc origin.
    rolldownOptions: { output: { codeSplitting: false, format: 'es' } },
  }
})
