import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { CookieOptions, Middleware, StraviContext } from '../../core/types.js'

type HeaderSetter = Pick<StraviContext, 'set'> & { req: StraviContext['req']; res: StraviContext['res'] }

function isHttpsRequest(sc: StraviContext, trustProxy: boolean): boolean {
  const socket = sc.req.socket as { encrypted?: boolean }
  if (socket.encrypted) return true
  if (!trustProxy) return false

  const header = sc.headers('x-forwarded-proto')
  if (typeof header !== 'string') return false
  return header.split(',')[0].trim().toLowerCase() === 'https'
}

function setHeaderIfMissing(sc: HeaderSetter, name: string, value: string): void {
  if (!sc.res.hasHeader(name)) {
    sc.set(name, value)
  }
}

export type SecureHeadersOptions = {
  contentSecurityPolicy?: string | false
  crossOriginEmbedderPolicy?: string | false
  crossOriginOpenerPolicy?: string | false
  crossOriginResourcePolicy?: string | false
  dnsPrefetchControl?: 'off' | 'on' | false
  frameguard?: 'DENY' | 'SAMEORIGIN' | false
  hidePoweredBy?: boolean
  hsts?:
    | false
    | {
        includeSubDomains?: boolean
        maxAge?: number
        preload?: boolean
      }
  noSniff?: boolean
  permittedCrossDomainPolicies?: 'none' | 'master-only' | 'by-content-type' | 'all' | false
  referrerPolicy?: string | false
  trustProxy?: boolean
  xssFilter?: boolean
}

export function secureHeaders(options: SecureHeadersOptions = {}): Middleware {
  const trustProxy = options.trustProxy === true
  const hsts = options.hsts === undefined ? { maxAge: 15552000, includeSubDomains: true } : options.hsts

  return async (sc, next) => {
    if (options.hidePoweredBy !== false) {
      sc.res.removeHeader('x-powered-by')
    }

    if (options.noSniff !== false) {
      setHeaderIfMissing(sc, 'X-Content-Type-Options', 'nosniff')
    }

    if (options.frameguard !== false) {
      setHeaderIfMissing(sc, 'X-Frame-Options', options.frameguard || 'SAMEORIGIN')
    }

    if (options.referrerPolicy !== false) {
      setHeaderIfMissing(sc, 'Referrer-Policy', options.referrerPolicy || 'no-referrer')
    }

    if (options.contentSecurityPolicy !== false) {
      setHeaderIfMissing(sc, 'Content-Security-Policy', options.contentSecurityPolicy || "default-src 'self'")
    }

    if (options.crossOriginOpenerPolicy !== false) {
      setHeaderIfMissing(sc, 'Cross-Origin-Opener-Policy', options.crossOriginOpenerPolicy || 'same-origin')
    }

    if (options.crossOriginResourcePolicy !== false) {
      setHeaderIfMissing(sc, 'Cross-Origin-Resource-Policy', options.crossOriginResourcePolicy || 'same-origin')
    }

    if (options.crossOriginEmbedderPolicy) {
      setHeaderIfMissing(sc, 'Cross-Origin-Embedder-Policy', options.crossOriginEmbedderPolicy)
    }

    if (options.dnsPrefetchControl !== false) {
      setHeaderIfMissing(sc, 'X-DNS-Prefetch-Control', options.dnsPrefetchControl || 'off')
    }

    if (options.permittedCrossDomainPolicies !== false) {
      setHeaderIfMissing(
        sc,
        'X-Permitted-Cross-Domain-Policies',
        options.permittedCrossDomainPolicies || 'none'
      )
    }

    if (options.xssFilter !== false) {
      setHeaderIfMissing(sc, 'X-XSS-Protection', '0')
    }

    if (hsts && isHttpsRequest(sc, trustProxy)) {
      const maxAge = Math.max(0, Math.floor(hsts.maxAge ?? 15552000))
      const includeSubDomains = hsts.includeSubDomains !== false ? '; includeSubDomains' : ''
      const preload = hsts.preload ? '; preload' : ''
      setHeaderIfMissing(sc, 'Strict-Transport-Security', `max-age=${maxAge}${includeSubDomains}${preload}`)
    }

    if (!next) return undefined
    return next()
  }
}

export type RateLimitState = {
  allowed: boolean
  count: number
  remaining: number
  resetTime: number
}

export interface RateLimitStore {
  consume(key: string, limit: number, windowMs: number): RateLimitState
}

class MemoryRateLimitStore implements RateLimitStore {
  private readonly map = new Map<string, { count: number; resetTime: number }>()

  consume(key: string, limit: number, windowMs: number): RateLimitState {
    const now = Date.now()
    const current = this.map.get(key)

    if (!current || current.resetTime <= now) {
      const resetTime = now + windowMs
      this.map.set(key, { count: 1, resetTime })
      return {
        allowed: true,
        count: 1,
        remaining: Math.max(0, limit - 1),
        resetTime
      }
    }

    current.count += 1
    const allowed = current.count <= limit
    return {
      allowed,
      count: current.count,
      remaining: Math.max(0, limit - current.count),
      resetTime: current.resetTime
    }
  }
}

function defaultRateLimitKey(sc: StraviContext, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = sc.headers('x-forwarded-for')
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim()
    }
  }

  return sc.req.socket.remoteAddress || 'unknown'
}

export type RateLimitOptions = {
  headerPrefix?: 'standard' | 'legacy' | 'both' | 'none'
  keyGenerator?: (sc: StraviContext) => string
  limit?: number
  message?: string | Record<string, unknown>
  statusCode?: number
  store?: RateLimitStore
  trustProxy?: boolean
  windowMs?: number
}

export function rateLimit(options: RateLimitOptions = {}): Middleware {
  const limit = Math.max(1, Math.floor(options.limit ?? 100))
  const windowMs = Math.max(1000, Math.floor(options.windowMs ?? 60_000))
  const headerMode = options.headerPrefix || 'both'
  const statusCode = options.statusCode ?? 429
  const message = options.message ?? { error: 'Too Many Requests' }
  const trustProxy = options.trustProxy === true
  const store = options.store || new MemoryRateLimitStore()
  const keyGenerator = options.keyGenerator || ((sc: StraviContext) => defaultRateLimitKey(sc, trustProxy))

  return async (sc, next) => {
    const state = store.consume(keyGenerator(sc), limit, windowMs)
    const resetSeconds = Math.max(0, Math.ceil((state.resetTime - Date.now()) / 1000))

    if (headerMode === 'standard' || headerMode === 'both') {
      sc.set('RateLimit-Limit', String(limit))
      sc.set('RateLimit-Remaining', String(state.remaining))
      sc.set('RateLimit-Reset', String(resetSeconds))
    }

    if (headerMode === 'legacy' || headerMode === 'both') {
      sc.set('X-RateLimit-Limit', String(limit))
      sc.set('X-RateLimit-Remaining', String(state.remaining))
      sc.set('X-RateLimit-Reset', String(state.resetTime))
    }

    if (!state.allowed) {
      sc.set('Retry-After', String(resetSeconds))
      return typeof message === 'string' ? sc.text(message, statusCode) : sc.json(message, statusCode)
    }

    if (!next) return undefined
    return next()
  }
}

type ParsedCsrfCookie = {
  signature: string
  token: string
}

function createCsrfToken(size: number): string {
  return randomBytes(size).toString('hex')
}

function signCsrfToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('hex')
}

function encodeCsrfCookie(token: string, secret: string): string {
  const signature = signCsrfToken(token, secret)
  return `${token}.${signature}`
}

function decodeCsrfCookie(value: string): ParsedCsrfCookie | null {
  const dot = value.lastIndexOf('.')
  if (dot === -1) return null
  return {
    token: value.slice(0, dot),
    signature: value.slice(dot + 1)
  }
}

function tokenEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

function isUnsafeMethod(method: string): boolean {
  const upper = method.toUpperCase()
  return upper !== 'GET' && upper !== 'HEAD' && upper !== 'OPTIONS'
}

function tokenFromBody(value: unknown, fieldName: string): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const token = record[fieldName]
  return typeof token === 'string' ? token : null
}

export type CsrfOptions = {
  cookieName?: string
  cookieOptions?: CookieOptions
  fieldName?: string
  headerName?: string
  responseHeaderName?: string
  secret?: string
  tokenBytes?: number
}

const developmentCsrfSecret = randomBytes(32).toString('hex')

function resolveCsrfSecret(secret?: string): string {
  if (secret && secret.trim()) return secret
  if (process.env.STRAVI_CSRF_SECRET?.trim()) return process.env.STRAVI_CSRF_SECRET
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Missing CSRF secret. Set STRAVI_CSRF_SECRET or pass csrf({ secret }) in production.'
    )
  }
  return developmentCsrfSecret
}

export function getCsrfToken(
  sc: StraviContext,
  options: {
    cookieName?: string
    cookieOptions?: CookieOptions
    secret?: string
    tokenBytes?: number
  } = {}
): string {
  const cookieName = options.cookieName || '__Host-csrf'
  const secret = resolveCsrfSecret(options.secret)
  const tokenBytes = Math.max(16, Math.floor(options.tokenBytes ?? 24))
  const cookieValue = sc.cookies.get(cookieName)

  if (cookieValue) {
    const parsed = decodeCsrfCookie(cookieValue)
    if (parsed) {
      const expected = signCsrfToken(parsed.token, secret)
      if (tokenEquals(parsed.signature, expected)) {
        return parsed.token
      }
    }
  }

  const token = createCsrfToken(tokenBytes)
  const encoded = encodeCsrfCookie(token, secret)
  sc.cookies.set(cookieName, encoded, {
    path: '/',
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    ...options.cookieOptions
  })
  return token
}

export function csrf(options: CsrfOptions = {}): Middleware {
  const cookieName = options.cookieName || '__Host-csrf'
  const headerName = (options.headerName || 'x-csrf-token').toLowerCase()
  const responseHeaderName = options.responseHeaderName || 'X-CSRF-Token'
  const fieldName = options.fieldName || '_csrf'

  return async (sc, next) => {
    const method = sc.req.method || 'GET'
    const cookieOptions = options.cookieOptions || {}
    const token = getCsrfToken(sc, {
      cookieName,
      cookieOptions,
      secret: options.secret,
      tokenBytes: options.tokenBytes
    })

    sc.set(responseHeaderName, token)

    if (!isUnsafeMethod(method)) {
      if (!next) return undefined
      return next()
    }

    const headerToken = sc.headers(headerName)
    const queryToken = sc.query(fieldName)
    const bodyToken = tokenFromBody(await sc.body(), fieldName)
    const requestToken =
      typeof headerToken === 'string'
        ? headerToken
        : typeof bodyToken === 'string'
          ? bodyToken
          : typeof queryToken === 'string'
            ? queryToken
            : null

    if (!requestToken || !tokenEquals(requestToken, token)) {
      return sc.json({ error: 'Invalid CSRF token' }, 403)
    }

    if (!next) return undefined
    return next()
  }
}
