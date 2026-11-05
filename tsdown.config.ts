import { defineConfig } from 'tsdown'

/**
 * Two bundles, built apart on purpose:
 *
 *  - the Host half is plain ESM for node, with every `@deepseek-ai/*` package
 *    left external because the harness provides them;
 *  - the browser half is CommonJS with react external, then wrapped into the
 *    harness's `window.__ModuleLoader__.load({ id, factory })` container by
 *    `scripts/postbuild.mjs` - the same shape every installed client bundle has.
 */
export default defineConfig([
  {
    name: 'host',
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    dts: true,
    clean: true,
    target: 'node22',
    external: [/^node:/, /^@deepseek-ai\//],
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  },
  {
    name: 'client',
    entry: { 'client.raw': 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    clean: false,
    target: 'es2022',
    jsx: 'react-jsx',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', /^@deepseek-ai\//],
    outExtensions: () => ({ js: '.cjs' }),
  },
])