import { Stravix } from 'stravix'
import cors from 'stravix/cors'

const app = new Stravix()

app.use(cors())

app.get('/', (svx) => {
  return svx.json({
    message: 'Hello Stravix'
  })
})

app.start(3000)
console.log('Listening at localhost:3000')


