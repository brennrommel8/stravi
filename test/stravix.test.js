import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Stravix, HttpError, Router } from '../dist/src/index.js'
import cors from '../dist/packages/middleware/cors/src/index.js'
import logger from '../dist/packages/middleware/logger/src/index.js'
import serveStatic from '../dist/packages/middleware/static/src/index.js'
import v from '../dist/packages/validator/src/index.js'

async function boot(app) {
  const server = app.start(0, '127.0.0.1')
  if (!server.listening) await once(server, 'listening')
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  return { server, base }
}

test('basic hello route with cors middleware', async () => {
  const app = new Stravix()
  app.use(cors())

  app.get('/', (svx) => {
    return svx.json({ message: 'Hello Stravix' })
  })

  const { server, base } = await boot(app)

  const res = await fetch(`${base}/`, {
    headers: { Origin: 'https://example.com' }
  })

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(await res.json(), { message: 'Hello Stravix' })

  await app.stop()
  assert.equal(server.listening, false)
})

test('svx.query, svx.params, svx.body, svx.headers', async () => {
  const app = new Stravix({ env: { SERVICE_NAME: 'stravix-test' } })

  app.get('/users/:id', (svx) => {
    return svx.json({
      id: svx.params.id,
      idFromHelper: svx.param('id'),
      q: svx.query('q', 'none'),
      ua: svx.headers('user-agent'),
      service: svx.env.SERVICE_NAME
    })
  })

  app.post('/echo', async (svx) => {
    const payload = await svx.body()
    return svx.json(payload)
  })

  const { base } = await boot(app)

  const getRes = await fetch(`${base}/users/42?q=abc`, {
    headers: { 'User-Agent': 'stravix-test-agent' }
  })
  assert.equal(getRes.status, 200)
  assert.deepEqual(await getRes.json(), {
    id: '42',
    idFromHelper: '42',
    q: 'abc',
    ua: 'stravix-test-agent',
    service: 'stravix-test'
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

test('svx.cookies and svx.state', async () => {
  const app = new Stravix()

  app.get('/session', (svx) => {
    const sid = svx.cookies.get('sid')
    if (!sid) {
      svx.cookies.set('sid', 'new-session-id', { httpOnly: true, path: '/' })
    }

    svx.state.requestId = 'r_1'

    return svx.json({
      sid: sid ?? 'new-session-id',
      requestId: svx.state.requestId
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
  const app = new Stravix()

  app.get('/public', cors({ origin: 'https://app.example.com' }), (svx) => {
    return svx.text('ok')
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

test('returns 404 for unmatched routes', async () => {
  const app = new Stravix()
  const { base } = await boot(app)

  const res = await fetch(`${base}/not-found`)
  assert.equal(res.status, 404)
  assert.deepEqual(await res.json(), { error: 'Not Found' })

  await app.stop()
})

test('built-in validator validates params/query/body', async () => {
  const app = new Stravix()

  app.post(
    '/users/:id',
    {
      params: v.object({ id: v.string().min(2) }),
      query: v.object({ mode: v.optional(v.enum(['view', 'edit'])) }),
      body: v.object({ name: v.string().min(2), age: v.number().int() })
    },
    async (svx) => {
      const body = await svx.body()
      return svx.json({
        id: svx.params.id,
        mode: svx.query('mode'),
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
  const app = new Stravix()

  app.onError((err, svx) => {
    const message = err instanceof Error ? err.message : String(err)
    return svx.json({ error: message }, 500)
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
  const app = new Stravix()

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
  const app = new Stravix()

  app.get('/redirect', (svx) => svx.redirect('/target'))
  app.get('/target', (svx) => svx.html('<h1>ok</h1>'))
  app.get('/created', (svx) => svx.status(201).json({ created: true }))
  app.get('/cookie', (svx) => {
    svx.cookie('sid', 'abc', { path: '/', httpOnly: true })
    svx.clearCookie('old', { path: '/' })
    return svx.text('ok')
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
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'stravix-static-'))
  await writeFile(path.join(tmpDir, 'index.html'), '<p>home</p>', 'utf8')
  await writeFile(path.join(tmpDir, 'hello.txt'), 'hello static', 'utf8')

  const app = new Stravix()
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
  const app = new Stravix()

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

  app.get('/log', (svx) => svx.text('ok'))

  const { base } = await boot(app)
  const res = await fetch(`${base}/log`)
  assert.equal(res.status, 200)
  await res.text()
  await app.stop()

  assert.equal(errorLogs.length, 0)
  assert.ok(infoLogs.some((entry) => entry.includes('GET /log 200')))
})

test('app.use supports scoped prefix middleware', async () => {
  const app = new Stravix()

  app.use('/api', async (svx, next) => {
    svx.state.scoped = true
    if (!next) return undefined
    return next()
  })

  app.get('/api/hello', (svx) => svx.json({ scoped: Boolean(svx.state.scoped) }))
  app.get('/hello', (svx) => svx.json({ scoped: Boolean(svx.state.scoped) }))

  const { base } = await boot(app)

  const apiRes = await fetch(`${base}/api/hello`)
  assert.deepEqual(await apiRes.json(), { scoped: true })

  const rootRes = await fetch(`${base}/hello`)
  assert.deepEqual(await rootRes.json(), { scoped: false })

  await app.stop()
})

test('router.get/router.post/router.use can be mounted with app.route', async () => {
  const app = new Stravix()
  const router = new Router()

  router.use((svx, next) => {
    svx.set('x-router', 'on')
    if (!next) return undefined
    return next()
  })

  router.use('/private', (svx, next) => {
    svx.state.privateMiddleware = true
    if (!next) return undefined
    return next()
  })

  router.get('/posts/:id', (svx) => {
    return svx.json({
      id: svx.param('id'),
      page: svx.query('page')
    })
  })

  router.post('/posts', async (svx) => {
    const body = await svx.body()
    return svx.status(201).json(body)
  })

  router.get('/private/ping', (svx) => {
    return svx.json({ ok: Boolean(svx.state.privateMiddleware) })
  })

  app.route('/api', router)

  const { base } = await boot(app)

  const getRes = await fetch(`${base}/api/posts/42?page=2`)
  assert.equal(getRes.headers.get('x-router'), 'on')
  assert.deepEqual(await getRes.json(), { id: '42', page: '2' })

  const postRes = await fetch(`${base}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Stravix' })
  })
  assert.equal(postRes.status, 201)
  assert.deepEqual(await postRes.json(), { title: 'Stravix' })

  const privateRes = await fetch(`${base}/api/private/ping`)
  assert.deepEqual(await privateRes.json(), { ok: true })

  await app.stop()
})



