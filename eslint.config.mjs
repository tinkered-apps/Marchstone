// ESLint's recommended rules, run by `npm test`. The app has no build step, so
// this is the only thing that reads every file before it ships.

import js from '@eslint/js';
import globals from 'globals';

export default [
  // public/vendor/ is other people's code, copied in as released.
  { ignores: ['node_modules/', 'test-results/', 'playwright-report/', '.wrangler/', 'public/vendor/'] },

  js.configs.recommended,
  // An unused name in `catch (error)` is harmless and the app ships those as written.
  { rules: { 'no-unused-vars': ['error', { caughtErrors: 'none' }] } },

  // Leaflet is loaded by a plain <script> tag before the modules and sets the global L.
  { files: ['public/**/*.js'], languageOptions: { sourceType: 'module', globals: { ...globals.browser, L: 'readonly' } } },
  // Classic scripts: the privacy page's own script and the service worker.
  { files: ['public/privacy.js'], languageOptions: { sourceType: 'script' } },
  { files: ['public/sw.js'], languageOptions: { sourceType: 'script', globals: globals.serviceworker } },

  { files: ['test/**', '*.js', '*.mjs'], languageOptions: { globals: globals.node } },
  // Playwright specs run in Node and hand callbacks to the page.
  // Playwright reads the fixture list from the first parameter, so a hook that needs none writes `({}, testInfo)`.
  {
    files: ['e2e/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }] },
  },
];
