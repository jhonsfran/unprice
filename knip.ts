import type { KnipConfig } from "knip"

const config: KnipConfig = {
  ignoreDependencies: ["cz-conventional-changelog"],
  workspaces: {
    ".": {
      entry: ["turbo/generators/config.ts"],
    },
    "apps/api": {
      entry: ["scripts/generate-lakehouse-schemas.ts"],
      ignoreDependencies: ["@unprice/config"],
    },
    "internal/email": {
      ignoreDependencies: [
        "@react-email/button",
        "@react-email/head",
        "@react-email/html",
        "@react-email/tailwind",
        "react-email",
      ],
    },
    "tooling/tailwind": {
      ignoreDependencies: ["autoprefixer", "postcss"],
    },
    "internal/jobs": {
      entry: ["trigger.config.ts"],
    },
    "tooling/k6": {
      entry: ["lifecycle.js"],
    },
  },
}

export default config
