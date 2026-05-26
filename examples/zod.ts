import { Stravix } from 'stravix'
import cors from 'stravix/cors'
import { z } from 'zod'

const app = new Stravix()

app.use(cors())

app.post(
  '/users/:id',
  {
    params: z.object({ id: z.string().min(1) }),
    query: z.object({ mode: z.enum(['view', 'edit']).optional() }),
    body: z.object({ name: z.string().min(2), age: z.number().int() })
  },
  async (svx) => {
    const body = await svx.body()

    return svx.json({
      id: svx.params.id,
      mode: svx.query('mode'),
      name: body.name,
      age: body.age
    })
  }
)

app.start(3000)


