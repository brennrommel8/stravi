import { Stravi } from 'stravi'

const app = new Stravi()

app.ws('/chat/:room', {
  open(sc) {
    sc.ws.json({
      type: 'welcome',
      room: sc.params.room
    })
  },
  message(sc, data) {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    sc.broadcastJson(
      {
        type: 'message',
        room: sc.params.room,
        text
      },
      true
    )
  },
  close(sc, code) {
    console.log(`socket closed in room=${sc.params.room} code=${code}`)
  }
})

app.start(3000)
console.log('WebSocket server listening on ws://localhost:3000/chat/general')
