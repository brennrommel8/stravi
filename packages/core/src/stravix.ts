import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createContext } from './context.js'
import { Router, normalizePath } from './router.js'
import { ValidationError } from '../../validator/src/index.js'
import type {
  EnvShape,
  Handler,
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

export class Stravix<TEnv extends EnvShape = EnvShape> {
  private readonly router = new Router()
  private readonly middleware: RouteFn[] = []
  private server: Server | null = null
  private readonly env: TEnv

  constructor(options: StravixOptions<Record<string, string>> = {}) {
    this.env = Object.freeze({
      ...process.env,
      ...(options.env || {})
    }) as TEnv
  }

  use(...fns: RouteFn[]): this {
    for (const fn of fns.flat()) {
      if (typeof fn !== 'function') {
        throw new TypeError('Middleware must be a function')
      }
      this.middleware.push(fn)
    }

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
    this.router.add(method, path, routeHandlers)
    return this
  }

  async handle(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
    const host = req.headers.host || 'localhost'
    const url = new URL(req.url || '/', `http://${host}`)
    const pathname = normalizePath(url.pathname)
    const method = (req.method || 'GET').toUpperCase()

    let match: RouteMatch | null = this.router.match(method, pathname)
    const methodsForPath = this.router.methodsForPath(pathname)
    const routeFound = methodsForPath.length > 0

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
      req,
      res,
      url,
      params: match?.params || {},
      env: this.env,
      pathMethods: methodsForPath
    })

    const stack: RouteFn[] = [...this.middleware, ...(match?.handlers || [])]

    try {
      const result = await runPipeline(stack, svx)
      svx._sendAuto(result, routeFound)
    } catch (error) {
      if (res.writableEnded) return

      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(
        JSON.stringify({
          error: 'Internal Server Error',
          message: process.env.NODE_ENV === 'development' && error instanceof Error ? error.message : undefined
        })
      )
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


