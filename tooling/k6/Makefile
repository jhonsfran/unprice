lifecycle:
	pnpm build:lifecycle
	docker run --env-file .env --rm --network=host -i grafana/k6 run - < dist/lifecycle.js
