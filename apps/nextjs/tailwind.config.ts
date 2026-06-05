import type { Config } from "tailwindcss"

import { unPriceTailwindPreset } from "@unprice/tailwind-config"

const config: Config = {
  content: ["src/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "../../internal/ui/src/**/*.{ts,tsx}"],
  darkMode: "class",
  presets: [unPriceTailwindPreset],
}

export default config
