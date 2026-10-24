import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node24',
  dts: true,
  clean: true,
  removeNodeProtocol: false,
  noExternal: [/^@plinthway\//u],
  external: ['@napi-rs/keyring', 'node:sqlite'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
