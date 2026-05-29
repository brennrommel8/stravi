# Stravi Orchestration Blueprint

## 1) Product Goal
Build **Stravi**, a Node.js backend framework that is:
- As fast and lightweight as Hono
- More batteries-included than Express (without heavy runtime cost)
- Predictable in production (observability, errors, lifecycle built-in)

## 2) Problems to Solve (Express/Node Pain Points)
1. Middleware chains add overhead and unclear flow.
2. Error handling is inconsistent (sync vs async).
3. Body parsing, validation, and schema handling are fragmented.
4. Built-in observability is weak by default.
5. Framework-level startup/lifecycle orchestration is minimal.

## 3) Stravi Design Principles
1. **Zero-cost abstractions first**: avoid runtime wrappers unless needed.
2. **Single context object** per request with stable shape for V8 optimization.
3. **Compile route handlers once** on startup.
4. **Built-ins are modular**: enabled by flags, tree-shakable where possible.
5. **Fail-fast bootstrap**: plugin and dependency checks at startup, not runtime.

## 4) Runtime Orchestration
### Boot Phase
1. Load config (`Stravi.config.ts|js`).
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
- `@Stravi/core`: app lifecycle, context, hooks
- `@Stravi/router`: high-performance route matcher
- `@Stravi/http`: request/response adapters
- `@Stravi/validation`: schema-first validation (optional)
- `@Stravi/security`: CORS, helmet-like headers, CSRF (optional)
- `@Stravi/observability`: logger, metrics, tracing adapters
- `@Stravi/testing`: request injector + test helpers

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
- Exposed as a first-party module import: `stravi/cors`.
- Configurable through `app.use(cors(options))`.
- Dev tooling should stay template-local or in a separate package, not in the runtime package.
- Built-in WebSocket routing via `app.ws('/path', { open, message, close, error })`.

## 7) Developer API (Simpler Than Express/Hono)
Syntax rules:
1. Use class construction: `new Stravi()`.
2. Route handlers use a single context param: `sc`.
3. Response helpers are on `sc` (`sc.json()`, `sc.text()`, `sc.html()`).
4. Error boundary is built-in via `app.onError(...)`.
5. Throw `HttpError` for status-aware failures.
6. Redirect + status helpers are first-class: `sc.redirect()`, `sc.status()`.
7. Cookie helpers are built-in: `sc.cookies.get/set/delete`, `sc.cookie()`, `sc.clearCookie()`.
8. Static file serving and logger are built-in middleware modules.
9. `app.use()` registers middleware globally.
10. `app.get()/post()/put()/delete()` is the primary route style.
11. Server boot uses `app.start(port)`.
12. Core request context is built-in: `sc.query`, `sc.body`, `sc.headers`, `sc.cookies`, `sc.state`, `sc.env`.
13. Route modules can use `Router` (`router.use/get/post/...`) and mount with `app.route('/prefix', router)`.
14. Realtime APIs are first-class with websocket routes: `app.ws('/chat/:room', handler)`.

```ts
import { Stravi } from 'stravi'
import cors from 'stravi/cors'

const app = new Stravi()

app.use(cors())

app.get('/', (sc) => {
  return sc.json({
    message: 'Hello Stravi'
  })
})

app.start(3000)
```

Error handling:
```ts
import { HttpError, Stravi } from 'stravi'

const app = new Stravi()

app.onError((err, sc) => {
  return sc.json({
    error: err instanceof Error ? err.message : 'Unknown error'
  }, 500)
})

app.get('/admin', () => {
  throw new HttpError(401, 'Unauthorized')
})
```

Response helpers:
```ts
app.get('/redirect', (sc) => sc.redirect('/home'))

app.get('/home', (sc) => {
  return sc.status(200).html('<h1>Home</h1>')
})
```

Built-in static + logger:
```ts
import logger from 'stravi/logger'
import serveStatic from 'stravi/static'

app.use(logger())
app.use(serveStatic({ root: './public' }))
```

Built-in security middleware:
```ts
import { csrf, rateLimit, secureHeaders } from 'stravi/security'

app.use(secureHeaders())
app.use(rateLimit({ windowMs: 60_000, limit: 100 }))
app.use(csrf({ secret: process.env.STRAVI_CSRF_SECRET }))
```

Route module style:
```ts
import { Router } from 'stravi'

const router = new Router()

router.use('/private', async (sc, next) => {
  // private middleware
  if (!next) return
  return next()
})

router.get('/posts/:id', (sc) => {
  return sc.text(`Post ${sc.param('id')}`)
})

// mount in main app: app.route('/api', router)
```

More examples:
```ts
app.get('/health', (sc) => sc.text('ok'))

app.get('/users/:id', (sc) => {
  return sc.json({ id: sc.params.id })
})

app.post('/users', async (sc) => {
  const body = await sc.body()
  return sc.json({ created: true, user: body }, 201)
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
  async (sc) => {
    const body = await sc.body()
    return sc.json({ id: sc.params.id, name: body.name })
  }
)
```

Built-in CORS:
```ts
import { Stravi } from 'stravi'
import cors from 'stravi/cors'

const app = new Stravi()
app.use(cors())

// Advanced config
const api = new Stravi()
api.use(cors({
  origin: ['https://app.example.com', 'https://admin.example.com'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  headers: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400
}))

// Per-route override
api.get('/public', cors({ origin: '*' }), (sc) => sc.text('ok'))
```

Built-in WebSocket routes:
```ts
app.ws('/chat/:room', {
  open(sc) {
    sc.ws.json({ type: 'welcome', room: sc.params.room })
  },
  message(sc, data) {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    sc.broadcastJson({ type: 'message', room: sc.params.room, text }, true)
  }
})
```

### Context API Expansion
```ts
// Query string: /search?q=Stravi&page=1
app.get('/search', (sc) => {
  const q = sc.query('q')           // single key
  const page = sc.query('page', 1)  // with default
  return sc.json({ q, page })
})

// Parsed request body (json/form/text auto by content-type)
app.post('/echo', async (sc) => {
  const data = await sc.body()
  return sc.json({ data })
})

// Headers (case-insensitive getter)
app.get('/agent', (sc) => {
  const ua = sc.headers('user-agent')
  return sc.json({ ua })
})

// Cookies
app.get('/session', (sc) => {
  const sid = sc.cookies.get('sid')
  if (!sid) sc.cookies.set('sid', 'new-session-id', { httpOnly: true, path: '/' })
  return sc.json({ sid: sid ?? 'new-session-id' })
})

// Per-request state bag
app.get('/me', (sc) => {
  sc.state.user = { id: 'u_1', role: 'admin' }
  return sc.json({ user: sc.state.user })
})

// Environment access (runtime + app-level bindings)
app.get('/runtime', (sc) => {
  return sc.json({
    nodeEnv: sc.env.NODE_ENV,
    service: sc.env.SERVICE_NAME
  })
})
```

Recommended behavior contracts:
1. `sc.query(name, defaultValue?)` returns decoded string (or provided default).
2. `await sc.body()` parses once and memoizes the result.
3. `sc.headers(name?)`:
   - with `name`: returns header value or `undefined`
   - without `name`: returns readonly normalized header map
4. `sc.cookies.get/set/delete` manages `Set-Cookie` safely.
5. `sc.state` is mutable per request only (never shared across requests).
6. `sc.env` is readonly and injected at app startup.
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
2. Implement `@Stravi/router` and `@Stravi/core` first.
3. Add benchmark harness (`autocannon`) before advanced features.
4. Freeze initial API surface after Milestone 1.




