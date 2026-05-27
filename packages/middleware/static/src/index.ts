import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { Middleware } from '../../../core/src/types.js'

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8'
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return CONTENT_TYPES[ext] || 'application/octet-stream'
}

function isSafePath(rootPath: string, candidatePath: string): boolean {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`)
}

export type StaticOptions = {
  root: string
  prefix?: string
  index?: string
  maxAge?: number
  immutable?: boolean
  fallthrough?: boolean
}

export default function serveStatic(options: StaticOptions): Middleware {
  if (!options?.root) {
    throw new Error('serveStatic requires a root directory')
  }

  const rootPath = path.resolve(process.cwd(), options.root)
  const rawPrefix = options.prefix || '/'
  const prefix = rawPrefix.startsWith('/') ? rawPrefix : `/${rawPrefix}`
  const normalizedPrefix = prefix !== '/' && prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  const indexFile = options.index || 'index.html'
  const fallthrough = options.fallthrough !== false

  return async function staticMiddleware(sc, next) {
    const method = (sc.req.method || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      if (!next) return undefined
      return next()
    }

    const pathname = sc.url.pathname
    const isPrefixMatch =
      normalizedPrefix === '/' ||
      pathname === normalizedPrefix ||
      pathname.startsWith(`${normalizedPrefix}/`)

    if (!isPrefixMatch) {
      if (!next) return undefined
      return next()
    }

    let relativePath = normalizedPrefix === '/' ? pathname.slice(1) : pathname.slice(normalizedPrefix.length)
    if (relativePath.startsWith('/')) relativePath = relativePath.slice(1)
    if (!relativePath || pathname.endsWith('/')) {
      relativePath = path.posix.join(relativePath, indexFile)
    }

    let decodedPath: string
    try {
      decodedPath = decodeURIComponent(relativePath)
    } catch {
      return sc.json({ error: 'Bad Request' }, 400)
    }

    const filePath = path.resolve(rootPath, decodedPath)
    if (!isSafePath(rootPath, filePath)) {
      return sc.json({ error: 'Forbidden' }, 403)
    }

    let fileStat
    try {
      fileStat = await stat(filePath)
    } catch {
      if (!fallthrough) return sc.json({ error: 'Not Found' }, 404)
      if (!next) return undefined
      return next()
    }

    if (!fileStat.isFile()) {
      if (!fallthrough) return sc.json({ error: 'Not Found' }, 404)
      if (!next) return undefined
      return next()
    }

    if (!sc.res.headersSent) {
      sc.res.statusCode = sc.res.statusCode || 200
      sc.res.setHeader('Content-Type', contentTypeFor(filePath))
      sc.res.setHeader('Content-Length', String(fileStat.size))

      if (typeof options.maxAge === 'number') {
        const maxAge = Math.max(0, Math.floor(options.maxAge))
        const immutablePart = options.immutable ? ', immutable' : ''
        sc.res.setHeader('Cache-Control', `public, max-age=${maxAge}${immutablePart}`)
      }
    }

    const commitCookies = (sc as { _commitCookies?: () => void })._commitCookies
    if (commitCookies) commitCookies.call(sc)

    if (method === 'HEAD') {
      sc.res.end()
      return undefined
    }

    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath)
      stream.on('error', reject)
      stream.on('end', resolve)
      stream.pipe(sc.res)
    })

    return undefined
  }
}
