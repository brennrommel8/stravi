# Stravix Orchestration Blueprint

## 1) Product Goal
Build **Stravix**, a Node.js backend framework that is:
- As fast and lightweight as Hono
- More batteries-included than Express (without heavy runtime cost)
- Predictable in production (observability, errors, lifecycle built-in)

## 2) Problems to Solve (Express/Node Pain Points)
1. Middleware chains add overhead and unclear flow.
2. Error handling is inconsistent (sync vs async).
3. Body parsing, validation, and schema handling are fragmented.
4. Built-in observability is weak by default.
5. Framework-level startup/lifecycle orchestration is minimal.

## 3) Stravix Design Principles
1. **Zero-cost abstractions first**: avoid runtime wrappers unless needed.
2. **Single context object** per request with stable shape for V8 optimization.
3. **Compile route handlers once** on startup.
4. **Built-ins are modular**: enabled by flags, tree-shakable where possible.
5. **Fail-fast bootstrap**: plugin and dependency checks at startup, not runtime.

## 4) Runtime Orchestration
### Boot Phase
1. Load config (`stravix.config.ts|js`).
2. Register plugins and built-in modules.
3. Compile route table + middleware graph.
4. Warm caches and precompute serializers.
5. Start HTTP server and expose lifecycle hooks.

### Request Phase
1. Router lookup (radix/prefix tree).
2. Create pooled request context.
3. Execute pre-handlers (auth, validation, rate limit).
4. Execute handler.
5. Execute post-handlers (transform, metrics, tracing).
6. Serialize response via fast path.

### Shutdown Phase
1. Stop accepting connections.
2. Drain inflight requests (timeout protected).
3. Run plugin cleanup hooks.
4. Flush logs/metrics and close resources.

## 5) Core Internal Modules
- `@stravix/core`: app lifecycle, context, hooks
- `@stravix/router`: high-performance route matcher
- `@stravix/http`: request/response adapters
- `@stravix/validation`: schema-first validation (optional)
- `@stravix/security`: CORS, helmet-like headers, CSRF (optional)
- `@stravix/observability`: logger, metrics, tracing adapters
- `@stravix/testing`: request injector + test helpers

## 6) Built-in Dependencies Strategy
Keep defaults small and optional:
- Required runtime: none beyond Node APIs where possible
- Optional peer modules:
  - `zod` or `valibot` for validation
  - `pino` for logging
  - `@opentelemetry/api` for tracing

Rule: every optional feature should be lazy-loaded or opt-in.

Built-in middleware:
- `cors` is built-in (no external install required).
- Exposed as a first-party module import: `stravix/cors`.
- Configurable through `app.use(cors(options))`.
- Built-in dev runner: `stravix-dev` (auto-restart on file changes, nodemon-like).

## 7) Developer API (Simpler Than Express/Hono)
Syntax rules:
1. Use class construction: `new Stravix()`.
2. Route handlers use a single context param: `svx`.
3. Response helpers are on `svx` (`svx.json()`, `svx.text()`, `svx.html()`).
4. Error boundary is built-in via `app.onError(...)`.
5. Throw `HttpError` for status-aware failures.
6. Redirect + status helpers are first-class: `svx.redirect()`, `svx.status()`.
7. Cookie helpers are built-in: `svx.cookies.get/set/delete`, `svx.cookie()`, `svx.clearCookie()`.
8. Static file serving and logger are built-in middleware modules.
9. `app.use()` registers middleware globally.
10. `app.get()/post()/put()/delete()` is the primary route style.
11. Server boot uses `app.start(port)`.
12. Core request context is built-in: `svx.query`, `svx.body`, `svx.headers`, `svx.cookies`, `svx.state`, `svx.env`.
13. Route modules can use `Router` (`router.use/get/post/...`) and mount with `app.route('/prefix', router)`.

```ts
import { Stravix } from 'stravix'
import cors from 'stravix/cors'

const app = new Stravix()

app.use(cors())

app.get('/', (svx) => {
  return svx.json({
    message: 'Hello Stravix'
  })
})

app.start(3000)
```

Error handling:
```ts
import { HttpError, Stravix } from 'stravix'

const app = new Stravix()

app.onError((err, svx) => {
  return svx.json({
    error: err instanceof Error ? err.message : 'Unknown error'
  }, 500)
})

app.get('/admin', () => {
  throw new HttpError(401, 'Unauthorized')
})
```

Response helpers:
```ts
app.get('/redirect', (svx) => svx.redirect('/home'))

app.get('/home', (svx) => {
  return svx.status(200).html('<h1>Home</h1>')
})
```

Built-in static + logger:
```ts
import logger from 'stravix/logger'
import serveStatic from 'stravix/static'

app.use(logger())
app.use(serveStatic({ root: './public' }))
```

Route module style:
```ts
import { Router } from 'stravix'

const router = new Router()

router.use('/private', async (svx, next) => {
  // private middleware
  if (!next) return
  return next()
})

router.get('/posts/:id', (svx) => {
  return svx.text(`Post ${svx.param('id')}`)
})

// mount in main app: app.route('/api', router)
```

More examples:
```ts
app.get('/health', (svx) => svx.text('ok'))

app.get('/users/:id', (svx) => {
  return svx.json({ id: svx.params.id })
})

app.post('/users', async (svx) => {
  const body = await svx.body()
  return svx.json({ created: true, user: body }, 201)
})
```

Zod-style validation (like Hono):
```ts
import { z } from 'zod'

app.post(
  '/users/:id',
  {
    params: z.object({ id: z.string() }),
    body: z.object({ name: z.string().min(2) })
  },
  async (svx) => {
    const body = await svx.body()
    return svx.json({ id: svx.params.id, name: body.name })
  }
)
```

Built-in CORS:
```ts
import { Stravix } from 'stravix'
import cors from 'stravix/cors'

const app = new Stravix()
app.use(cors())

// Advanced config
const api = new Stravix()
api.use(cors({
  origin: ['https://app.example.com', 'https://admin.example.com'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  headers: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400
}))

// Per-route override
api.get('/public', cors({ origin: '*' }), (svx) => svx.text('ok'))
```

### Context API Expansion
```ts
// Query string: /search?q=stravix&page=1
app.get('/search', (svx) => {
  const q = svx.query('q')           // single key
  const page = svx.query('page', 1)  // with default
  return svx.json({ q, page })
})

// Parsed request body (json/form/text auto by content-type)
app.post('/echo', async (svx) => {
  const data = await svx.body()
  return svx.json({ data })
})

// Headers (case-insensitive getter)
app.get('/agent', (svx) => {
  const ua = svx.headers('user-agent')
  return svx.json({ ua })
})

// Cookies
app.get('/session', (svx) => {
  const sid = svx.cookies.get('sid')
  if (!sid) svx.cookies.set('sid', 'new-session-id', { httpOnly: true, path: '/' })
  return svx.json({ sid: sid ?? 'new-session-id' })
})

// Per-request state bag
app.get('/me', (svx) => {
  svx.state.user = { id: 'u_1', role: 'admin' }
  return svx.json({ user: svx.state.user })
})

// Environment access (runtime + app-level bindings)
app.get('/runtime', (svx) => {
  return svx.json({
    nodeEnv: svx.env.NODE_ENV,
    service: svx.env.SERVICE_NAME
  })
})
```

Recommended behavior contracts:
1. `svx.query(name, defaultValue?)` returns decoded string (or provided default).
2. `await svx.body()` parses once and memoizes the result.
3. `svx.headers(name?)`:
   - with `name`: returns header value or `undefined`
   - without `name`: returns readonly normalized header map
4. `svx.cookies.get/set/delete` manages `Set-Cookie` safely.
5. `svx.state` is mutable per request only (never shared across requests).
6. `svx.env` is readonly and injected at app startup.
7. CORS preflight (`OPTIONS`) is handled automatically when `app.use(cors(...))` is registered.

## 8) Performance Orchestration
1. Benchmark against Express, Fastify, Hono with `autocannon`.
2. Track p50/p95 latency + req/s + memory under load.
3. Optimize hotspots:
   - context allocation
   - router lookup
   - response serialization
4. Add perf gates in CI (fail if regression > 5%).

## 9) Delivery Roadmap
### Milestone 1: Minimal Core (Week 1-2)
- Router + app lifecycle + handler execution
- JSON/text responses
- Global and route middleware

### Milestone 2: Safety + DX (Week 3-4)
- Unified error boundary
- Schema validation module
- Plugin API + hook system

### Milestone 3: Built-ins (Week 5-6)
- Logger integration
- Basic metrics
- Security presets

### Milestone 4: Hardening (Week 7-8)
- Perf profiling + benchmark suite
- Graceful shutdown + reliability tests
- Documentation and migration guide from Express

## 10) Governance Rules
1. No new dependency without a measurable DX or perf benefit.
2. Every module needs benchmark + test coverage before merge.
3. Public API changes require versioned RFC notes.

## 11) Immediate Next Actions
1. Scaffold monorepo packages listed in section 5.
2. Implement `@stravix/router` and `@stravix/core` first.
3. Add benchmark harness (`autocannon`) before advanced features.
4. Freeze initial API surface after Milestone 1.




