import type {
  EnvShape,
  RouteFn,
  RouterInstance,
  RouteSchema,
  RouteWithSchemaArgs,
  RouteWithoutSchemaArgs,
  StravixInstance
} from './types.js'
import { normalizePath } from './router.js'

export function ensureAbsolutePath(path: string): string {
  if (!path.startsWith('/')) {
    throw new Error(`Path must start with '/': ${path}`)
  }

  return normalizePath(path)
}

export function joinPaths(prefix: string, path: string): string {
  const normalizedPrefix = ensureAbsolutePath(prefix)
  const normalizedPath = ensureAbsolutePath(path)

  if (normalizedPrefix === '/') return normalizedPath
  if (normalizedPath === '/') return normalizedPrefix
  return `${normalizedPrefix}${normalizedPath}`
}

export function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  const normalizedPath = normalizePath(pathname)
  const normalizedPrefix = ensureAbsolutePath(prefix)
  if (normalizedPrefix === '/') return true
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`)
}

type MountOperation<TEnv extends EnvShape> = (app: StravixInstance<TEnv>, prefix: string) => void

export class Router<TEnv extends EnvShape = EnvShape> implements RouterInstance<TEnv> {
  private readonly operations: MountOperation<TEnv>[] = []

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

    for (const fn of handlers) {
      if (typeof fn !== 'function') {
        throw new TypeError('Middleware must be a function')
      }
    }

    this.operations.push((app, prefix) => {
      const targetPath = joinPaths(prefix, middlewarePath)
      if (targetPath === '/') {
        app.use(...handlers)
        return
      }

      app.use(targetPath, ...handlers)
    })

    return this
  }

  route(path: string, router: Router<TEnv>): this {
    const routePath = ensureAbsolutePath(path)
    this.operations.push((app, prefix) => {
      router.mount(app, joinPaths(prefix, routePath))
    })
    return this
  }

  get<Path extends string>(path: Path, ...handlers: RouteWithoutSchemaArgs<Path, TEnv>): this
  get<Path extends string, Schema extends RouteSchema>(path: Path, ...args: RouteWithSchemaArgs<Path, Schema, TEnv>): this
  get(path: string, ...args: unknown[]): this {
    return this.addRoute('get', path, args)
  }

  post<Path extends string>(path: Path, ...handlers: RouteWithoutSchemaArgs<Path, TEnv>): this
  post<Path extends string, Schema extends RouteSchema>(path: Path, ...args: RouteWithSchemaArgs<Path, Schema, TEnv>): this
  post(path: string, ...args: unknown[]): this {
    return this.addRoute('post', path, args)
  }

  put<Path extends string>(path: Path, ...handlers: RouteWithoutSchemaArgs<Path, TEnv>): this
  put<Path extends string, Schema extends RouteSchema>(path: Path, ...args: RouteWithSchemaArgs<Path, Schema, TEnv>): this
  put(path: string, ...args: unknown[]): this {
    return this.addRoute('put', path, args)
  }

  patch<Path extends string>(path: Path, ...handlers: RouteWithoutSchemaArgs<Path, TEnv>): this
  patch<Path extends string, Schema extends RouteSchema>(path: Path, ...args: RouteWithSchemaArgs<Path, Schema, TEnv>): this
  patch(path: string, ...args: unknown[]): this {
    return this.addRoute('patch', path, args)
  }

  delete<Path extends string>(path: Path, ...handlers: RouteWithoutSchemaArgs<Path, TEnv>): this
  delete<Path extends string, Schema extends RouteSchema>(path: Path, ...args: RouteWithSchemaArgs<Path, Schema, TEnv>): this
  delete(path: string, ...args: unknown[]): this {
    return this.addRoute('delete', path, args)
  }

  options<Path extends string>(path: Path, ...handlers: RouteWithoutSchemaArgs<Path, TEnv>): this
  options<Path extends string, Schema extends RouteSchema>(path: Path, ...args: RouteWithSchemaArgs<Path, Schema, TEnv>): this
  options(path: string, ...args: unknown[]): this {
    return this.addRoute('options', path, args)
  }

  mount(app: StravixInstance<TEnv>, prefix = '/'): void {
    const normalizedPrefix = ensureAbsolutePath(prefix)
    for (const operation of this.operations) {
      operation(app, normalizedPrefix)
    }
  }

  private addRoute(method: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options', path: string, args: unknown[]): this {
    const routePath = ensureAbsolutePath(path)
    this.operations.push((app, prefix) => {
      const mountedPath = joinPaths(prefix, routePath)
      ;(app[method] as (path: string, ...routeArgs: unknown[]) => unknown)(mountedPath, ...args)
    })
    return this
  }
}
