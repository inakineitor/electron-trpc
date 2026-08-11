import debugFactory from 'debug';
import type { IpcMainEvent } from 'electron';
import {
  callProcedure as callTRPCProcedure,
  getTRPCErrorFromUnknown,
  getErrorShape as getTRPCErrorShape,
  isAsyncIterable,
  isTrackedEnvelope,
  transformTRPCResponse,
  TRPCError,
  type AnyRouter as AnyTRPCRouter,
  type inferRouterContext,
  type ProcedureType as TRPCProcedureType,
} from '@trpc/server/unstable-core-do-not-import';
import { isObservable, observableToAsyncIterable } from '@trpc/server/observable';
import type { TRPCResponseMessage, TRPCResultMessage } from '@trpc/server/rpc';
import { ELECTRON_TRPC_CHANNEL } from '../constants';
import type { ETRPCRequest } from '../types';
import type { CreateContextOptions } from './types';

const debug = debugFactory('electron-trpc:main:handleIPCMessage');

type Awaitable<T> = T | Promise<T>;

export interface IPCOperation {
  abort: () => void;
}

export type IPCErrorHandlerOptions<TRouter extends AnyTRPCRouter> = {
  ctx: inferRouterContext<TRouter> | undefined;
  error: TRPCError;
  event: IpcMainEvent;
  input: unknown;
  path: string | undefined;
  type: TRPCProcedureType | 'unknown';
};

export type IPCErrorHandler<TRouter extends AnyTRPCRouter> = (
  options: IPCErrorHandlerOptions<TRouter>
) => void;

interface HandleIPCMessageOptions<TRouter extends AnyTRPCRouter> {
  createContext?: (options: CreateContextOptions) => Awaitable<inferRouterContext<TRouter>>;
  event: IpcMainEvent;
  internalId: string;
  message: ETRPCRequest;
  onError?: IPCErrorHandler<TRouter>;
  operations: Map<string, IPCOperation>;
  router: TRouter;
}

const waitForNext = async <T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal
): Promise<IteratorResult<T> | 'aborted'> => {
  if (signal.aborted) {
    return 'aborted';
  }

  return new Promise((resolve, reject) => {
    const handleAbort = () => resolve('aborted');
    signal.addEventListener('abort', handleAbort, { once: true });

    void iterator.next().then(
      (value) => {
        signal.removeEventListener('abort', handleAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', handleAbort);
        reject(error);
      }
    );
  });
};

export async function handleIPCMessage<TRouter extends AnyTRPCRouter>({
  router,
  createContext,
  internalId,
  message,
  event,
  onError,
  operations,
}: HandleIPCMessageOptions<TRouter>): Promise<void> {
  if (message.method === 'operation.stop') {
    operations.get(internalId)?.abort();
    return;
  }

  const { type, input: serializedInput, path, id } = message.operation;
  const abortController = new AbortController();
  let subscriptionStarted = false;
  let ctx: inferRouterContext<TRouter> | undefined;
  let input: unknown;

  const respond = (response: TRPCResponseMessage) => {
    if (event.sender.isDestroyed()) {
      return;
    }

    event.reply(ELECTRON_TRPC_CHANNEL, transformTRPCResponse(router._def._config, response));
  };

  const reportError = (cause: unknown) => {
    const error = getTRPCErrorFromUnknown(cause);
    onError?.({ ctx, error, event, input, path, type });
    respond({
      id,
      error: getTRPCErrorShape({
        config: router._def._config,
        ctx,
        error,
        input,
        path,
        type,
      }),
    });
  };

  if (operations.has(internalId)) {
    reportError(
      new TRPCError({
        code: 'BAD_REQUEST',
        message: `Duplicate operation id ${id}`,
      })
    );
    return;
  }

  operations.set(internalId, {
    abort: () => abortController.abort(),
  });

  try {
    input = router._def._config.transformer.input.deserialize(serializedInput);
    ctx = (await createContext?.({ event })) ?? ({} as inferRouterContext<TRouter>);

    const result = await callTRPCProcedure({
      batchIndex: 0,
      ctx,
      getRawInput: async () => input,
      path,
      router,
      signal: abortController.signal,
      type,
    });

    if (abortController.signal.aborted) {
      return;
    }

    const isIterableResult = isAsyncIterable(result) || isObservable(result);

    if (type !== 'subscription') {
      if (isIterableResult) {
        throw new TRPCError({
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: `Cannot return an async iterable or observable from a ${type} procedure over Electron IPC`,
        });
      }

      respond({ id, result: { type: 'data', data: result } });
      return;
    }

    if (!isIterableResult) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Subscription ${path} did not return an async iterable or observable`,
      });
    }

    const iterable = isObservable(result)
      ? observableToAsyncIterable(result, abortController.signal)
      : result;
    const iterator = iterable[Symbol.asyncIterator]();

    subscriptionStarted = true;
    respond({ id, result: { type: 'started' } });

    void (async () => {
      try {
        while (true) {
          const next = await waitForNext(iterator, abortController.signal);
          if (next === 'aborted' || next.done) {
            break;
          }

          let responseResult: TRPCResultMessage<unknown>['result'] = {
            type: 'data',
            data: next.value,
          };

          if (isTrackedEnvelope(next.value)) {
            const [eventId, data] = next.value;
            responseResult = {
              type: 'data',
              id: eventId,
              data: { id: eventId, data },
            };
          }

          respond({ id, result: responseResult });
        }
      } catch (cause) {
        if (!abortController.signal.aborted) {
          reportError(cause);
        }
      } finally {
        try {
          await iterator.return?.();
        } catch (cause) {
          if (!abortController.signal.aborted) {
            reportError(cause);
          }
        }

        respond({ id, result: { type: 'stopped' } });
        operations.delete(internalId);
        debug('Closed operation', internalId);
      }
    })();
  } catch (cause) {
    if (!abortController.signal.aborted) {
      reportError(cause);
    }
  } finally {
    if (type !== 'subscription' || !subscriptionStarted) {
      operations.delete(internalId);
    }
  }
}
