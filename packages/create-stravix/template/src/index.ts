import { Stravix } from 'stravix'

const app = new Stravix()

app.get('/', (svx) => {
  return svx.json({
    message: 'Hello Stravix'
  })
})

app.start(3000)
console.log('Listening at localhost:3000')
