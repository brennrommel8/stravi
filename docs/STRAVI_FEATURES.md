# Stravi Features and API Reference

This document reflects the current implementation in this repository.
If this file and code disagree, code is the source of truth.

## Introduction

<table>
  <tr>
    <td width="40%" valign="top">
      <h3>Build Fast APIs with Stravi</h3>
      <p>
        Stravi is a lightweight Node.js backend framework focused on speed,
        clear middleware flow, and built-in essentials like validation, cookies,
        security middleware, and websocket routes.
      </p>
      <p>
        The primary app setup is shown on the right side for quick copy/paste.
      </p>
    </td>
    <td width="60%" valign="top">
      <pre><code class="language-ts">import { Stravi } from 'stravi'
import cors from 'stravi/cors'

const app = new Stravi()
app.use(cors())

app.get('/', (sc) => {
  return sc.json({ message: 'Hello Stravi' })
})

app.start(3000)</code></pre>
  </td>
  </tr>
</table>

## Runtime and Package Surface

- Node requirement: `>=18`
- Package type: ESM (`"type": "module"`)
- Main export: `Stravi`
- Middleware/utility subpath exports:
  - `stravi/cors`
  - `stravi/validator`
  - `stravi/static`
  - `stravi/logger`
  - `stravi/security`
  - `stravi/dev` (CLI module path)
- CLI bin:
  - `stravi-dev`

## Main Exports (`Stravi`)

```ts
import {
  Stravi,
  Router,
  HttpError,
  HttpException,
  StraviError,
  v,
  ValidationError
} from 'stravi'
```

Type exports include:

- `StraviContext`
- `RouteSchema`
- `Middleware`
- `Handler`
- `RouteFn`
- `ErrorHandler`
- `CorsOptions`
- `CookieOptions`
- `Validator`
- `StraviOptions`
- `RouterInstance`
- `StraviWebSocket`
- `StraviWebSocketContext`
- `StraviWebSocketHandler`

## Core App: `Stravi`

### Constructor

```ts
const app = new Stravi()
const appWithEnv = new Stravi({ env: { SERVICE_NAME: 'api' } })
const appWithLimit = new Stravi({ bodyLimit: 1_048_576 }) // 1MB
```

- `env` merges `process.env` plus `options.env`, then becomes readonly in `sc.env`.
- `bodyLimit` caps request payload size in bytes. If exceeded, Stravi returns `413 Payload Too Large`.

### Methods

- `use(...middleware)`
- `use(path, ...middleware)` scoped by path prefix
- `onError(handler)` custom error handler
- `route(path, router)` mount a `Router`
- `ws(path, handler)` register a WebSocket route
- HTTP methods: `get`, `post`, `put`, `patch`, `delete`, `options`
- `start(port = 3000, host = '0.0.0.0')`
- `stop()`

### Route schema validation (built in)

You can provide a schema object as the second argument in route registration:

```ts
app.post('/users/:id', {
  params: z.object({ id: z.string() }),
  body: z.object({ name: z.string().min(2) })
}, handler)
```

- Supported schema keys: `params`, `query`, `body`, `headers`, `cookies`
- Each validator must support `parse(input, ...args)`
- Validation runs before your handler
- On validation failure, response is:
  - status `400`
  - body:
    ```json
    { "error": "Validation Error", "issues": ["..."] }
    ```
- Parsed values are injected back into context, so `await sc.body()` returns validated body inside handler.

## Request Context: `StraviContext` (`sc`)

Core fields:

- `sc.req`, `sc.res`
- `sc.path` (normalized pathname without trailing slash except `/`)
- `sc.url` (`URL`)
- `sc.params`
- `sc.env`
- `sc.state` (per-request mutable bag)

Input helpers:

- `sc.param()` / `sc.param(name)` / `sc.param(name, defaultValue)`
- `sc.query()` / `sc.query(name, defaultValue)`
- `await sc.body()`
- `sc.headers()` / `sc.headers(name)`
- `sc.cookies.get(name)`
- `sc.cookies.set(name, value, options)`
- `sc.cookies.delete(name, options)`
- `sc.cookies.all()`

Response helpers:

- `sc.status(code)`
- `sc.set(name, value)`
- `sc.redirect(location, status = 302)`
- `sc.cookie(name, value, options)` (shortcut)
- `sc.clearCookie(name, options)` (shortcut)
- `sc.json(value, status?)`
- `sc.text(value, status?)`
- `sc.html(value, status?)`

### Body parsing behavior

`await sc.body()` parses once and memoizes result:

- `application/json` -> parsed JSON
- `multipart/form-data` -> object with string and `File` values
- `application/x-www-form-urlencoded` -> object from form fields
- `text/*` -> string
- other content types -> `Buffer`
- empty body -> `null`

## Router Module: `Router`

```ts
import { Router } from 'stravi'

const router = new Router()
router.get('/posts/:id', handler)
app.route('/api', router)
```

Supports:

- `router.use(...middleware)`
- `router.use(path, ...middleware)`
- `router.route(path, childRouter)`
- `router.ws(path, handler)`
- HTTP methods: `get`, `post`, `put`, `patch`, `delete`, `options`

Behavior:

- Mount prefixes are normalized (`/api` + `/posts` -> `/api/posts`)
- Path params use `:name` segments
- Param values are decoded with `decodeURIComponent`

## WebSocket Support (Built In)

Register websocket endpoints directly on the app:

```ts
app.ws('/chat/:room', {
  open(sc) {
    sc.ws.json({ type: 'welcome', room: sc.params.room })
  },
  message(sc, data) {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    sc.broadcastJson({ type: 'message', room: sc.params.room, text }, true)
  },
  close(sc, code, reason) {
    console.log('closed', code, reason)
  },
  error(sc, err) {
    console.error('ws error', err)
  }
})
```

WebSocket handler hooks:

- `open(sc)`
- `message(sc, data, isBinary)`
- `close(sc, code, reason)`
- `error(sc, error)`

`StraviWebSocketContext` helpers:

- `sc.ws.send(...)`
- `sc.ws.json(...)`
- `sc.ws.close(code?, reason?)`
- `sc.clients` (all connected clients for that ws route)
- `sc.broadcast(data, includeSelf = false)`
- `sc.broadcastJson(value, includeSelf = false)`

Context data available in ws handlers:

- `sc.params` (route params, e.g. `:room`)
- `sc.query` (parsed query object)
- `sc.path`, `sc.url`
- `sc.env`, `sc.state`

For a full guide (auth patterns, production notes, browser/node client examples), see:
- `docs/WEBSOCKET.md`

## Error Handling

Use `HttpError` for explicit HTTP failures:

```ts
throw new HttpError(401, 'Unauthorized')
```

Aliases:

- `HttpException` (extends `HttpError`)
- `StraviError` (extends `HttpError`)

Default error behavior:

- If `HttpError`: returns `{ error, details? }` with its status code
- Otherwise: status `500`, body `{ error: 'Internal Server Error' }`
- In `NODE_ENV=development`, generic 500 may include `message`

You can override with:

```ts
app.onError((err, sc) => sc.json({ error: 'custom' }, 500))
```

## Return Value Auto-Send Rules

If a handler returns a value and you do not directly end the response:

- `undefined`:
  - route missing -> `404 { error: 'Not Found' }`
  - route exists but HTTP method is not registered -> `405 { error: 'Method Not Allowed' }` and `Allow` header
  - route matched -> `204` with empty body (if status not set)
- `Buffer` -> raw response
- `string` -> `text/plain`
- `object` -> JSON
- other primitives -> converted to string and sent as text

## Built-in Middleware

## 1) CORS (`Stravi/cors`)

```ts
import cors from 'stravi/cors'
app.use(cors())
```

Options:

- `origin?: '*' | string | string[] | ((origin: string) => boolean)` (default `'*'`)
- `methods?: string[]` (default `GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS`)
- `headers?: string[] | string`
- `credentials?: boolean` (default `false`)
- `maxAge?: number`

Behavior:

- Sets `Access-Control-Allow-*` headers
- For `OPTIONS`, returns `204` immediately

## 2) Logger (`Stravi/logger`)

```ts
import logger from 'stravi/logger'
app.use(logger())
```

Options:

- `logger?: { info(message), error(message) }` (defaults to `console`)

Behavior:

- Logs request completion on `finish` with timing
- Logs thrown middleware/handler errors before rethrowing

## 3) Static Files (`Stravi/static`)

```ts
import serveStatic from 'stravi/static'
app.use(serveStatic({ root: './public' }))
```

Options:

- `root: string` (required)
- `prefix?: string` (default `/`)
- `index?: string` (default `index.html`)
- `maxAge?: number`
- `immutable?: boolean`
- `fallthrough?: boolean` (default `true`)

Behavior:

- Handles only `GET` and `HEAD`
- Resolves paths safely (blocks path traversal with `403`)
- Unknown file:
  - `fallthrough=true`: calls `next()`
  - `fallthrough=false`: returns `404`
- Sets `Content-Type` and `Content-Length`
- Optional `Cache-Control` from `maxAge`/`immutable`

## 4) Security (`Stravi/security`)

```ts
import { secureHeaders, rateLimit, csrf, getCsrfToken } from 'stravi/security'
```

### `secureHeaders(options?)`

Helmet-style headers with configurable toggles:

- `X-Content-Type-Options` (default on)
- `X-Frame-Options` (default `SAMEORIGIN`)
- `Referrer-Policy` (default `no-referrer`)
- `Content-Security-Policy` (default `default-src 'self'`)
- `Cross-Origin-Opener-Policy` (default `same-origin`)
- `Cross-Origin-Resource-Policy` (default `same-origin`)
- `X-DNS-Prefetch-Control` (default `off`)
- `X-Permitted-Cross-Domain-Policies` (default `none`)
- `X-XSS-Protection: 0` (default on)
- HSTS when HTTPS is detected

### `rateLimit(options?)`

Options:

- `limit?: number` (default `100`)
- `windowMs?: number` (default `60000`)
- `headerPrefix?: 'standard' | 'legacy' | 'both' | 'none'` (default `both`)
- `statusCode?: number` (default `429`)
- `message?: string | object` (default `{ error: 'Too Many Requests' }`)
- `store?: RateLimitStore` (default in-memory store)
- `keyGenerator?: (sc) => string`
- `trustProxy?: boolean`

Behavior:

- Sets rate-limit headers
- On overflow, sets `Retry-After` and returns configured message

### `csrf(options?)` and `getCsrfToken(...)`

`csrf` middleware:

- Issues/synchronizes a signed CSRF token cookie
- Exposes token in response header (default `X-CSRF-Token`)
- Enforces token on unsafe methods (`POST/PUT/PATCH/DELETE/...`)
- Accepts token from:
  - header (default `x-csrf-token`)
  - body field (default `_csrf`)
  - query field (default `_csrf`)
- On mismatch returns `403 { error: 'Invalid CSRF token' }`

Production secret rules:

- Uses `options.secret`, or `STRAVI_CSRF_SECRET`
- In production, throws if secret is missing
- In non-production, falls back to in-memory random secret

## Validator Package (`Stravi/validator` and root `v`)

```ts
import v from 'stravi/validator'
```

Available validators:

- `v.string().min(n)`
- `v.number().int()`
- `v.boolean()`
- `v.optional(validator)`
- `v.array(validator)`
- `v.object({ ...shape })`
- `v.enum(['a', 'b'] as const)`

Errors:

- Throws `ValidationError` with `issues: string[]`
- Stravi route schema middleware catches this and responds with `400`

## Dev CLI: `stravi-dev`

```bash
stravi-dev src/index.ts
stravi-dev src/index.ts -- --inspect
```

Behavior:

- Uses `node --watch --enable-source-maps`
- Adds `--import tsx` automatically for TS entry files (`.ts/.tsx/.mts/.cts`)
- Pass-through args after `--`

## Scaffolder Package: `create-stravi`

Separate package in this repo: `packages/create-stravi`.

Usage:

```bash
npm create stravi@latest my-api
```

What it does:

- Validates project name (`[a-zA-Z0-9-_]+`)
- Copies template files to a new directory
- Rewrites template `package.json` name to your project name
- Removes `compilerOptions.paths` from generated `tsconfig.json` (if present)
- Prints next steps based on detected package manager (`npm`, `pnpm`, `yarn`, `bun`)

Template app includes:

- `src/index.ts` basic Stravi server
- `dev` script: `stravi-dev src/index.ts`

## Type-Safe Route Example

```ts
import { Stravi } from 'stravi'
import { z } from 'zod'

const app = new Stravi()

app.post(
  '/packages/:id',
  {
    params: z.object({ id: z.string() }),
    body: z.object({ name: z.string().min(2) })
  },
  async (sc) => {
    const body = await sc.body() // typed + runtime validated
    return sc.json({ id: sc.params.id, name: body.name }, 201)
  }
)
```

## Notes and Current Limits

- Body parse errors (invalid JSON) bubble to error handler (default `500`)
- Duplicate route registration for the same method/path keeps the first route handler set
- Router path params are single-segment params (`:id`), no wildcard/glob syntax
