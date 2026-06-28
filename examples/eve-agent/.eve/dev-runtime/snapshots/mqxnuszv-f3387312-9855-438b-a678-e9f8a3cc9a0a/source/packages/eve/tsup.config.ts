import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  // Eve is ESM-only, so this adapter ships ESM-only too.
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: ['eve', 'eve/tools', 'nominee', 'zod'],
})
