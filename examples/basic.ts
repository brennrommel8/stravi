import { Stravix } from 'stravix'
import cors from 'stravix/cors'
import v from 'stravix/validator'

const app = new Stravix()

app.use(cors())

app.get('/', (svx) => {
  return svx.json({
    message: 'Hello Stravix'
  })
})

app.post(
  '/users/:id',
  {
    params: v.object({ id: v.string() }),
    body: v.object({ name: v.string().min(2) })
  },
  async (svx) => {
    const body = await svx.body()
    return svx.json({
      id: svx.params.id,
      name: body.name
    })
  }
)

app.start(3000)


