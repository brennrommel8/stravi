import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError } from './http-exception.js'
import type {
  CookieOptions,
  HeaderValue,
  HeadersInput,
  InternalStraviContext,
  NormalizedHeaders,
  StraviContext
} from './types.js'

const staticJsonCache = new WeakMap<object, Buffer>()
const jsonContentType = 'application/json; charset=utf-8'
const textContentType = 'text/plain; charset=utf-8'
const htmlContentType = 'text/html; charset=utf-8'
const notFoundBuffer = Buffer.from(JSON.stringify({ error: 'Not Found' }))

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

function findQueryValue(rawQuery: string, target: string): string | undefined {
  if (!rawQuery || !target) return undefined

  let start = 0
  for (let i = 0; i <= rawQuery.length; i += 1) {
    if (i !== rawQuery.length && rawQuery.charCodeAt(i) !== 38) continue

    const chunk = rawQuery.slice(start, i)
    start = i + 1
    if (!chunk) continue

    const eq = chunk.indexOf('=')
    if (eq === -1) {
      if (decodeQueryComponent(chunk) === target) return ''
      continue
    }

    const key = decodeQueryComponent(chunk.slice(0, eq))
    if (key !== target) continue
    return decodeQueryComponent(chunk.slice(eq + 1))
  }

  return undefined
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

function findCookieValue(headerValue: string | undefined, target: string): string | undefined {
  if (!headerValue || !target) return undefined

  let start = 0
  while (start < headerValue.length) {
    let end = headerValue.indexOf(';', start)
    if (end === -1) end = headerValue.length

    const part = headerValue.slice(start, end).trim()
    if (part) {
      const eq = part.indexOf('=')
      const rawKey = eq === -1 ? part : part.slice(0, eq)
      if (rawKey && decodeURIComponent(rawKey) === target) {
        const rawValue = eq === -1 ? '' : part.slice(eq + 1)
        return decodeURIComponent(rawValue)
      }
    }

    start = end + 1
  }

  return undefined
}

async function readBodyWithLimit(req: IncomingMessage, bodyLimit?: number): Promise<Buffer> {
  if (bodyLimit != null && bodyLimit >= 0) {
    const contentLength = req.headers['content-length']
    const parsedContentLength =
      typeof contentLength === 'string' ? Number.parseInt(contentLength, 10) : Number.NaN
    if (Number.isFinite(parsedContentLength) && parsedContentLength > bodyLimit) {
      throw new HttpError(413, 'Payload Too Large')
    }
  }

  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of req) {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += nextChunk.length

    if (bodyLimit != null && bodyLimit >= 0 && total > bodyLimit) {
      throw new HttpError(413, 'Payload Too Large')
    }

    chunks.push(nextChunk)
  }

  return Buffer.concat(chunks)
}

function formDataToObject(formData: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  for (const [key, value] of formData.entries()) {
    const current = out[key]

    if (current === undefined) {
      out[key] = value
      continue
    }

    if (Array.isArray(current)) {
      current.push(value)
      continue
    }

    out[key] = [current, value]
  }

  return out
}

async function parseBodyByType(buffer: Buffer, contentType: string): Promise<unknown> {
  if (buffer.length === 0) return null

  if (contentType.includes('application/json')) {
    return JSON.parse(buffer.toString('utf8'))
  }

  if (contentType.includes('multipart/form-data')) {
    const response = new Response(buffer, {
      headers: {
        'content-type': contentType
      }
    })
    const formData = await response.formData()
    return formDataToObject(formData)
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
  bodyLimit?: number
  host: string
  pathname: string
  rawQuery: string
  req: IncomingMessage
  requestUrl: string
  res: ServerResponse
  params: Record<string, string>
  env: Readonly<Record<string, string | undefined>>
  pathMethods: string[]
}

type InternalCookieStore = StraviContext['cookies'] & {
  _ctx: RequestContext
}

class RequestCookieStore implements InternalCookieStore {
  _ctx: RequestContext

  constructor(ctx: RequestContext) {
    this._ctx = ctx
  }

  get(name: string): string | undefined {
    const ctx = this._ctx
    const value =
      ctx._cookiesCache?.[name] ??
      ctx._requestCookiesCache?.[name] ??
      findCookieValue(ctx._rawCookieHeader, name)
    return typeof value === 'string' ? value : undefined
  }

  set(name: string, value: string, options: CookieOptions = {}) {
    ;(this._ctx._responseCookies ||= []).push(toCookieHeader(name, value, options))
  }

  delete(name: string, options: CookieOptions = {}) {
    ;(this._ctx._responseCookies ||= []).push(
      toCookieHeader(name, '', {
        ...options,
        maxAge: 0,
        expires: new Date(0)
      })
    )
  }

  all() {
    const ctx = this._ctx
    if (!ctx._requestCookiesCache) {
      ctx._requestCookiesCache = parseCookieHeader(ctx._rawCookieHeader)
    }
    return Object.freeze({ ...ctx._requestCookiesCache })
  }
}

function getHeadersCache(ctx: RequestContext): Record<string, unknown> {
  if (!ctx._headersCache) {
    ctx._headersCache = { ...normalizeHeaders(ctx.req.headers) }
  }
  return ctx._headersCache
}

function getQueryCache(ctx: RequestContext): Record<string, unknown> {
  if (!ctx._queryCache) {
    ctx._queryCache = initialQuery(ctx._rawQuery)
  }
  return ctx._queryCache
}

class RequestContext implements InternalStraviContext {
  req: IncomingMessage
  res: ServerResponse
  path: string
  params: Record<string, string>
  env: Readonly<Record<string, string | undefined>>
  cookies: InternalCookieStore

  _bodyLimit?: number
  _host: string
  _rawQuery: string
  _requestUrl: string
  _pathMethods: string[]
  _rawCookieHeader: string | undefined
  _responseCookies: string[] | null = null
  _bodyPromise: Promise<unknown> | null = null
  _queryCache: Record<string, unknown> | null = null
  _headersCache: Record<string, unknown> | null = null
  _cookiesCache: Record<string, unknown> | null = null
  _requestCookiesCache: Record<string, string> | null = null
  _stateStore: Record<string, unknown> | null = null
  _urlCache: URL | null = null

  constructor(input: CreateContextInput) {
    this.req = input.req
    this.res = input.res
    this.path = input.pathname
    this.params = input.params
    this.env = input.env
    this._bodyLimit = input.bodyLimit
    this._host = input.host
    this._rawQuery = input.rawQuery
    this._requestUrl = input.requestUrl
    this._pathMethods = input.pathMethods
    this._rawCookieHeader = normalizeHeaderValue(input.req.headers.cookie)
    this.cookies = new RequestCookieStore(this)
  }

  get url(): URL {
    if (!this._urlCache) {
      this._urlCache = new URL(this._requestUrl, `http://${this._host}`)
    }
    return this._urlCache
  }

  get state(): Record<string, unknown> {
    if (!this._stateStore) {
      this._stateStore = {}
    }
    return this._stateStore
  }

  set state(value: Record<string, unknown>) {
    this._stateStore = value
  }

  param(): Record<string, string>
  param<K extends string>(name: K): string
  param(name: string): string | undefined
  param<K extends string, TDefault>(name: K, defaultValue: TDefault): string | TDefault
  param<TDefault>(name: string, defaultValue: TDefault): string | TDefault
  param(name?: string, defaultValue?: unknown): Record<string, string> | string | undefined {
    if (!name) return this.params
    const value = this.params[String(name)]
    return (value === undefined ? defaultValue : value) as string | undefined
  }

  query(name?: string, defaultValue?: unknown): unknown {
    if (!name) return getQueryCache(this)
    const key = String(name)
    const cached = this._queryCache
    const value = cached ? cached[key] : findQueryValue(this._rawQuery, key)
    return value === undefined ? defaultValue : value
  }

  body() {
    if (this._bodyPromise) return this._bodyPromise

    this._bodyPromise = readBodyWithLimit(this.req, this._bodyLimit).then((buffer) => {
      const contentType = (normalizeHeaderValue(this.req.headers['content-type']) || '').toLowerCase()
      return parseBodyByType(buffer, contentType)
    })

    return this._bodyPromise
  }

  headers(name?: string): unknown {
    if (!name) return getHeadersCache(this)
    const key = String(name).toLowerCase()
    if (this._headersCache) return this._headersCache[key]
    return normalizeHeaderValue(this.req.headers[key])
  }

  status(code: number): this {
    this.res.statusCode = code
    return this
  }

  set(name: string, value: string): this {
    this.res.setHeader(name, value)
    return this
  }

  redirect(location: string, status = 302): undefined {
    const res = this.res
    if (!res.headersSent) {
      res.statusCode = status
      res.setHeader('Location', encodeURI(location))
    }

    this._commitCookies()
    res.end()
    return undefined
  }

  cookie(name: string, value: string, options: CookieOptions = {}): this {
    this.cookies.set(name, value, options)
    return this
  }

  clearCookie(name: string, options: CookieOptions = {}): this {
    this.cookies.delete(name, options)
    return this
  }

  json(value: unknown, status?: number): undefined {
    const res = this.res
    if (!res.headersSent) {
      res.statusCode = status ?? res.statusCode ?? 200
      res.setHeader('Content-Type', jsonContentType)
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
  }

  text(value: string, status?: number): undefined {
    const res = this.res
    if (!res.headersSent) {
      res.statusCode = status ?? res.statusCode ?? 200
      res.setHeader('Content-Type', textContentType)
    }

    this._commitCookies()
    res.end(value)
    return undefined
  }

  html(value: string, status?: number): undefined {
    const res = this.res
    if (!res.headersSent) {
      res.statusCode = status ?? res.statusCode ?? 200
      res.setHeader('Content-Type', htmlContentType)
    }

    this._commitCookies()
    res.end(value)
    return undefined
  }

  _commitCookies(): void {
    const responseCookies = this._responseCookies
    if (!responseCookies || responseCookies.length === 0) return

    const res = this.res
    const existing = res.getHeader('Set-Cookie')
    if (!existing) {
      res.setHeader('Set-Cookie', responseCookies)
      return
    }

    const existingArray = Array.isArray(existing) ? existing.map(String) : [String(existing)]
    res.setHeader('Set-Cookie', [...existingArray, ...responseCookies])
  }

  _sendAuto(value: unknown, routeFound: boolean): void {
    const res = this.res
    if (res.writableEnded) return

    if (value === undefined) {
      this._commitCookies()

      if (!routeFound) {
        res.statusCode = 404
        res.setHeader('Content-Type', jsonContentType)
        res.setHeader('Content-Length', String(notFoundBuffer.length))
        res.end(notFoundBuffer)
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
  }

  _allowedMethods(): string[] {
    return this._pathMethods
  }

  _setParams(value: Record<string, string>): void {
    this.params = value
  }

  _setQuery(value: Record<string, unknown>): void {
    this._queryCache = value
  }

  _setHeaders(value: Record<string, unknown>): void {
    this._headersCache = value
  }

  _setCookies(value: Record<string, unknown>): void {
    this._cookiesCache = value
  }

  _setBody(value: unknown): void {
    this._bodyPromise = Promise.resolve(value)
  }
}

export function createContext(input: CreateContextInput): InternalStraviContext {
  return new RequestContext(input)
}
