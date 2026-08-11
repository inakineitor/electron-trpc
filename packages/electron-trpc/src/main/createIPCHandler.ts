import debugFactory from 'debug';
import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import type {
  AnyRouter as AnyTRPCRouter,
  inferRouterContext,
} from '@trpc/server/unstable-core-do-not-import';
import { ELECTRON_TRPC_CHANNEL } from '../constants';
import type { ETRPCRequest } from '../types';
import { handleIPCMessage, type IPCErrorHandler, type IPCOperation } from './handleIPCMessage';
import type { CreateContextOptions } from './types';

const debug = debugFactory('electron-trpc:main:IPCHandler');

type Awaitable<T> = T | Promise<T>;

export interface IPCHandler {
  attachWindow: (window: BrowserWindow) => void;
  detachWindow: (window: BrowserWindow, webContentsId?: number) => void;
  dispose: () => void;
}

export interface CreateIPCHandlerOptions<TRouter extends AnyTRPCRouter> {
  createContext?: (options: CreateContextOptions) => Awaitable<inferRouterContext<TRouter>>;
  onError?: IPCErrorHandler<TRouter>;
  router: TRouter;
  windows?: BrowserWindow[];
}

const getInternalId = (event: IpcMainEvent, request: ETRPCRequest) => {
  const messageId = request.method === 'request' ? request.operation.id : request.id;
  const frameRoutingId = event.senderFrame?.routingId ?? event.frameId;
  return `${event.sender.id}-${frameRoutingId}:${messageId}`;
};

class IPCHandlerImplementation<TRouter extends AnyTRPCRouter> implements IPCHandler {
  #disposed = false;
  #operations = new Map<string, IPCOperation>();
  #windowCleanup = new Map<BrowserWindow, () => void>();
  #windows: BrowserWindow[] = [];
  readonly #listener: (event: IpcMainEvent, request: ETRPCRequest) => void;

  constructor({ createContext, onError, router, windows = [] }: CreateIPCHandlerOptions<TRouter>) {
    this.#listener = (event, request) => {
      const isAttached = this.#windows.some(
        (window) => !window.isDestroyed() && window.webContents.id === event.sender.id
      );
      if (!isAttached) {
        debug('Ignoring IPC message from an unattached window', event.sender.id);
        return;
      }

      void handleIPCMessage({
        router,
        createContext,
        internalId: getInternalId(event, request),
        event,
        message: request,
        onError,
        operations: this.#operations,
      });
    };

    ipcMain.on(ELECTRON_TRPC_CHANNEL, this.#listener);
    windows.forEach((window) => this.attachWindow(window));
  }

  attachWindow(window: BrowserWindow): void {
    if (this.#disposed) {
      throw new Error('Cannot attach a window to a disposed IPC handler');
    }
    if (this.#windows.includes(window)) {
      return;
    }

    debug('Attaching window', window.id);
    this.#windows.push(window);

    const webContentsId = window.webContents.id;
    const handleNavigation = ({
      isSameDocument,
      frame,
    }: Electron.Event<Electron.WebContentsWillNavigateEventParams>) => {
      if (isSameDocument) {
        return;
      }

      this.#cleanUpOperations({
        webContentsId,
        frameRoutingId: frame?.routingId,
      });
    };
    const handleDestroyed = () => this.detachWindow(window, webContentsId);

    window.webContents.on('did-start-navigation', handleNavigation);
    window.webContents.on('destroyed', handleDestroyed);
    this.#windowCleanup.set(window, () => {
      window.webContents.removeListener('did-start-navigation', handleNavigation);
      window.webContents.removeListener('destroyed', handleDestroyed);
    });
  }

  detachWindow(window: BrowserWindow, webContentsId?: number): void {
    if (window.isDestroyed() && webContentsId === undefined) {
      throw new Error('webContentsId is required when detaching a destroyed window');
    }

    debug('Detaching window', window.id);
    this.#windowCleanup.get(window)?.();
    this.#windowCleanup.delete(window);
    this.#windows = this.#windows.filter((candidate) => candidate !== window);
    this.#cleanUpOperations({ webContentsId: webContentsId ?? window.webContents.id });
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    ipcMain.removeListener(ELECTRON_TRPC_CHANNEL, this.#listener);
    for (const cleanup of this.#windowCleanup.values()) {
      cleanup();
    }
    for (const operation of this.#operations.values()) {
      operation.abort();
    }
    this.#operations.clear();
    this.#windowCleanup.clear();
    this.#windows = [];
  }

  #cleanUpOperations({
    webContentsId,
    frameRoutingId,
  }: {
    webContentsId: number;
    frameRoutingId?: number;
  }): void {
    const prefix = `${webContentsId}-${frameRoutingId ?? ''}`;
    for (const [key, operation] of this.#operations) {
      if (key.startsWith(prefix)) {
        debug('Aborting operation', key);
        operation.abort();
      }
    }
  }
}

export const createIPCHandler = <TRouter extends AnyTRPCRouter>(
  options: CreateIPCHandlerOptions<TRouter>
): IPCHandler => new IPCHandlerImplementation(options);
