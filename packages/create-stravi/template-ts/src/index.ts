import { Stravi } from 'stravi'

const app = new Stravi()

app.get('/', (sc) => {
  return sc.json({
    message: 'Hello Stravi'
  })
})

app.start(3000)
console.log('Listening at localhost:3000')
