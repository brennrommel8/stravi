import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Stravix } from '../dist/src/index.js'
import cors from '../dist/packages/cors/src/index.js'
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


