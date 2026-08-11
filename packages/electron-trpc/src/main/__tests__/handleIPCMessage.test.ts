import { initTRPC, tracked } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import type { IpcMainEvent } from 'electron';
import { z } from 'zod';
import { describe, expect, test, vi, type MockedFunction } from 'vitest';
import { handleIPCMessage, type IPCOperation } from '../handleIPCMessage';

interface MockEvent {
  reply: MockedFunction<IpcMainEvent['reply']>;
  sender: {
    isDestroyed: () => boolean;
  };
}

const makeEvent = (destroyed = false) =>
  ({
    reply: vi.fn(),
    sender: { isDestroyed: () => destroyed },
  }) as unknown as IpcMainEvent & MockEvent;

const getResponses = (event: IpcMainEvent & MockEvent) =>
  event.reply.mock.calls.map((call) => call[1]);

const makeRequest = (
  path: string,
  type: 'mutation' | 'query' | 'subscription',
  input: unknown = undefined,
  id = 1
) => ({
  method: 'request' as const,
  operation: { context: {}, id, input, path, type },
});

const t = initTRPC.create();
const router = t.router({
  echoBoolean: t.procedure.input(z.boolean()).query(({ input }) => input),
  badQuery: t.procedure.query(async function* () {
    yield 'unsupported';
  }),
  slowQuery: t.procedure.query(
    ({ signal }) =>
      new Promise<string>((resolve) => {
        if (signal?.aborted) {
          resolve('aborted');
          return;
        }
        signal?.addEventListener('abort', () => resolve('aborted'), { once: true });
      })
  ),
  stream: t.procedure.subscription(async function* ({ signal }) {
    yield 'first';
    await new Promise<void>((resolve) => {
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  }),
  trackedStream: t.procedure.subscription(async function* () {
    yield tracked('event-1', { value: 'tracked' });
  }),
  observableStream: t.procedure.subscription(() =>
    observable<string>((emit) => {
      emit.next('legacy');
      emit.complete();
    })
  ),
});

describe('handleIPCMessage', () => {
  test.each([false, true])('preserves boolean input %s and operation id 0', async (input) => {
    const event = makeEvent();
    await handleIPCMessage({
      createContext: () => ({}),
      event,
      internalId: '1-1:0',
      message: makeRequest('echoBoolean', 'query', input, 0),
      operations: new Map(),
      router,
    });

    expect(getResponses(event)).toMatchObject([{ id: 0, result: { type: 'data', data: input } }]);
  });

  test('does not respond after the sender is destroyed', async () => {
    const event = makeEvent(true);
    await handleIPCMessage({
      event,
      internalId: '1-1:1',
      message: makeRequest('echoBoolean', 'query', true),
      operations: new Map(),
      router,
    });

    expect(event.reply).not.toHaveBeenCalled();
  });

  test('streams async iterables with started and stopped lifecycle messages', async () => {
    const event = makeEvent();
    const operations = new Map<string, IPCOperation>();
    await handleIPCMessage({
      event,
      internalId: '1-1:1',
      message: makeRequest('stream', 'subscription'),
      operations,
      router,
    });

    await vi.waitFor(() => {
      expect(getResponses(event)).toMatchObject([
        { id: 1, result: { type: 'started' } },
        { id: 1, result: { type: 'data', data: 'first' } },
      ]);
    });

    await handleIPCMessage({
      event,
      internalId: '1-1:1',
      message: { id: 1, method: 'operation.stop' },
      operations,
      router,
    });

    await vi.waitFor(() => {
      expect(getResponses(event)[getResponses(event).length - 1]).toMatchObject({
        id: 1,
        result: { type: 'stopped' },
      });
      expect(operations.size).toBe(0);
    });
  });

  test('supports tracked async iterable events', async () => {
    const event = makeEvent();
    await handleIPCMessage({
      event,
      internalId: '1-1:1',
      message: makeRequest('trackedStream', 'subscription'),
      operations: new Map(),
      router,
    });

    await vi.waitFor(() => {
      expect(getResponses(event)).toContainEqual({
        id: 1,
        result: {
          type: 'data',
          id: 'event-1',
          data: { id: 'event-1', data: { value: 'tracked' } },
        },
      });
    });
  });

  test('keeps legacy Observable subscriptions working', async () => {
    const event = makeEvent();
    await handleIPCMessage({
      event,
      internalId: '1-1:1',
      message: makeRequest('observableStream', 'subscription'),
      operations: new Map(),
      router,
    });

    await vi.waitFor(() => {
      expect(getResponses(event)).toMatchObject([
        { id: 1, result: { type: 'started' } },
        { id: 1, result: { type: 'data', data: 'legacy' } },
        { id: 1, result: { type: 'stopped' } },
      ]);
    });
  });

  test('uses the router transformer in both directions', async () => {
    const transformed = initTRPC.create({
      transformer: {
        deserialize: (value) => JSON.parse((value as string).slice('encoded:'.length)),
        serialize: (value) => `encoded:${JSON.stringify(value)}`,
      },
    });
    const transformedRouter = transformed.router({
      echo: transformed.procedure.input(z.boolean()).query(({ input }) => input),
    });
    const event = makeEvent();

    await handleIPCMessage({
      event,
      internalId: '1-1:1',
      message: makeRequest('echo', 'query', 'encoded:false'),
      operations: new Map(),
      router: transformedRouter,
    });

    expect(getResponses(event)).toMatchObject([
      { id: 1, result: { type: 'data', data: 'encoded:false' } },
    ]);
  });

  test('aborts an in-flight query without sending a result', async () => {
    const event = makeEvent();
    const operations = new Map<string, IPCOperation>();
    const request = handleIPCMessage({
      event,
      internalId: '1-1:1',
      message: makeRequest('slowQuery', 'query'),
      operations,
      router,
    });

    await vi.waitFor(() => expect(operations.size).toBe(1));
    await handleIPCMessage({
      event,
      internalId: '1-1:1',
      message: { id: 1, method: 'operation.stop' },
      operations,
      router,
    });
    await request;

    expect(event.reply).not.toHaveBeenCalled();
    expect(operations.size).toBe(0);
  });

  test('reports unsupported iterable query results through onError', async () => {
    const event = makeEvent();
    const onError = vi.fn();
    await handleIPCMessage({
      event,
      internalId: '1-1:1',
      message: makeRequest('badQuery', 'query'),
      onError,
      operations: new Map(),
      router,
    });

    expect(onError).toHaveBeenCalledOnce();
    expect(getResponses(event)[0]).toMatchObject({ id: 1, error: expect.any(Object) });
  });

  test('rejects duplicate operation ids', async () => {
    const event = makeEvent();
    const operations = new Map<string, IPCOperation>([['1-1:1', { abort: vi.fn() }]]);
    await handleIPCMessage({
      event,
      internalId: '1-1:1',
      message: makeRequest('echoBoolean', 'query', true),
      operations,
      router,
    });

    expect(getResponses(event)[0]).toMatchObject({ id: 1, error: expect.any(Object) });
  });
});
