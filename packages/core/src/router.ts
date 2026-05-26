import type { RouteFn, RouteMatch } from './types.js'

type RoutePart =
  | { type: 'static'; value: string }
  | { type: 'param'; key: string }

type RouteRecord = {
  method: string
  path: string
  parts: RoutePart[]
  handlers: RouteFn[]
}

function splitSegments(pathname: string): string[] {
  if (pathname === '/') return []
  return pathname.split('/').filter(Boolean)
}

export function normalizePath(pathname: string): string {
  if (!pathname || pathname === '/') return '/'
  const trimmed = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  return trimmed || '/'
}

function createParts(pathname: string): RoutePart[] {
  const segments = splitSegments(normalizePath(pathname))

  return segments.map((segment) => {
    if (!segment.startsWith(':')) {
      return { type: 'static', value: segment }
    }

    const key = segment.slice(1)
    if (!key) throw new Error(`Invalid route param in path: ${pathname}`)
    return { type: 'param', key }
  })
}

function matchParts(parts: RoutePart[], pathSegments: string[]): Record<string, string> | null {
  if (parts.length !== pathSegments.length) return null

  const params: Record<string, string> = {}

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]
    const segment = pathSegments[i]

    if (part.type === 'static') {
      if (part.value !== segment) return null
      continue
    }

    params[part.key] = decodeURIComponent(segment)
  }

  return params
}

export class Router {
  private readonly routes: RouteRecord[] = []

  add(method: string, path: string, handlers: RouteFn[]): void {
    if (!path.startsWith('/')) {
      throw new Error(`Route path must start with '/': ${path}`)
    }

    this.routes.push({
      method,
      path: normalizePath(path),
      parts: createParts(path),
      handlers
    })
  }

  match(method: string, pathname: string): RouteMatch | null {
    const normalized = normalizePath(pathname)
    const pathSegments = splitSegments(normalized)

    for (const route of this.routes) {
      if (route.method !== method) continue
      const params = matchParts(route.parts, pathSegments)
      if (!params) continue
      return { handlers: route.handlers, params }
    }

    return null
  }

  matchAnyPath(pathname: string): RouteMatch | null {
    const normalized = normalizePath(pathname)
    const pathSegments = splitSegments(normalized)

    for (const route of this.routes) {
      const params = matchParts(route.parts, pathSegments)
      if (!params) continue
      return { handlers: route.handlers, params }
    }

    return null
  }

  methodsForPath(pathname: string): string[] {
    const normalized = normalizePath(pathname)
    const pathSegments = splitSegments(normalized)
    const methods: string[] = []

    for (const route of this.routes) {
      const params = matchParts(route.parts, pathSegments)
      if (params) methods.push(route.method)
    }

    return methods
  }
}
