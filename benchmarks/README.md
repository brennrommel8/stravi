# Benchmarks

Compares Stravi vs Express vs Hono on equivalent endpoints using `autocannon`.

## Run

```bash
npm install
npm run bench
```

## Custom run

```bash
node benchmarks/run.js --duration 20 --connections 200 --pipelining 10 --endpoint /json
```

With repeated rounds (recommended for stable comparison):

```bash
node benchmarks/run.js --duration 20 --connections 200 --pipelining 10 --endpoint /json --rounds 5
```

## Notes

- Stravi server uses local build output from `dist/`.
- `npm run bench` runs `npm run build` first.
- Keep the same machine and Node version for fair comparisons.
