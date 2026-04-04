import { defineConfig } from "tsdown";

export default defineConfig({
  treeshake: {
    moduleSideEffects: false, // Aggressively remove unused imports
  },
  dts: false,
  minify: {
    codegen: true, // Remove comments and newlines
    compress: true, // Simplify code where possible
    mangle: false, // Keep variable and function names intact
  },
  outExtensions: () => ({ js: ".js" }),
  exports: true,
  failOnWarn: true,
});
