baseline:
	pnpm build:baseline
	sh ./scripts/run-baseline.sh dist/baseline.js

lifecycle:
	pnpm build:lifecycle
	docker run --env-file .env --rm --network=host -i grafana/k6 run - < dist/lifecycle.js

latency:
	pnpm build:latency
	sh ./scripts/run-k6.sh dist/latency.js

budgets:
	pnpm build:budgets
	sh ./scripts/run-k6.sh dist/budgets.js
