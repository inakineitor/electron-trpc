import debugFactory from 'debug';
import { TRPCClientError, type Operation, type TRPCLink } from '@trpc/client';
import {
  type CoercedTransformerParameters,
  getTransformer,
  type TransformerOptions,
  type TRPCConnectionState,
} from '@trpc/client/unstable-internals';
import { observable, type Observer } from '@trpc/server/observable';
import type { TRPCResponseMessage } from '@trpc/server/rpc';
import {
  transformResult,
  type AnyRouter,
  type inferClientTypes,
  type inferRouterError,
} from '@trpc/server/unstable-core-do-not-import';
import type { ETRPCOperation, RendererGlobalElectronTRPC } from '../types';

const debug = debugFactory('electron-trpc:renderer:ipcLink');

type IPCCallbackResult<TRouter extends AnyRouter> = TRPCResponseMessage<
  unknown,
  inferRouterError<TRouter>
>;

type IPCCallbacks<TRouter extends AnyRouter> = Pick<
  Observer<IPCCallbackResult<TRouter>, TRPCClientError<TRouter>>,
  'complete' | 'next'
>;

type IPCRequest<TRouter extends AnyRouter> = {
  callbacks: IPCCallbacks<TRouter>;
  op: Operation;
};

export type IPCLinkOptions<TRouter extends AnyRouter> = TransformerOptions<
  inferClientTypes<TRouter>
>;

type IPCLinkArguments<TRouter extends AnyRouter> =
  inferClientTypes<TRouter>['transformer'] extends true
    ? [options: IPCLinkOptions<TRouter>]
    : [options?: IPCLinkOptions<TRouter>];

const getElectronTRPC = (): RendererGlobalElectronTRPC => {
  const electronTRPC = (
    globalThis as typeof globalThis & {
      electronTRPC?: RendererGlobalElectronTRPC;
    }
  ).electronTRPC;

  if (!electronTRPC) {
    throw new Error(
      'Could not find `electronTRPC` global. Check that `exposeElectronTRPC` has been called in your preload file.'
    );
  }

  return electronTRPC;
};

class IPCClient<TRouter extends AnyRouter> {
  #pendingRequests = new Map<number, IPCRequest<TRouter>>();
  #electronTRPC = getElectronTRPC();

  constructor() {
    this.#electronTRPC.onMessage((response) => this.#handleResponse(response));
  }

  request(op: Operation, callbacks: IPCCallbacks<TRouter>, input: unknown): () => void {
    const { id } = op;
    this.#pendingRequests.set(id, { callbacks, op });

    const operation: ETRPCOperation = {
      context: op.context,
      id,
      input,
      path: op.path,
      type: op.type,
    };
    this.#electronTRPC.sendMessage({ method: 'request', operation });

    let stopped = false;
    return () => {
      if (stopped || !this.#pendingRequests.delete(id)) {
        return;
      }

      stopped = true;
      this.#electronTRPC.sendMessage({ id, method: 'operation.stop' });
      callbacks.complete();
    };
  }

  #handleResponse(response: TRPCResponseMessage): void {
    debug('Handling response', response);
    if (response.id === null || typeof response.id !== 'number') {
      return;
    }

    const request = this.#pendingRequests.get(response.id);
    if (!request) {
      return;
    }

    request.callbacks.next(response);

    const isTerminal =
      'error' in response ||
      request.op.type !== 'subscription' ||
      ('result' in response && response.result.type === 'stopped');
    if (isTerminal) {
      this.#pendingRequests.delete(response.id);
      request.callbacks.complete();
    }
  }
}

const connectionState = <TRouter extends AnyRouter>(
  state: TRPCConnectionState<TRPCClientError<TRouter>>
) => ({ result: state });

export function ipcLink<TRouter extends AnyRouter>(
  ...[options]: IPCLinkArguments<TRouter>
): TRPCLink<TRouter> {
  const transformer = getTransformer(
    options?.transformer as CoercedTransformerParameters['transformer']
  );

  return () => {
    const client = new IPCClient<TRouter>();

    return ({ op }) =>
      observable((observer) => {
        if (op.type === 'subscription') {
          observer.next(connectionState({ type: 'state', state: 'connecting', error: null }));
        }

        const stop = client.request(
          op,
          {
            complete() {
              observer.complete();
            },
            next(response) {
              const transformed = transformResult<TRouter, unknown>(response, transformer.output);

              if (!transformed.ok) {
                const error = TRPCClientError.from<TRouter>(transformed.error);
                if (op.type === 'subscription') {
                  observer.next(
                    connectionState({
                      type: 'state',
                      state: 'connecting',
                      error,
                    })
                  );
                }
                observer.error(error);
                return;
              }

              if (op.type === 'subscription' && transformed.result.type === 'started') {
                observer.next(connectionState({ type: 'state', state: 'pending', error: null }));
              }
              if (op.type === 'subscription' && transformed.result.type === 'stopped') {
                observer.next(connectionState({ type: 'state', state: 'idle', error: null }));
              }

              observer.next({ result: transformed.result, context: op.context });
            },
          },
          transformer.input.serialize(op.input)
        );

        const handleAbort = () => stop();
        op.signal?.addEventListener('abort', handleAbort, { once: true });
        if (op.signal?.aborted) {
          stop();
        }

        return () => {
          op.signal?.removeEventListener('abort', handleAbort);
          stop();
        };
      });
  };
}
