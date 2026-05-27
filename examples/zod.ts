import { Stravi } from 'stravi'
import cors from 'stravi/cors'
import { z } from 'zod'

const app = new Stravi()

app.use(cors())

app.post(
  '/users/:id',
  {
    params: z.object({ id: z.string().min(1) }),
    query: z.object({ mode: z.enum(['view', 'edit']).optional() }),
    body: z.object({ name: z.string().min(2), age: z.number().int() })
  },
  async (sc) => {
    const body = await sc.body()

    return sc.json({
      id: sc.params.id,
      mode: sc.query('mode'),
      name: body.name,
      age: body.age
    })
  }
)

app.start(3000)


