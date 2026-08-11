import { beforeEach, describe, expect, test, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
    send: electronMocks.send,
  },
}));

import { exposeElectronTRPC } from '../exposeElectronTRPC';

describe('exposeElectronTRPC', () => {
  beforeEach(() => {
    for (const mock of Object.values(electronMocks)) {
      mock.mockReset();
    }
  });

  test('exposes a frozen bridge whose listeners can be removed', () => {
    exposeElectronTRPC();
    const bridge = electronMocks.exposeInMainWorld.mock.calls[0]?.[1];
    const callback = vi.fn();
    const unsubscribe = bridge.onMessage(callback);
    const listener = electronMocks.on.mock.calls[0]?.[1];

    listener({}, { id: 1, result: { type: 'data', data: 'hello' } });
    unsubscribe();

    expect(Object.isFrozen(bridge)).toBe(true);
    expect(callback).toHaveBeenCalledWith({
      id: 1,
      result: { type: 'data', data: 'hello' },
    });
    expect(electronMocks.removeListener).toHaveBeenCalledWith(expect.any(String), listener);
  });
});
