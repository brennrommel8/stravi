import type { InternalStraviContext, RouteExecutor, RouteFn, RouteMatch } from './types.js'

function splitSegments(pathname: string): string[] {
  if (pathname === '/') return []

  const segments: string[] = []
  let start = 1

  for (let i = 1; i <= pathname.length; i += 1) {
    if (i !== pathname.length && pathname.charCodeAt(i) !== 47) continue
    if (i > start) {
      segments.push(pathname.slice(start, i))
    }
    start = i + 1
  }

  return segments
}

export function normalizePath(pathname: string): string {
  if (!pathname || pathname === '/') return '/'
  const trimmed = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  return trimmed || '/'
}

type TrieNode = {
  staticChildren: Map<string, TrieNode>
  paramChild: TrieNode | null
  paramKey: string | null
  handlers: RouteFn[] | null
  executor: RouteExecutor<InternalStraviContext> | null
  routeKey: string | null
}

function createNode(): TrieNode {
  return {
    staticChildren: new Map(),
    paramChild: null,
    paramKey: null,
    handlers: null,
    executor: null,
    routeKey: null
  }
}

function findMatch(
  node: TrieNode,
  pathSegments: string[],
  index: number,
  params: Record<string, string>
): RouteMatch | null {
  if (index === pathSegments.length) {
    if (!node.handlers) return null
    return {
      handlers: node.handlers,
      executor: node.executor || undefined,
      params: { ...params },
      routeKey: node.routeKey || ''
    }
  }

  const segment = pathSegments[index]
  const staticChild = node.staticChildren.get(segment)
  if (staticChild) {
    const hit = findMatch(staticChild, pathSegments, index + 1, params)
    if (hit) return hit
  }

  if (node.paramChild && node.paramKey) {
    params[node.paramKey] = decodeURIComponent(segment)
    const hit = findMatch(node.paramChild, pathSegments, index + 1, params)
    delete params[node.paramKey]
    if (hit) return hit
  }

  return null
}

export class Router {
  private readonly methodRoots = new Map<string, TrieNode>()
  private readonly staticRoutes = new Map<
    string,
    Map<string, { handlers: RouteFn[]; executor: RouteExecutor<InternalStraviContext>; routeKey: string }>
  >()
  private readonly methods = new Set<string>()

  private rootFor(method: string): TrieNode {
    let root = this.methodRoots.get(method)
    if (!root) {
      root = createNode()
      this.methodRoots.set(method, root)
    }
    return root
  }

  add(
    method: string,
    path: string,
    handlers: RouteFn[],
    executor: RouteExecutor<InternalStraviContext>
  ): void {
    if (!path.startsWith('/')) throw new Error(`Route path must start with '/': ${path}`)

    const normalizedPath = normalizePath(path)
    const routeKey = `${method} ${normalizedPath}`
    const segments = splitSegments(normalizedPath)
    if (!path.includes(':')) {
      let staticMap = this.staticRoutes.get(method)
      if (!staticMap) {
        staticMap = new Map()
        this.staticRoutes.set(method, staticMap)
      }
      if (!staticMap.has(normalizedPath)) {
        staticMap.set(normalizedPath, { handlers, executor, routeKey })
      }
    }

    const root = this.rootFor(method)
    let node = root

    for (const segment of segments) {
      if (!segment.startsWith(':')) {
        let child = node.staticChildren.get(segment)
        if (!child) {
          child = createNode()
          node.staticChildren.set(segment, child)
        }
        node = child
        continue
      }

      const key = segment.slice(1)
      if (!key) throw new Error(`Invalid route param in path: ${path}`)

      if (!node.paramChild) {
        node.paramChild = createNode()
        node.paramKey = key
      }

      node = node.paramChild
    }

    if (!node.handlers) {
      node.handlers = handlers
      node.executor = executor
      node.routeKey = routeKey
    }
    this.methods.add(method)
  }

  match(method: string, pathname: string): RouteMatch | null {
    const normalized = normalizePath(pathname)
    const staticMap = this.staticRoutes.get(method)
    const staticRoute = staticMap?.get(normalized)
    if (staticRoute) {
      return {
        handlers: staticRoute.handlers,
        executor: staticRoute.executor,
        params: {},
        routeKey: staticRoute.routeKey
      }
    }

    const root = this.methodRoots.get(method)
    if (!root) return null

    const pathSegments = splitSegments(normalized)
    return findMatch(root, pathSegments, 0, {})
  }

  matchAnyPath(pathname: string): RouteMatch | null {
    for (const method of this.methods) {
      const match = this.match(method, pathname)
      if (match) return match
    }
    return null
  }

  methodsForPath(pathname: string): string[] {
    const normalized = normalizePath(pathname)
    const methods: string[] = []

    for (const method of this.methods) {
      const staticMap = this.staticRoutes.get(method)
      if (staticMap?.has(normalized)) {
        methods.push(method)
        continue
      }

      const match = this.match(method, pathname)
      if (match) methods.push(method)
    }

    return methods
  }
}
