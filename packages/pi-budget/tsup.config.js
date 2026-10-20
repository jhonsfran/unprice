import { defineConfig } from "tsup"
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  treeshake: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  bundle: true,
  dts: true,
})
