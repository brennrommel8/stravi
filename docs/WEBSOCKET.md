# Stravi WebSocket Guide

This guide covers the built-in WebSocket feature in Stravi.

## Quickstart

```ts
import { Stravi } from 'stravi'

const app = new Stravi()

app.ws('/chat/:room', {
  open(sc) {
    sc.ws.json({ type: 'welcome', room: sc.params.room })
  },
  message(sc, data) {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    sc.broadcastJson({ type: 'message', room: sc.params.room, text }, true)
  },
  close(sc, code, reason) {
    console.log('closed', sc.params.room, code, reason)
  },
  error(sc, err) {
    console.error('ws error', err.message)
  }
})

app.start(3000)
```

## API Surface

- `app.ws(path, handler)`
- `router.ws(path, handler)` (for route modules mounted via `app.route(...)`)

Handler hooks:
- `open(sc)`
- `message(sc, data, isBinary)`
- `close(sc, code, reason)`
- `error(sc, error)`

## WebSocket Context (`sc`)

- `sc.ws.send(data)`
- `sc.ws.json(value)`
- `sc.ws.close(code?, reason?)`
- `sc.clients` (clients connected to the same ws route)
- `sc.broadcast(data, includeSelf = false)`
- `sc.broadcastJson(value, includeSelf = false)`

Also available:
- `sc.params` (path params, e.g. `:room`)
- `sc.query` (parsed query object)
- `sc.path`, `sc.url`
- `sc.env`, `sc.state`
- `sc.req` (upgrade request)

## Auth Pattern (Recommended)

Use query token or cookie/session and validate in `open`:

```ts
app.ws('/private', {
  open(sc) {
    const token = sc.query.token
    if (!token || token !== sc.env.WS_TOKEN) {
      sc.ws.close(1008, 'Unauthorized') // policy violation
      return
    }
  }
})
```

For cookie/session auth, read `sc.req.headers.cookie` and validate before allowing traffic.

## Error Behavior

- Throwing inside hooks calls the `error` hook (if provided).
- If no `error` hook is registered, errors are not sent to the client automatically.
- `close` runs when the socket closes; code/reason are provided by the close frame.

## Production Notes

1. Add heartbeat/ping-pong to detect dead connections.
2. Enforce payload limits and validate message shape.
3. Handle backpressure for slow clients (avoid unbounded buffering).
4. Validate auth on connect, and optionally per-message for sensitive actions.
5. Define reconnect behavior in clients (retry strategy + jitter).
6. Keep route-level broadcast rooms focused; avoid global fanout by default.

## Browser Client Example

```js
const ws = new WebSocket('ws://localhost:3000/chat/general')

ws.onopen = () => {
  ws.send('hello from browser')
}

ws.onmessage = (event) => {
  console.log('message:', event.data)
}

ws.onclose = (event) => {
  console.log('closed:', event.code, event.reason)
}
```

## Node Client Example

```ts
import { WebSocket } from 'ws'

const ws = new WebSocket('ws://localhost:3000/chat/general')

ws.on('open', () => {
  ws.send('hello from node')
})

ws.on('message', (data) => {
  console.log('message:', data.toString())
})

ws.on('close', (code, reason) => {
  console.log('closed:', code, reason.toString())
})
```
