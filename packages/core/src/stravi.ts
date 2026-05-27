import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { createContext } from './context.js'
import { HttpError } from './http-exception.js'
import { pathMatchesPrefix, ensureAbsolutePath, Router as RouteGroup } from './router-builder.js'
import { Router as InternalRouter, normalizePath } from './router.js'
import { ValidationError } from '../../validator/src/index.js'
import { WebSocket, WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import type {
  ErrorHandler,
  EnvShape,
  Handler,
  StraviWebSocket,
  StraviWebSocketContext,
  StraviWebSocketHandler,
  RouteExecutor,
  StraviOptions,
  InternalStraviContext,
  RouteFn,
  RouteMatch,
  RouteSchema,
  RouteWithSchemaArgs,
  RouteWithoutSchemaArgs
} from './types.js'

async function runPipeline(stack: RouteFn[], sc: InternalStraviContext): Promise<unknown> {
  let idx = -1

  async function dispatch(i: number): Promise<unknown> {
    if (i <= idx) {
      throw new Error('next() called multiple times')
    }

    idx = i
    const fn = stack[i]
    if (!fn) return undefined

    if (fn.length >= 2) {
      return fn(sc, () => dispatch(i + 1))
    }

    const value = await (fn as Handler)(sc)
    if (value !== undefined) return value
    return dispatch(i + 1)
  }

  return dispatch(0)
}

function isSchemaInput(value: unknown): value is RouteSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return ['params', 'query', 'body', 'headers', 'cookies'].some((key) => key in candidate)
}

function makeValidationMiddleware(schema: RouteSchema): RouteFn<InternalStraviContext> {
  return async (sc: InternalStraviContext, next) => {
    try {
      if (schema.params) {
        const parsedParams = schema.params.parse(sc.params, 'params') as Record<string, string>
        sc._setParams(parsedParams)
      }

      if (schema.query) {
        const parsedQuery = schema.query.parse(sc.query(), 'query') as Record<string, unknown>
        sc._setQuery(parsedQuery)
      }

      if (schema.headers) {
        const parsedHeaders = schema.headers.parse(sc.headers(), 'headers') as Record<string, unknown>
        sc._setHeaders(parsedHeaders)
      }

      if (schema.cookies) {
        const parsedCookies = schema.cookies.parse(sc.cookies.all(), 'cookies') as Record<string, unknown>
        sc._setCookies(parsedCookies)
      }

      if (schema.body) {
        const rawBody = await sc.body()
        const parsedBody = schema.body.parse(rawBody, 'body')
        sc._setBody(parsedBody)
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        return sc.json(
          {
            error: 'Validation Error',
            issues: error.issues
          },
          400
        )
      }

      throw error
    }

    if (!next) return undefined
    return next()
  }
}

type MiddlewareEntry = {
  fn: RouteFn
  path: string
}

type WsRouteEntry<TEnv extends EnvShape> = {
  clients: Set<WebSocket>
  handler: StraviWebSocketHandler<TEnv>
}

const MAX_CACHE_ENTRIES = 2048

function splitPathSegments(pathname: string): string[] {
  if (pathname === '/') return []
  return pathname.slice(1).split('/')
}

function isPrefixMatchInvariantForRoute(routePath: string, prefixPath: string): boolean {
  const routeSegments = splitPathSegments(routePath)
  const prefixSegments = splitPathSegments(prefixPath)

  if (prefixSegments.length === 0) return true
  if (prefixSegments.length > routeSegments.length) return true

  for (let i = 0; i < prefixSegments.length; i += 1) {
    const routeSegment = routeSegments[i]
    const prefixSegment = prefixSegments[i]

    if (routeSegment.startsWith(':')) {
      return false
    }

    if (routeSegment !== prefixSegment) {
      return true
    }
  }

  return true
}

function setBoundedCache<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value
    if (firstKey !== undefined) {
      cache.delete(firstKey)
    }
  }

  cache.set(key, value)
}

function parseRequestTarget(target: string): { pathname: string; rawQuery: string } {
  if (!target) return { pathname: '/', rawQuery: '' }

  if (target.charCodeAt(0) !== 47) {
    const url = new URL(target)
    return {
      pathname: normalizePath(url.pathname),
      rawQuery: url.search.length > 1 ? url.search.slice(1) : ''
    }
  }

  const hashIndex = target.indexOf('#')
  const endIndex = hashIndex === -1 ? target.length : hashIndex
  const queryIndex = target.indexOf('?')

  if (queryIndex === -1 || queryIndex > endIndex) {
    const pathnameOnly = target.slice(0, endIndex) || '/'
    return { pathname: normalizePath(pathnameOnly), rawQuery: '' }
  }

  const pathname = target.slice(0, queryIndex) || '/'
  const rawQuery = target.slice(queryIndex + 1, endIndex)
  return { pathname: normalizePath(pathname), rawQuery }
}

function decodeQueryComponent(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, ' '))
}

function parseQueryObject(rawQuery: string): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {}
  if (!rawQuery) return out

  let start = 0
  for (let i = 0; i <= rawQuery.length; i += 1) {
    if (i !== rawQuery.length && rawQuery.charCodeAt(i) !== 38) continue

    const chunk = rawQuery.slice(start, i)
    start = i + 1
    if (!chunk) continue

    const eq = chunk.indexOf('=')
    if (eq === -1) {
      out[decodeQueryComponent(chunk)] = ''
      continue
    }

    const key = decodeQueryComponent(chunk.slice(0, eq))
    const value = decodeQueryComponent(chunk.slice(eq + 1))
    out[key] = value
  }

  return Object.freeze(out)
}

function compileRouteExecutor(stack: RouteFn[]): RouteExecutor<InternalStraviContext> {
  const hasNextMiddleware = stack.some((fn) => fn.length >= 2)

  // Fast path: plain handlers only, no next() middleware chain required.
  if (!hasNextMiddleware) {
    const handlers = stack as Handler[]
    return async (sc: InternalStraviContext) => {
      for (let i = 0; i < handlers.length; i += 1) {
        const value = await handlers[i](sc)
        if (value !== undefined) return value
      }
      return undefined
    }
  }

  const steps: Array<(sc: InternalStraviContext) => Promise<unknown>> = new Array(stack.length + 1)
  steps[stack.length] = async () => undefined

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const fn = stack[i]
    const nextStep = steps[i + 1]

    if (fn.length >= 2) {
      steps[i] = async (sc: InternalStraviContext) => {
        let called = false
        return fn(sc, async () => {
          if (called) throw new Error('next() called multiple times')
          called = true
          return nextStep(sc)
        })
      }
      continue
    }

    const handler = fn as Handler
    steps[i] = async (sc: InternalStraviContext) => {
      const value = await handler(sc)
      if (value !== undefined) return value
      return nextStep(sc)
    }
  }

  return steps[0]
}

function defaultErrorHandler(error: unknown, sc: InternalStraviContext): undefined {
  if (error instanceof HttpError) {
    const payload: Record<string, unknown> = { error: error.message }
    if (error.details !== undefined) payload.details = error.details
    return sc.json(payload, error.status)
  }

  const payload: Record<string, unknown> = { error: 'Internal Server Error' }
  if (process.env.NODE_ENV === 'development' && error instanceof Error) {
    payload.message = error.message
  }

  return sc.json(payload, 500)
}

export class Stravi<TEnv extends EnvShape = EnvShape> {
  private readonly router = new InternalRouter()
  private readonly wsRouter = new InternalRouter()
  private readonly middleware: MiddlewareEntry[] = []
  private readonly wsRoutes = new Map<string, WsRouteEntry<TEnv>>()
  private readonly wsServer = new WebSocketServer({ noServer: true })
  private readonly wsContexts = new WeakMap<WebSocket, StraviWebSocketContext<TEnv>>()
  private readonly middlewareCache = new Map<string, RouteFn[]>()
  private readonly routeExecutorCache = new Map<string, RouteExecutor<InternalStraviContext>>()
  private readonly middlewareRouteStabilityCache = new Map<string, boolean>()
  private middlewareVersion = 0
  private server: Server | null = null
  private readonly env: TEnv
  private readonly bodyLimit?: number
  private errorHandler: ErrorHandler<InternalStraviContext> = defaultErrorHandler

  constructor(options: StraviOptions<Record<string, string>> = {}) {
    const rawBodyLimit = options.bodyLimit
    this.bodyLimit =
      typeof rawBodyLimit === 'number' && Number.isFinite(rawBodyLimit)
        ? Math.max(0, Math.floor(rawBodyLimit))
        : undefined
    this.env = Object.freeze({
      ...process.env,
      ...(options.env || {})
    }) as TEnv
  }

  use(...fns: RouteFn[]): this
  use(path: string, ...fns: RouteFn[]): this
  use(pathOrFn: string | RouteFn, ...fns: RouteFn[]): this {
    let middlewarePath = '/'
    let handlers: RouteFn[]

    if (typeof pathOrFn === 'string') {
      middlewarePath = ensureAbsolutePath(pathOrFn)
      handlers = fns
    } else {
      handlers = [pathOrFn, ...fns]
    }

    if (handlers.length === 0) {
      throw new Error('use() requires at least one middleware function')
    }

    for (const fn of handlers.flat()) {
      if (typeof fn !== 'function') {
        throw new TypeError('Middleware must be a function')
      }
      this.middleware.push({ fn, path: middlewarePath })
    }
    this.middlewareVersion += 1
    this.middlewareCache.clear()
    this.routeExecutorCache.clear()
    this.middlewareRouteStabilityCache.clear()

    return this
  }

  onError(handler: ErrorHandler<InternalStraviContext>): this {
    if (typeof handler !== 'function') {
      throw new TypeError('Error handler must be a function')
    }

    this.errorHandler = handler
    return this
  }

  route(path: string, router: RouteGroup<TEnv>): this {
    const mountPath = ensureAbsolutePath(path)
    router.mount(this, mountPath)
    return this
  }

  get<Path extends string>(path: Path, ...handlers: RouteWithoutSchemaArgs<Path, TEnv>): this
  get<Path extends string, Schema extends RouteSchema>(path: Path, ...args: RouteWithSchemaArgs<Path, Schema, TEnv>): this
  get(path: string, ...args: unknown[]): this {
    return this.register('GET', path, args)
  }

  post<Path extends string>(path: Path, ...handlers: RouteWithoutSchemaArgs<Path, TEnv>): this
  post<Path extends string, Schema extends RouteSchema>(path: Path, ...args: RouteWithSchemaArgs<Path, Schema, TEnv>): this
  post(path: string, ...args: unknown[]): this {
    return this.register('POST', path, args)
  }

  put<Path extends string>(path: Path, ...handlers: RouteWithoutSchemaArgs<Path, TEnv>): this
  put<Path extends string, Schema extends RouteSchema>(path: Path, ...args: RouteWithSchemaArgs<Path, Schema, TEnv>): this
  put(path: string, ...args: unknown[]): this {
    return this.register('PUT', path, args)
  }

  patch<Path extends string>(path: Path, ...handlers: RouteWithoutSchemaArgs<Path, TEnv>): this
  patch<Path extends string, Schema extends RouteSchema>(path: Path, ...args: RouteWithSchemaArgs<Path, Schema, TEnv>): this
  patch(path: string, ...args: unknown[]): this {
    return this.register('PATCH', path, args)
  }

  delete<Path extends string>(path: Path, ...handlers: RouteWithoutSchemaArgs<Path, TEnv>): this
  delete<Path extends string, Schema extends RouteSchema>(path: Path, ...args: RouteWithSchemaArgs<Path, Schema, TEnv>): this
  delete(path: string, ...args: unknown[]): this {
    return this.register('DELETE', path, args)
  }

  options<Path extends string>(path: Path, ...handlers: RouteWithoutSchemaArgs<Path, TEnv>): this
  options<Path extends string, Schema extends RouteSchema>(path: Path, ...args: RouteWithSchemaArgs<Path, Schema, TEnv>): this
  options(path: string, ...args: unknown[]): this {
    return this.register('OPTIONS', path, args)
  }

  ws(path: string, handler: StraviWebSocketHandler<TEnv>): this {
    if (!path.startsWith('/')) {
      throw new Error(`WebSocket path must start with '/': ${path}`)
    }
    if (!handler || typeof handler !== 'object') {
      throw new TypeError('WebSocket handler must be an object')
    }

    const normalizedPath = ensureAbsolutePath(path)
    const routeKey = `GET ${normalizedPath}`
    if (this.wsRoutes.has(routeKey)) {
      throw new Error(`WebSocket route already registered: ${normalizedPath}`)
    }

    this.wsRouter.add('GET', normalizedPath, [], async () => undefined)
    this.wsRoutes.set(routeKey, {
      handler,
      clients: new Set()
    })

    return this
  }

  private register(method: string, path: string, rawArgs: unknown[]): this {
    if (!path.startsWith('/')) {
      throw new Error(`Route path must start with '/': ${path}`)
    }

    let schema: RouteSchema | undefined
    let handlers: RouteFn[]

    if (rawArgs.length > 0 && isSchemaInput(rawArgs[0])) {
      schema = rawArgs[0] as RouteSchema
      handlers = rawArgs.slice(1) as RouteFn[]
    } else {
      handlers = rawArgs as RouteFn[]
    }

    if (handlers.length === 0) {
      throw new Error(`${method} ${path} requires at least one handler`)
    }

    for (const fn of handlers) {
      if (typeof fn !== 'function') {
        throw new TypeError(`Route handlers for ${method} ${path} must be functions`)
      }
    }

    const routeHandlers: RouteFn[] = schema
      ? [makeValidationMiddleware(schema) as RouteFn, ...handlers]
      : handlers
    this.router.add(method, path, routeHandlers, compileRouteExecutor(routeHandlers))
    return this
  }

  async handle(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
    const host = req.headers.host || 'localhost'
    const requestTarget = req.url || '/'
    const { pathname, rawQuery } = parseRequestTarget(requestTarget)
    const method = (req.method || 'GET').toUpperCase()

    let match: RouteMatch | null = this.router.match(method, pathname)
    let methodsForPath: string[]
    let routeFound: boolean

    if (match && method !== 'OPTIONS') {
      methodsForPath = [method]
      routeFound = true
    } else {
      methodsForPath = this.router.methodsForPath(pathname)
      routeFound = methodsForPath.length > 0
    }

    if (!match && method === 'OPTIONS' && routeFound) {
      const anyPathMatch = this.router.matchAnyPath(pathname)
      if (anyPathMatch) {
        match = {
          routeKey: `OPTIONS ${pathname} __middleware_only`,
          params: anyPathMatch.params,
          handlers: anyPathMatch.handlers.filter((fn) => fn.length >= 2)
        }
      }
    }

    const methodNotAllowed = !match && routeFound && method !== 'OPTIONS'

    const sc = createContext({
      bodyLimit: this.bodyLimit,
      host,
      pathname,
      req,
      res,
      requestUrl: requestTarget,
      rawQuery,
      params: match?.params || {},
      env: this.env,
      pathMethods: methodsForPath
    })

    const middlewareCacheKey = this.middlewareCacheKey(pathname, match?.routeKey)
    let matchedMiddleware = this.middlewareCache.get(middlewareCacheKey)
    if (!matchedMiddleware) {
      matchedMiddleware = this.middleware
        .filter((entry) => pathMatchesPrefix(pathname, entry.path))
        .map((entry) => entry.fn)
      setBoundedCache(this.middlewareCache, middlewareCacheKey, matchedMiddleware)
    }

    const routeExecutorCacheKey = match
      ? `${this.middlewareVersion}|${middlewareCacheKey}|${match.routeKey}`
      : null

    try {
      let result: unknown
      if (routeExecutorCacheKey && match) {
        let executor = this.routeExecutorCache.get(routeExecutorCacheKey)
        if (!executor) {
          if (matchedMiddleware.length === 0 && match.executor) {
            executor = match.executor
          } else {
            const stack: RouteFn[] =
              matchedMiddleware.length === 0 ? match.handlers : [...matchedMiddleware, ...match.handlers]
            executor = compileRouteExecutor(stack)
          }
          setBoundedCache(this.routeExecutorCache, routeExecutorCacheKey, executor)
        }
        result = await executor(sc)
      } else if (matchedMiddleware.length > 0) {
        result = await runPipeline(matchedMiddleware, sc)
      }

      if (!res.writableEnded && methodNotAllowed && result === undefined) {
        const allowedMethods = methodsForPath.includes('OPTIONS')
          ? methodsForPath
          : [...methodsForPath, 'OPTIONS']
        sc.set('Allow', allowedMethods.join(', '))
        sc.status(405)
        sc._sendAuto({ error: 'Method Not Allowed' }, true)
        return
      }

      sc._sendAuto(result, routeFound)
    } catch (error) {
      if (res.writableEnded) return
      try {
        const handled = await this.errorHandler(error, sc)
        if (res.writableEnded) return
        if (handled !== undefined) {
          sc._sendAuto(handled, true)
          return
        }

        defaultErrorHandler(error, sc)
      } catch (handlerError) {
        if (res.writableEnded) return
        defaultErrorHandler(handlerError, sc)
      }
    }
  }

  private middlewareCacheKey(pathname: string, routeKey?: string): string {
    if (!routeKey) {
      return `p:${pathname}`
    }

    const space = routeKey.indexOf(' ')
    const routePath = space === -1 ? '' : routeKey.slice(space + 1)
    if (!routePath) {
      return `p:${pathname}`
    }

    if (!this.isMiddlewareStableForRoute(routePath)) {
      return `p:${pathname}`
    }

    return `r:${routeKey}`
  }

  private isMiddlewareStableForRoute(routePath: string): boolean {
    const cached = this.middlewareRouteStabilityCache.get(routePath)
    if (cached !== undefined) return cached

    let stable = true
    for (const entry of this.middleware) {
      if (!isPrefixMatchInvariantForRoute(routePath, entry.path)) {
        stable = false
        break
      }
    }

    this.middlewareRouteStabilityCache.set(routePath, stable)
    return stable
  }

  private async invokeWsHandler(
    routeEntry: WsRouteEntry<TEnv>,
    hook: keyof StraviWebSocketHandler<TEnv>,
    ...args: unknown[]
  ): Promise<void> {
    const fn = routeEntry.handler[hook] as ((...items: unknown[]) => void | Promise<void>) | undefined
    if (!fn) return
    await fn(...args)
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const requestTarget = req.url || '/'
    const { pathname, rawQuery } = parseRequestTarget(requestTarget)
    const match = this.wsRouter.match('GET', pathname)
    if (!match) {
      socket.destroy()
      return
    }

    const routeEntry = this.wsRoutes.get(match.routeKey)
    if (!routeEntry) {
      socket.destroy()
      return
    }

    this.wsServer.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const host = req.headers.host || 'localhost'
      const url = new URL(requestTarget, `http://${host}`)
      const query = parseQueryObject(rawQuery)
      const state: Record<string, unknown> = {}

      const wrapped: StraviWebSocket = {
        raw: ws,
        get readyState() {
          return ws.readyState
        },
        json(value) {
          if (ws.readyState !== WebSocket.OPEN) return
          ws.send(JSON.stringify(value))
        },
        send(data) {
          if (ws.readyState !== WebSocket.OPEN) return
          ws.send(data)
        },
        close(code, reason) {
          ws.close(code, reason)
        }
      }

      const getClients = (): ReadonlySet<StraviWebSocket> => {
        const clients = new Set<StraviWebSocket>()
        for (const client of routeEntry.clients) {
          const clientCtx = this.wsContexts.get(client)
          if (clientCtx) clients.add(clientCtx.ws)
        }
        return clients
      }

      const sc: StraviWebSocketContext<TEnv> = {
        req,
        path: pathname,
        url,
        query,
        params: Object.freeze({ ...match.params }),
        env: this.env,
        state,
        ws: wrapped,
        get clients() {
          return getClients()
        },
        broadcast: (data, includeSelf = false) => {
          for (const client of routeEntry.clients) {
            if (!includeSelf && client === ws) continue
            if (client.readyState !== WebSocket.OPEN) continue
            client.send(data)
          }
        },
        broadcastJson: (value, includeSelf = false) => {
          const payload = JSON.stringify(value)
          for (const client of routeEntry.clients) {
            if (!includeSelf && client === ws) continue
            if (client.readyState !== WebSocket.OPEN) continue
            client.send(payload)
          }
        }
      }

      routeEntry.clients.add(ws)
      this.wsContexts.set(ws, sc)

      void this.invokeWsHandler(routeEntry, 'open', sc).catch((error) => {
        void this.invokeWsHandler(routeEntry, 'error', sc, error instanceof Error ? error : new Error(String(error)))
      })

      ws.on('message', (data: RawData, isBinary: boolean) => {
        void this.invokeWsHandler(routeEntry, 'message', sc, data, isBinary).catch((error) => {
          void this.invokeWsHandler(routeEntry, 'error', sc, error instanceof Error ? error : new Error(String(error)))
        })
      })

      ws.on('close', (code: number, reason: Buffer) => {
        routeEntry.clients.delete(ws)
        void this.invokeWsHandler(routeEntry, 'close', sc, code, reason.toString('utf8')).catch((error) => {
          void this.invokeWsHandler(routeEntry, 'error', sc, error instanceof Error ? error : new Error(String(error)))
        })
      })

      ws.on('error', (error: Error) => {
        void this.invokeWsHandler(routeEntry, 'error', sc, error).catch(() => undefined)
      })
    })
  }

  start(port = 3000, host = '0.0.0.0'): Server {
    if (this.server) return this.server

    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
    this.server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head)
    })

    this.server.listen(port, host)
    return this.server
  }

  async stop(): Promise<void> {
    if (!this.server) return

    const server = this.server
    this.server = null

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }
}


