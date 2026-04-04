import path from "node:path"
import { fileURLToPath } from "node:url"
import withVercelToolbar from "@vercel/toolbar/plugins/next"
import { createJiti } from "jiti"

const jiti = createJiti(fileURLToPath(import.meta.url))
const __dirname = path.dirname(fileURLToPath(import.meta.url))

jiti.import("./src/env")

// import MillionLint from "@million/lint"
import createMDX from "@next/mdx"

/**
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  /** Enables hot reloading for local packages without a build step */
  transpilePackages: [
    "@unprice/trpc",
    "@unprice/db",
    "@unprice/stripe",
    "@unprice/ui",
    "@unprice/auth",
    "@unprice/config",
    "@unprice/tailwind-config",
  ],
  output: process.env.NEXT_OUTPUT_STANDALONE === "1" ? "standalone" : undefined,
  pageExtensions: ["ts", "tsx", "mdx"],
  images: {
    domains: ["images.unsplash.com"],
  },
  swcMinify: true,
  allowedDevOrigins: ["localhost", "app.localhost", "*.localhost"],
  // Optimize CSS loading
  compiler: {
    removeConsole: process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false,
  },
  experimental: {
    turbo: {},
    outputFileTracingRoot: path.join(__dirname, "../../"),
    // ppr: true, // TODO: activate later
    mdxRs: true,
    optimizePackageImports: [
      "@unprice/ui",
      "@unprice/trpc",
      "@unprice/auth",
      "@unprice/db",
      "framer-motion",
      "lucide-react",
    ],
    // instrumentationHook: process.env.NODE_ENV === "production",
  },
  /**
   * This is a workaround to allow us to use inside api a path alias
   * TODO: remove when api is deployed as an app
   */
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      // "#": path.resolve(__dirname, "../../internal/trpc/src/"),
      "@duckdb/duckdb-wasm/dist/duckdb-node.cjs": "@duckdb/duckdb-wasm/dist/duckdb-browser.cjs",
      "@duckdb/duckdb-wasm/dist/duckdb-node": "@duckdb/duckdb-wasm/dist/duckdb-browser.mjs",
    }
    return config
  },
  /** We already do linting and typechecking as separate tasks in CI */
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
}

const withMDX = createMDX()

// Export the combined config
export default withVercelToolbar()(withMDX(nextConfig))

// TODO: try to use million
// export default MillionLint.next({
//   rsc: true,
//   filter: {
//     include: "**.{mtsx,mjsx,tsx,jsx}",
//   },
// })(withMDX()(nextConfig))

// TODO: https://www.flavienbonvin.com/reduce-next-js-bundle/
