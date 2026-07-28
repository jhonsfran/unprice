# Changesets

Add a changeset when a pull request changes the published behavior of `@unprice/api`:

```bash
pnpm changeset
```

Choose:

- `patch` for backwards-compatible fixes and packaging corrections;
- `minor` for new public functionality or breaking changes before `1.0.0`;
- `major` only when deliberately publishing the stable `1.0.0` contract.

Pre-1.0 breaking changes must say `BREAKING` and include migration guidance. Repository-only
changes do not need an empty changeset.

After changesets merge to `main`, GitHub Actions creates or updates the release PR. Merging that
release PR immediately verifies and publishes `@unprice/api` through npm Trusted Publishing.
