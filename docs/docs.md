# Repository commands

## Create a package

```bash
pnpm turbo gen
```

## Deploy with Vercel

The root `package.json` pins pnpm 10. Vercel must use the same version through Corepack or the build
can fail with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` for `packageExtensionsChecksum`.

1. Open **Settings**, then **Environment Variables** in the Vercel project.
2. Set `ENABLE_EXPERIMENTAL_COREPACK` to `1` for all environments.
3. Redeploy the project.
