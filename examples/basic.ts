import { Stravi } from 'stravi'
import cors from 'stravi/cors'
import v from 'stravi/validator'

const app = new Stravi()

app.use(cors())

app.get('/', (sc) => {
  return sc.json({
    message: 'Hello Stravi'
  })
})

app.post(
  '/users/:id',
  {
    params: v.object({ id: v.string() }),
    body: v.object({ name: v.string().min(2) })
  },
  async (sc) => {
    const body = await sc.body()
    return sc.json({
      id: sc.params.id,
      name: body.name
    })
  }
)

app.start(3000)


