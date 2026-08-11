import type { Operation } from '@trpc/client';
import type { TRPCResponseMessage } from '@trpc/server/rpc';

export type ETRPCOperation = Omit<Operation, 'input' | 'signal'> & {
  input: unknown;
};

export type ETRPCRequest =
  { method: 'request'; operation: ETRPCOperation } | { method: 'operation.stop'; id: number };

export interface RendererGlobalElectronTRPC {
  sendMessage: (args: ETRPCRequest) => void;
  onMessage: (callback: (args: TRPCResponseMessage) => void) => () => void;
}
