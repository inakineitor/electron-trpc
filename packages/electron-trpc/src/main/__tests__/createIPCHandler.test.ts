import { EventEmitter } from 'node:events';
import { initTRPC } from '@trpc/server';
import type { BrowserWindow, IpcMainEvent } from 'electron';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

import { createIPCHandler } from '../createIPCHandler';

const t = initTRPC.create();
const router = t.router({
  hello: t.procedure.query(() => 'hello'),
});

const makeWindow = (webContentsId: number) => {
  const webContents = new EventEmitter() as EventEmitter & {
    id: number;
    isDestroyed: () => boolean;
  };
  webContents.id = webContentsId;
  webContents.isDestroyed = () => false;

  return {
    id: webContentsId,
    isDestroyed: () => false,
    webContents,
  } as unknown as BrowserWindow;
};

const makeEvent = (senderId: number) =>
  ({
    frameId: 1,
    reply: vi.fn(),
    sender: { id: senderId, isDestroyed: () => false },
    senderFrame: { routingId: 1 },
  }) as unknown as IpcMainEvent;

describe('createIPCHandler', () => {
  beforeEach(() => {
    electronMocks.on.mockReset();
    electronMocks.removeListener.mockReset();
  });

  test('only handles messages from attached windows', async () => {
    const window = makeWindow(10);
    const context = { source: 'sync-context' };
    const handler = createIPCHandler({
      createContext: () => context,
      router,
      windows: [window],
    });
    const listener = electronMocks.on.mock.calls[0]?.[1];
    const attachedEvent = makeEvent(10);
    const unattachedEvent = makeEvent(11);
    const request = {
      method: 'request' as const,
      operation: {
        context: {},
        id: 1,
        input: undefined,
        path: 'hello',
        type: 'query' as const,
      },
    };

    listener(unattachedEvent, request);
    listener(attachedEvent, request);

    await vi.waitFor(() => expect(attachedEvent.reply).toHaveBeenCalledOnce());
    expect(unattachedEvent.reply).not.toHaveBeenCalled();
    handler.dispose();
  });

  test('detaches listeners and makes disposal idempotent', () => {
    const window = makeWindow(10);
    const handler = createIPCHandler({ router, windows: [window] });
    const ipcListener = electronMocks.on.mock.calls[0]?.[1];

    handler.detachWindow(window);
    handler.dispose();
    handler.dispose();

    expect(electronMocks.removeListener).toHaveBeenCalledOnce();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(expect.any(String), ipcListener);
  });

  test('rejects attaching windows after disposal', () => {
    const handler = createIPCHandler({ router });
    handler.dispose();

    expect(() => handler.attachWindow(makeWindow(10))).toThrow(
      'Cannot attach a window to a disposed IPC handler'
    );
  });
});
