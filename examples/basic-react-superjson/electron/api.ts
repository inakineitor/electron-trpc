import z from 'zod';
import { initTRPC } from '@trpc/server';
import { EventEmitter, on } from 'node:events';
import superjson from 'superjson';

const ee = new EventEmitter();

const t = initTRPC.create({ isServer: true, transformer: superjson });

export const router = t.router({
  greeting: t.procedure.input(z.object({ name: z.string() })).query((req) => {
    const { input } = req;

    ee.emit('greeting', `Greeted ${input.name}`);
    return {
      text: `Hello ${input.name}` as const,
    };
  }),
  shout: t.procedure.input(z.string()).mutation(({ input }) => input.toUpperCase()),
  subscription: t.procedure.subscription(async function* ({ signal }) {
    yield { text: 'Subscription ready' };
    for await (const [text] of on(ee, 'greeting', { signal })) {
      yield { text: text as string };
    }
  }),
});

export type AppRouter = typeof router;
