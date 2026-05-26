import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  CookieOptions,
  HeaderValue,
  HeadersInput,
  InternalStravixContext,
  NormalizedHeaders
} from './types.js'

function toCookieHeader(name: string, value: string, options: CookieOptions = {}): string {
  const encoded = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
  const attrs: string[] = []

  if (options.maxAge != null) attrs.push(`Max-Age=${Math.floor(options.maxAge)}`)
  if (options.domain) attrs.push(`Domain=${options.domain}`)
  if (options.path) attrs.push(`Path=${options.path}`)
  if (options.expires instanceof Date) attrs.push(`Expires=${options.expires.toUTCString()}`)
  if (options.httpOnly) attrs.push('HttpOnly')
  if (options.secure) attrs.push('Secure')
  if (options.sameSite) attrs.push(`SameSite=${options.sameSite}`)

  return [encoded, ...attrs].join('; ')
}

function parseCookieHeader(headerValue?: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headerValue) return out

  for (const part of headerValue.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=')
    if (!rawKey) continue
    out[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.join('='))
  }

  return out
}

function normalizeHeaderValue(value: string | string[] | undefined): HeaderValue {
  if (Array.isArray(value)) return value.join(', ')
  return value
}

function normalizeHeaders(headers: HeadersInput): NormalizedHeaders {
  const out: Record<string, HeaderValue> = {}
  for (const key of Object.keys(headers)) {
    out[key] = normalizeHeaderValue(headers[key])
  }
  return Object.freeze(out)
}

function initialQuery(url: URL): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of url.searchParams.entries()) {
    out[key] = value
  }
  return out
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return Buffer.concat(chunks)
}

function parseBodyByType(buffer: Buffer, contentType: string): unknown {
  if (buffer.length === 0) return null

  if (contentType.includes('application/json')) {
    return JSON.parse(buffer.toString('utf8'))
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(buffer.toString('utf8'))
    return Object.fromEntries(params.entries())
  }

  if (contentType.startsWith('text/')) {
    return buffer.toString('utf8')
  }

  return buffer
}

type CreateContextInput = {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  env: Readonly<Record<string, string | undefined>>
  pathMethods: string[]
}

export function createContext(input: CreateContextInput): InternalStravixContext {
  const { req, res, url, params, env, pathMethods } = input
  const requestCookieHeader = normalizeHeaderValue(req.headers.cookie)
  const requestCookies = parseCookieHeader(requestCookieHeader)

  const responseCookies: string[] = []
  let bodyPromise: Promise<unknown> | null = null
  let queryCache: Record<string, unknown> = initialQuery(url)
  let headersCache: Record<string, unknown> = { ...normalizeHeaders(req.headers) }
  let cookiesCache: Record<string, unknown> = { ...requestCookies }

  const svx: InternalStravixContext = {
    req,
    res,
    url,
    params,
    env,
    state: {},

    query(name?: string, defaultValue?: unknown): unknown {
      if (!name) return queryCache
      const value = queryCache[name]
      return value === undefined ? defaultValue : value
    },

    body() {
      if (bodyPromise) return bodyPromise

      bodyPromise = readBody(req).then((buffer) => {
        const contentType = (normalizeHeaderValue(req.headers['content-type']) || '').toLowerCase()
        return parseBodyByType(buffer, contentType)
      })

      return bodyPromise
    },

    headers(name?: string): unknown {
      if (!name) return headersCache
      return headersCache[String(name).toLowerCase()]
    },

    cookies: {
      get(name: string) {
        const value = cookiesCache[name]
        return typeof value === 'string' ? value : undefined
      },
      set(name: string, value: string, options: CookieOptions = {}) {
        responseCookies.push(toCookieHeader(name, value, options))
      },
      delete(name: string, options: CookieOptions = {}) {
        responseCookies.push(
          toCookieHeader(name, '', {
            ...options,
            maxAge: 0,
            expires: new Date(0)
          })
        )
      },
      all() {
        return Object.freeze({ ...requestCookies })
      }
    },

    status(code) {
      res.statusCode = code
      return this
    },

    set(name, value) {
      res.setHeader(name, value)
      return this
    },

    json(value, status = 200) {
      if (!res.headersSent) {
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
      }

      this._commitCookies()
      res.end(JSON.stringify(value))
      return undefined
    },

    text(value, status = 200) {
      if (!res.headersSent) {
        res.statusCode = status
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      }

      this._commitCookies()
      res.end(value)
      return undefined
    },

    html(value, status = 200) {
      if (!res.headersSent) {
        res.statusCode = status
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
      }

      this._commitCookies()
      res.end(value)
      return undefined
    },

    _commitCookies() {
      if (responseCookies.length === 0) return

      const existing = res.getHeader('Set-Cookie')
      if (!existing) {
        res.setHeader('Set-Cookie', responseCookies)
        return
      }

      const existingArray = Array.isArray(existing) ? existing.map(String) : [String(existing)]
      res.setHeader('Set-Cookie', [...existingArray, ...responseCookies])
    },

    _sendAuto(value, routeFound) {
      if (res.writableEnded) return

      if (value === undefined) {
        this._commitCookies()

        if (!routeFound) {
          res.statusCode = 404
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Not Found' }))
          return
        }

        if (!res.headersSent) {
          res.statusCode = res.statusCode || 204
        }

        res.end()
        return
      }

      if (Buffer.isBuffer(value)) {
        this._commitCookies()
        if (!res.headersSent) res.statusCode = res.statusCode || 200
        res.end(value)
        return
      }

      if (typeof value === 'string') {
        this.text(value, res.statusCode || 200)
        return
      }

      if (typeof value === 'object') {
        this.json(value, res.statusCode || 200)
        return
      }

      this.text(String(value), res.statusCode || 200)
    },

    _allowedMethods() {
      return pathMethods
    },

    _setParams(value: Record<string, string>) {
      this.params = value
    },

    _setQuery(value: Record<string, unknown>) {
      queryCache = value
    },

    _setHeaders(value: Record<string, unknown>) {
      headersCache = value
    },

    _setCookies(value: Record<string, unknown>) {
      cookiesCache = value
    },

    _setBody(value: unknown) {
      bodyPromise = Promise.resolve(value)
    }
  }

  return svx
}


