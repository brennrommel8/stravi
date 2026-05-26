import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createContext } from './context.js'
import { HttpError } from './http-exception.js'
import { pathMatchesPrefix, ensureAbsolutePath, Router as RouteGroup } from './router-builder.js'
import { Router as InternalRouter, normalizePath } from './router.js'
import { ValidationError } from '../../validator/src/index.js'
import type {
  ErrorHandler,
  EnvShape,
  Handler,
  RouteExecutor,
  StravixOptions,
  InternalStravixContext,
  RouteFn,
  RouteMatch,
  RouteSchema,
  RouteWithSchemaArgs,
  RouteWithoutSchemaArgs
} from './types.js'

async function runPipeline(stack: RouteFn[], svx: InternalStravixContext): Promise<unknown> {
  let idx = -1

  async function dispatch(i: number): Promise<unknown> {
    if (i <= idx) {
      throw new Error('next() called multiple times')
    }

    idx = i
    const fn = stack[i]
    if (!fn) return undefined

    if (fn.length >= 2) {
      return fn(svx, () => dispatch(i + 1))
    }

    const value = await (fn as Handler)(svx)
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

function makeValidationMiddleware(schema: RouteSchema): RouteFn<InternalStravixContext> {
  return async (svx: InternalStravixContext, next) => {
    try {
      if (schema.params) {
        const parsedParams = schema.params.parse(svx.params, 'params') as Record<string, string>
        svx._setParams(parsedParams)
      }

      if (schema.query) {
        const parsedQuery = schema.query.parse(svx.query(), 'query') as Record<string, unknown>
        svx._setQuery(parsedQuery)
      }

      if (schema.headers) {
        const parsedHeaders = schema.headers.parse(svx.headers(), 'headers') as Record<string, unknown>
        svx._setHeaders(parsedHeaders)
      }

      if (schema.cookies) {
        const parsedCookies = schema.cookies.parse(svx.cookies.all(), 'cookies') as Record<string, unknown>
        svx._setCookies(parsedCookies)
      }

      if (schema.body) {
        const rawBody = await svx.body()
        const parsedBody = schema.body.parse(rawBody, 'body')
        svx._setBody(parsedBody)
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        return svx.json(
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

function compileRouteExecutor(stack: RouteFn[]): RouteExecutor<InternalStravixContext> {
  const hasNextMiddleware = stack.some((fn) => fn.length >= 2)

  // Fast path: plain handlers only, no next() middleware chain required.
  if (!hasNextMiddleware) {
    const handlers = stack as Handler[]
    return async (svx: InternalStravixContext) => {
      for (let i = 0; i < handlers.length; i += 1) {
        const value = await handlers[i](svx)
        if (value !== undefined) return value
      }
      return undefined
    }
  }

  const steps: Array<(svx: InternalStravixContext) => Promise<unknown>> = new Array(stack.length + 1)
  steps[stack.length] = async () => undefined

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const fn = stack[i]
    const nextStep = steps[i + 1]

    if (fn.length >= 2) {
      steps[i] = async (svx: InternalStravixContext) => {
        let called = false
        return fn(svx, async () => {
          if (called) throw new Error('next() called multiple times')
          called = true
          return nextStep(svx)
        })
      }
      continue
    }

    const handler = fn as Handler
    steps[i] = async (svx: InternalStravixContext) => {
      const value = await handler(svx)
      if (value !== undefined) return value
      return nextStep(svx)
    }
  }

  return steps[0]
}

function defaultErrorHandler(error: unknown, svx: InternalStravixContext): undefined {
  if (error instanceof HttpError) {
    const payload: Record<string, unknown> = { error: error.message }
    if (error.details !== undefined) payload.details = error.details
    return svx.json(payload, error.status)
  }

  const payload: Record<string, unknown> = { error: 'Internal Server Error' }
  if (process.env.NODE_ENV === 'development' && error instanceof Error) {
    payload.message = error.message
  }

  return svx.json(payload, 500)
}

export class Stravix<TEnv extends EnvShape = EnvShape> {
  private readonly router = new InternalRouter()
  private readonly middleware: MiddlewareEntry[] = []
  private readonly middlewareCache = new Map<string, RouteFn[]>()
  private server: Server | null = null
  private readonly env: TEnv
  private errorHandler: ErrorHandler<InternalStravixContext> = defaultErrorHandler

  constructor(options: StravixOptions<Record<string, string>> = {}) {
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
    this.middlewareCache.clear()

    return this
  }

  onError(handler: ErrorHandler<InternalStravixContext>): this {
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
          params: anyPathMatch.params,
          handlers: anyPathMatch.handlers.filter((fn) => fn.length >= 2)
        }
      }
    }

    const svx = createContext({
      host,
      req,
      res,
      requestUrl: requestTarget,
      rawQuery,
      params: match?.params || {},
      env: this.env,
      pathMethods: methodsForPath
    })

    let matchedMiddleware = this.middlewareCache.get(pathname)
    if (!matchedMiddleware) {
      matchedMiddleware = this.middleware
        .filter((entry) => pathMatchesPrefix(pathname, entry.path))
        .map((entry) => entry.fn)
      this.middlewareCache.set(pathname, matchedMiddleware)
    }
    try {
      let result: unknown
      if (matchedMiddleware.length === 0 && match?.executor) {
        result = await match.executor(svx)
      } else {
        const stack: RouteFn[] =
          matchedMiddleware.length === 0
            ? (match?.handlers || [])
            : [...matchedMiddleware, ...(match?.handlers || [])]
        result = await runPipeline(stack, svx)
      }
      svx._sendAuto(result, routeFound)
    } catch (error) {
      if (res.writableEnded) return
      try {
        const handled = await this.errorHandler(error, svx)
        if (res.writableEnded) return
        if (handled !== undefined) {
          svx._sendAuto(handled, true)
          return
        }

        defaultErrorHandler(error, svx)
      } catch (handlerError) {
        if (res.writableEnded) return
        defaultErrorHandler(handlerError, svx)
      }
    }
  }

  start(port = 3000, host = '0.0.0.0'): Server {
    if (this.server) return this.server

    this.server = createServer((req, res) => {
      void this.handle(req, res)
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


