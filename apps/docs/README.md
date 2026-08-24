# Unprice documentation

The public documentation lives in this directory and uses Mintlify.

## Development

Install the workspace dependencies, then start the preview from this directory:

```bash
pnpm install
pnpm dev
```

Run `pnpm exec mint validate` before you open a pull request.

## Publish a change

The Mintlify GitHub app deploys changes from the default branch.

### Troubleshooting

- If `pnpm dev` does not start after you change a page, restart the preview before you treat it as
  a configuration error.
- If a page returns 404, confirm that you started the command in this directory, next to
  `docs.json`.
