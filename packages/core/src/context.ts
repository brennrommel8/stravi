import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  CookieOptions,
  HeaderValue,
  HeadersInput,
  InternalStravixContext,
  NormalizedHeaders,
  StravixContext
} from './types.js'

const staticJsonCache = new WeakMap<object, Buffer>()

function getStaticJsonBuffer(value: object): Buffer {
  let cached = staticJsonCache.get(value)
  if (cached) return cached
  cached = Buffer.from(JSON.stringify(value))
  staticJsonCache.set(value, cached)
  return cached
}

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

function decodeQueryComponent(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, ' '))
}

function initialQuery(rawQuery: string): Record<string, string | undefined> {
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
  host: string
  rawQuery: string
  req: IncomingMessage
  requestUrl: string
  res: ServerResponse
  params: Record<string, string>
  env: Readonly<Record<string, string | undefined>>
  pathMethods: string[]
}

export function createContext(input: CreateContextInput): InternalStravixContext {
  const { req, res, requestUrl, rawQuery, host, params, env, pathMethods } = input
  const responseCookies: string[] = []
  let bodyPromise: Promise<unknown> | null = null
  let queryCache: Record<string, unknown> | null = null
  let headersCache: Record<string, unknown> | null = null
  let cookiesCache: Record<string, unknown> | null = null
  let requestCookiesCache: Record<string, string> | null = null
  let urlCache: URL | null = null

  function getHeadersCache(): Record<string, unknown> {
    if (!headersCache) {
      headersCache = { ...normalizeHeaders(req.headers) }
    }
    return headersCache
  }

  function getQueryCache(): Record<string, unknown> {
    if (!queryCache) {
      queryCache = initialQuery(rawQuery)
    }
    return queryCache
  }

  function getCookiesCache(): Record<string, unknown> {
    if (!cookiesCache) {
      if (!requestCookiesCache) {
        requestCookiesCache = parseCookieHeader(normalizeHeaderValue(req.headers.cookie))
      }
      cookiesCache = { ...requestCookiesCache }
    }
    return cookiesCache
  }

  const param = ((name?: string, defaultValue?: unknown): unknown => {
    if (!name) return svx.params
    const value = svx.params[String(name)]
    return value === undefined ? defaultValue : value
  }) as StravixContext['param']

  const svx: InternalStravixContext = {
    req,
    res,
    url: null as unknown as URL,
    params,
    env,
    state: {},

    param,

    query(name?: string, defaultValue?: unknown): unknown {
      const cached = getQueryCache()
      if (!name) return cached
      const value = cached[name]
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
      const cached = getHeadersCache()
      if (!name) return cached
      return cached[String(name).toLowerCase()]
    },

    cookies: {
      get(name: string) {
        const value = getCookiesCache()[name]
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
        if (!requestCookiesCache) {
          requestCookiesCache = parseCookieHeader(normalizeHeaderValue(req.headers.cookie))
        }
        return Object.freeze({ ...requestCookiesCache })
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

    redirect(location, status = 302) {
      if (!res.headersSent) {
        res.statusCode = status
        res.setHeader('Location', encodeURI(location))
      }

      this._commitCookies()
      res.end()
      return undefined
    },

    cookie(name, value, options = {}) {
      this.cookies.set(name, value, options)
      return this
    },

    clearCookie(name, options = {}) {
      this.cookies.delete(name, options)
      return this
    },

    json(value, status) {
      if (!res.headersSent) {
        res.statusCode = status ?? res.statusCode ?? 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
      }

      this._commitCookies()
      if (value && typeof value === 'object' && Object.isFrozen(value)) {
        const body = getStaticJsonBuffer(value as object)
        if (!res.headersSent) {
          res.setHeader('Content-Length', String(body.length))
        }
        res.end(body)
        return undefined
      }

      res.end(JSON.stringify(value))
      return undefined
    },

    text(value, status) {
      if (!res.headersSent) {
        res.statusCode = status ?? res.statusCode ?? 200
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      }

      this._commitCookies()
      res.end(value)
      return undefined
    },

    html(value, status) {
      if (!res.headersSent) {
        res.statusCode = status ?? res.statusCode ?? 200
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

  Object.defineProperty(svx, 'url', {
    enumerable: true,
    configurable: false,
    get() {
      if (!urlCache) {
        urlCache = new URL(requestUrl, `http://${host}`)
      }
      return urlCache
    }
  })

  return svx
}


