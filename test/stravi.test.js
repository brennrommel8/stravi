import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Stravi, HttpError, Router } from '../dist/src/index.js'
import { WebSocket } from 'ws'
import cors from '../dist/packages/middleware/cors/src/index.js'
import logger from '../dist/packages/middleware/logger/src/index.js'
import { csrf, rateLimit, secureHeaders } from '../dist/packages/middleware/security/src/index.js'
import serveStatic from '../dist/packages/middleware/static/src/index.js'
import v from '../dist/packages/validator/src/index.js'

async function boot(app) {
  const server = app.start(0, '127.0.0.1')
  if (!server.listening) await once(server, 'listening')
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  return { server, base }
}

function wsText(data) {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

test('basic hello route with cors middleware', async () => {
  const app = new Stravi()
  app.use(cors())

  app.get('/', (sc) => {
    return sc.json({ message: 'Hello Stravi' })
  })

  const { server, base } = await boot(app)

  const res = await fetch(`${base}/`, {
    headers: { Origin: 'https://example.com' }
  })

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(await res.json(), { message: 'Hello Stravi' })

  await app.stop()
  assert.equal(server.listening, false)
})

test('sc.query, sc.params, sc.body, sc.headers', async () => {
  const app = new Stravi({ env: { SERVICE_NAME: 'Stravi-test' } })

  app.get('/users/:id', (sc) => {
    return sc.json({
      id: sc.params.id,
      idFromHelper: sc.param('id'),
      q: sc.query('q', 'none'),
      ua: sc.headers('user-agent'),
      service: sc.env.SERVICE_NAME
    })
  })

  app.post('/echo', async (sc) => {
    const payload = await sc.body()
    return sc.json(payload)
  })

  const { base } = await boot(app)

  const getRes = await fetch(`${base}/users/42?q=abc`, {
    headers: { 'User-Agent': 'Stravi-test-agent' }
  })
  assert.equal(getRes.status, 200)
  assert.deepEqual(await getRes.json(), {
    id: '42',
    idFromHelper: '42',
    q: 'abc',
    ua: 'Stravi-test-agent',
    service: 'Stravi-test'
  })

  const postRes = await fetch(`${base}/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true })
  })

  assert.equal(postRes.status, 200)
  assert.deepEqual(await postRes.json(), { ok: true })

  await app.stop()
})

test('sc.cookies and sc.state', async () => {
  const app = new Stravi()

  app.get('/session', (sc) => {
    const sid = sc.cookies.get('sid')
    if (!sid) {
      sc.cookies.set('sid', 'new-session-id', { httpOnly: true, path: '/' })
    }

    sc.state.requestId = 'r_1'

    return sc.json({
      sid: sid ?? 'new-session-id',
      requestId: sc.state.requestId
    })
  })

  const { base } = await boot(app)

  const first = await fetch(`${base}/session`)
  assert.equal(first.status, 200)
  assert.ok(first.headers.get('set-cookie')?.includes('sid=new-session-id'))
  assert.deepEqual(await first.json(), {
    sid: 'new-session-id',
    requestId: 'r_1'
  })

  const second = await fetch(`${base}/session`, {
    headers: { Cookie: 'sid=existing' }
  })

  assert.equal(second.status, 200)
  assert.deepEqual(await second.json(), {
    sid: 'existing',
    requestId: 'r_1'
  })

  await app.stop()
})

test('cors preflight and per-route middleware', async () => {
  const app = new Stravi()

  app.get('/public', cors({ origin: 'https://app.example.com' }), (sc) => {
    return sc.text('ok')
  })

  const { base } = await boot(app)

  const preflight = await fetch(`${base}/public`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://app.example.com',
      'Access-Control-Request-Method': 'GET'
    }
  })

  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.example.com')

  const res = await fetch(`${base}/public`, {
    headers: { Origin: 'https://app.example.com' }
  })

  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'ok')

  await app.stop()
})

test('sc.path exposes normalized request pathname', async () => {
  const app = new Stravi()
  app.get('/hello', (sc) => sc.json({ path: sc.path }))

  const { base } = await boot(app)
  const res = await fetch(`${base}/hello/`)

  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { path: '/hello' })

  await app.stop()
})

test('secureHeaders sets helmet-style defaults', async () => {
  const app = new Stravi()
  app.use(secureHeaders())
  app.get('/', (sc) => sc.text('ok'))

  const { base } = await boot(app)
  const res = await fetch(`${base}/`)

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN')
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(res.headers.get('content-security-policy'), "default-src 'self'")

  await app.stop()
})

test('rateLimit blocks requests after configured limit', async () => {
  const app = new Stravi()
  app.use(rateLimit({ limit: 2, windowMs: 60_000 }))
  app.get('/limited', (sc) => sc.text('ok'))

  const { base } = await boot(app)

  const first = await fetch(`${base}/limited`)
  const second = await fetch(`${base}/limited`)
  const third = await fetch(`${base}/limited`)

  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(third.status, 429)
  assert.equal(third.headers.get('ratelimit-limit'), '2')
  assert.deepEqual(await third.json(), { error: 'Too Many Requests' })

  await app.stop()
})

test('csrf middleware validates token for unsafe methods', async () => {
  const app = new Stravi()
  app.use(csrf({ secret: 'test-secret', cookieOptions: { path: '/' } }))
  app.get('/csrf', (sc) => sc.text('ok'))
  app.post('/csrf', (sc) => sc.text('posted'))

  const { base } = await boot(app)

  const getRes = await fetch(`${base}/csrf`)
  assert.equal(getRes.status, 200)

  const token = getRes.headers.get('x-csrf-token')
  const setCookie = getRes.headers.get('set-cookie')
  const cookieHeader = setCookie ? setCookie.split(';')[0] : ''
  assert.ok(token)
  assert.ok(setCookie)

  const postOk = await fetch(`${base}/csrf`, {
    method: 'POST',
    headers: {
      Cookie: cookieHeader,
      'X-CSRF-Token': token
    }
  })

  assert.equal(postOk.status, 200)
  assert.equal(await postOk.text(), 'posted')

  const postBad = await fetch(`${base}/csrf`, {
    method: 'POST',
    headers: {
      Cookie: cookieHeader,
      'X-CSRF-Token': 'bad-token'
    }
  })

  assert.equal(postBad.status, 403)
  assert.deepEqual(await postBad.json(), { error: 'Invalid CSRF token' })

  await app.stop()
})

test('returns 404 for unmatched routes', async () => {
  const app = new Stravi()
  const { base } = await boot(app)

  const res = await fetch(`${base}/not-found`)
  assert.equal(res.status, 404)
  assert.deepEqual(await res.json(), { error: 'Not Found' })

  await app.stop()
})

test('built-in validator validates params/query/body', async () => {
  const app = new Stravi()

  app.post(
    '/users/:id',
    {
      params: v.object({ id: v.string().min(2) }),
      query: v.object({ mode: v.optional(v.enum(['view', 'edit'])) }),
      body: v.object({ name: v.string().min(2), age: v.number().int() })
    },
    async (sc) => {
      const body = await sc.body()
      return sc.json({
        id: sc.params.id,
        mode: sc.query('mode'),
        name: body.name
      })
    }
  )

  const { base } = await boot(app)

  const ok = await fetch(`${base}/users/u1?mode=view`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bren', age: 20 })
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { id: 'u1', mode: 'view', name: 'Bren' })

  const bad = await fetch(`${base}/users/x`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'A', age: 20.5 })
  })
  assert.equal(bad.status, 400)
  const badJson = await bad.json()
  assert.equal(badJson.error, 'Validation Error')
  assert.ok(Array.isArray(badJson.issues))
  assert.ok(badJson.issues.length >= 1)

  await app.stop()
})

test('onError supports custom handler', async () => {
  const app = new Stravi()

  app.onError((err, sc) => {
    const message = err instanceof Error ? err.message : String(err)
    return sc.json({ error: message }, 500)
  })

  app.get('/boom', () => {
    throw new Error('boom')
  })

  const { base } = await boot(app)
  const res = await fetch(`${base}/boom`)

  assert.equal(res.status, 500)
  assert.deepEqual(await res.json(), { error: 'boom' })

  await app.stop()
})

test('HttpError returns configured status code and message', async () => {
  const app = new Stravi()

  app.get('/unauthorized', () => {
    throw new HttpError(401, 'Unauthorized')
  })

  const { base } = await boot(app)
  const res = await fetch(`${base}/unauthorized`)

  assert.equal(res.status, 401)
  assert.deepEqual(await res.json(), { error: 'Unauthorized' })

  await app.stop()
})

test('response helpers support status, redirect, html and cookie shortcuts', async () => {
  const app = new Stravi()

  app.get('/redirect', (sc) => sc.redirect('/target'))
  app.get('/target', (sc) => sc.html('<h1>ok</h1>'))
  app.get('/created', (sc) => sc.status(201).json({ created: true }))
  app.get('/cookie', (sc) => {
    sc.cookie('sid', 'abc', { path: '/', httpOnly: true })
    sc.clearCookie('old', { path: '/' })
    return sc.text('ok')
  })

  const { base } = await boot(app)

  const redirectRes = await fetch(`${base}/redirect`, { redirect: 'manual' })
  assert.equal(redirectRes.status, 302)
  assert.equal(redirectRes.headers.get('location'), '/target')

  const targetRes = await fetch(`${base}/target`)
  assert.equal(targetRes.status, 200)
  assert.equal(targetRes.headers.get('content-type'), 'text/html; charset=utf-8')

  const createdRes = await fetch(`${base}/created`)
  assert.equal(createdRes.status, 201)
  assert.deepEqual(await createdRes.json(), { created: true })

  const cookieRes = await fetch(`${base}/cookie`)
  assert.equal(cookieRes.status, 200)
  const setCookie = cookieRes.headers.get('set-cookie') || ''
  assert.ok(setCookie.includes('sid=abc'))
  assert.ok(setCookie.includes('old='))

  await app.stop()
})

test('serveStatic serves files from disk', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'Stravi-static-'))
  await writeFile(path.join(tmpDir, 'index.html'), '<p>home</p>', 'utf8')
  await writeFile(path.join(tmpDir, 'hello.txt'), 'hello static', 'utf8')

  const app = new Stravi()
  app.use(serveStatic({ root: tmpDir }))

  const { base } = await boot(app)

  const indexRes = await fetch(`${base}/`)
  assert.equal(indexRes.status, 200)
  assert.equal(indexRes.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(await indexRes.text(), '<p>home</p>')

  const txtRes = await fetch(`${base}/hello.txt`)
  assert.equal(txtRes.status, 200)
  assert.equal(await txtRes.text(), 'hello static')

  await app.stop()
  await rm(tmpDir, { recursive: true, force: true })
})

test('logger middleware logs request lifecycle', async () => {
  const infoLogs = []
  const errorLogs = []
  const app = new Stravi()

  app.use(
    logger({
      logger: {
        info(message) {
          infoLogs.push(message)
        },
        error(message) {
          errorLogs.push(message)
        }
      }
    })
  )

  app.get('/log', (sc) => sc.text('ok'))

  const { base } = await boot(app)
  const res = await fetch(`${base}/log`)
  assert.equal(res.status, 200)
  await res.text()
  await app.stop()

  assert.equal(errorLogs.length, 0)
  assert.ok(infoLogs.some((entry) => entry.includes('GET /log 200')))
})

test('app.use supports scoped prefix middleware', async () => {
  const app = new Stravi()

  app.use('/api', async (sc, next) => {
    sc.state.scoped = true
    if (!next) return undefined
    return next()
  })

  app.get('/api/hello', (sc) => sc.json({ scoped: Boolean(sc.state.scoped) }))
  app.get('/hello', (sc) => sc.json({ scoped: Boolean(sc.state.scoped) }))

  const { base } = await boot(app)

  const apiRes = await fetch(`${base}/api/hello`)
  assert.deepEqual(await apiRes.json(), { scoped: true })

  const rootRes = await fetch(`${base}/hello`)
  assert.deepEqual(await rootRes.json(), { scoped: false })

  await app.stop()
})

test('route-key middleware cache remains correct for param routes with concrete middleware path', async () => {
  const app = new Stravi()

  app.use('/users/1', (sc, next) => {
    sc.state.hit = true
    if (!next) return undefined
    return next()
  })

  app.get('/users/:id', (sc) => {
    return sc.json({ id: sc.param('id'), hit: Boolean(sc.state.hit) })
  })

  const { base } = await boot(app)

  const one = await fetch(`${base}/users/1`)
  assert.equal(one.status, 200)
  assert.deepEqual(await one.json(), { id: '1', hit: true })

  const two = await fetch(`${base}/users/2`)
  assert.equal(two.status, 200)
  assert.deepEqual(await two.json(), { id: '2', hit: false })

  await app.stop()
})

test('router.get/router.post/router.use can be mounted with app.route', async () => {
  const app = new Stravi()
  const router = new Router()

  router.use((sc, next) => {
    sc.set('x-router', 'on')
    if (!next) return undefined
    return next()
  })

  router.use('/private', (sc, next) => {
    sc.state.privateMiddleware = true
    if (!next) return undefined
    return next()
  })

  router.get('/posts/:id', (sc) => {
    return sc.json({
      id: sc.param('id'),
      page: sc.query('page')
    })
  })

  router.post('/posts', async (sc) => {
    const body = await sc.body()
    return sc.status(201).json(body)
  })

  router.get('/private/ping', (sc) => {
    return sc.json({ ok: Boolean(sc.state.privateMiddleware) })
  })

  app.route('/api', router)

  const { base } = await boot(app)

  const getRes = await fetch(`${base}/api/posts/42?page=2`)
  assert.equal(getRes.headers.get('x-router'), 'on')
  assert.deepEqual(await getRes.json(), { id: '42', page: '2' })

  const postRes = await fetch(`${base}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'stravi' })
  })
  assert.equal(postRes.status, 201)
  assert.deepEqual(await postRes.json(), { title: 'stravi' })

  const privateRes = await fetch(`${base}/api/private/ping`)
  assert.deepEqual(await privateRes.json(), { ok: true })

  await app.stop()
})

test('returns 405 with Allow header when path exists but method is not allowed', async () => {
  const app = new Stravi()
  app.get('/only-get', (sc) => sc.text('ok'))

  const { base } = await boot(app)
  const res = await fetch(`${base}/only-get`, { method: 'POST' })

  assert.equal(res.status, 405)
  assert.equal(res.headers.get('allow'), 'GET, OPTIONS')
  assert.deepEqual(await res.json(), { error: 'Method Not Allowed' })

  await app.stop()
})

test('sc.body parses multipart/form-data into an object with File entries', async () => {
  const app = new Stravi()

  app.post('/upload', async (sc) => {
    const body = await sc.body()
    const file = body.file
    return sc.json({
      name: body.name,
      fileName: file instanceof File ? file.name : null,
      fileType: file instanceof File ? file.type : null
    })
  })

  const { base } = await boot(app)
  const form = new FormData()
  form.append('name', 'bren')
  form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'note.txt')

  const res = await fetch(`${base}/upload`, {
    method: 'POST',
    body: form
  })

  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), {
    name: 'bren',
    fileName: 'note.txt',
    fileType: 'text/plain'
  })

  await app.stop()
})

test('bodyLimit rejects oversized payloads with 413', async () => {
  const app = new Stravi({ bodyLimit: 16 })

  app.post('/limited', async (sc) => {
    const body = await sc.body()
    return sc.json(body)
  })

  const { base } = await boot(app)

  const ok = await fetch(`${base}/limited`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true })
  })
  assert.equal(ok.status, 200)

  const tooLarge = await fetch(`${base}/limited`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'this payload is definitely too large' })
  })
  assert.equal(tooLarge.status, 413)
  assert.deepEqual(await tooLarge.json(), { error: 'Payload Too Large' })

  await app.stop()
})

test('websocket routes support open/message handlers and context helpers', async () => {
  const app = new Stravi()

  app.ws('/ws/:room', {
    open(sc) {
      sc.ws.json({
        type: 'open',
        room: sc.params.room,
        user: sc.query.user
      })
    },
    message(sc, data) {
      const text = wsText(data)
      sc.broadcastJson({
        type: 'message',
        room: sc.params.room,
        text
      }, true)
    }
  })

  const { server, base } = await boot(app)
  const wsBase = base.replace('http://', 'ws://')
  const socket = new WebSocket(`${wsBase}/ws/general?user=bren`)

  const [openPayloadRaw] = await once(socket, 'message')
  const openPayload = JSON.parse(wsText(openPayloadRaw))
  assert.deepEqual(openPayload, {
    type: 'open',
    room: 'general',
    user: 'bren'
  })

  socket.send('hello')
  const [msgPayloadRaw] = await once(socket, 'message')
  const msgPayload = JSON.parse(wsText(msgPayloadRaw))
  assert.deepEqual(msgPayload, {
    type: 'message',
    room: 'general',
    text: 'hello'
  })

  socket.close()
  await once(socket, 'close')

  await app.stop()
  assert.equal(server.listening, false)
})



