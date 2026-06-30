baseline:
	pnpm build:baseline
	sh ./scripts/run-baseline.sh dist/baseline.js

lifecycle:
	pnpm build:lifecycle
	docker run --env-file .env --rm --network=host -i grafana/k6 run - < dist/lifecycle.js

ingestion-failures:
	pnpm build:ingestion-failures
	sh ./scripts/run-k6.sh dist/ingestion-failures.js

budgeted-runs:
	pnpm build:budgeted-runs
	sh ./scripts/run-k6.sh dist/budgeted-runs.js
