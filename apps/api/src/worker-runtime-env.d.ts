import type { Env as RuntimeEnv } from "~/env"

declare global {
  namespace Cloudflare {
    interface Env extends RuntimeEnv {}
  }
}

declare module "cloudflare:test" {
  interface ProvidedEnv extends RuntimeEnv {}
}

export {}
