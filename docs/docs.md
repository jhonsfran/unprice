# create a new package

```bash
pnpm turbo gen
```

# Vercel deployment

This repo uses **pnpm 10** (`packageManager` in root `package.json`). To avoid `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` (packageExtensionsChecksum), Vercel must use the same version via Corepack:

1. In the Vercel project: **Settings → Environment Variables**
2. Add: `ENABLE_EXPERIMENTAL_COREPACK` = `1` (all environments)
3. Redeploy
