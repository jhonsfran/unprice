baseline:
	pnpm build:baseline
	sh ./scripts/run-baseline.sh dist/baseline.js

lifecycle:
	pnpm build:lifecycle
	docker run --env-file .env --rm --network=host -i grafana/k6 run - < dist/lifecycle.js
