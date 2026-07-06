declare global {
  namespace NodeJS {
    interface ProcessEnv {
      [key: string]: string | undefined
      SKIP_ENV_VALIDATION?: string
      npm_lifecycle_event?: string
    }
  }
}

export {}
