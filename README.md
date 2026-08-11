# electron-trpc

<p>
  <a href="https://www.npmjs.com/package/electron-trpc">
    <img alt="NPM" src="https://img.shields.io/npm/v/electron-trpc"/>
  </a>
  <a href="https://codecov.io/gh/jsonnull/electron-trpc"> 
  <img src="https://codecov.io/gh/jsonnull/electron-trpc/branch/main/graph/badge.svg?token=DU33O0D9LZ"/> 
  </a>
  <span>
    <img alt="MIT" src="https://img.shields.io/npm/l/electron-trpc"/>
  </span>
</p>

<p></p>

**Build IPC for Electron with tRPC**

- Expose APIs from Electron's main process to one or more render processes.
- Build fully type-safe IPC.
- Secure alternative to opening servers on localhost.
- Full support for queries, mutations, and async iterable subscriptions.

## Installation

```sh
# Using pnpm
pnpm add electron-trpc

# Using yarn
yarn add electron-trpc

# Using npm
npm install --save electron-trpc
```

## Basic Setup

1. Add your tRPC router to the Electron main process using `createIPCHandler`:

   ```ts
   import { app } from 'electron';
   import { createIPCHandler } from 'electron-trpc/main';
   import { router } from './api';

   app.on('ready', () => {
     const win = new BrowserWindow({
       webPreferences: {
         // Replace this path with the path to your preload file (see next step)
         preload: 'path/to/preload.js',
       },
     });

     createIPCHandler({ router, windows: [win] });
   });
   ```

2. Expose the IPC to the render process from the [preload file](https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts):

   ```ts
   import { exposeElectronTRPC } from 'electron-trpc/main';

   process.once('loaded', async () => {
     exposeElectronTRPC();
   });
   ```

   > Note: `electron-trpc` depends on `contextIsolation` being enabled, which is the default.

3. When creating the client in the render process, use the `ipcLink` (instead of the HTTP or batch HTTP links):

   ```ts
   import { createTRPCClient } from '@trpc/client';
   import { ipcLink } from 'electron-trpc/renderer';
   import type { AppRouter } from './api';

   export const client = createTRPCClient<AppRouter>({
     links: [ipcLink()],
   });
   ```

4. Now you can use the client in your render process as you normally would (e.g. using `@trpc/react`).

## Subscriptions

tRPC v11 subscriptions use async generators. The procedure receives an `AbortSignal` that is
cancelled when its renderer unsubscribes, navigates, closes, or explicitly aborts the request.

```ts
import { on } from 'node:events';

const onMessage = t.procedure.subscription(async function* ({ signal }) {
  for await (const [message] of on(events, 'message', { signal })) {
    yield message;
  }
});
```

Legacy tRPC Observable subscriptions remain supported at the transport boundary.

## Transformers

tRPC v11 configures the client transformer on the terminating link:

```ts
import superjson from 'superjson';

const client = createTRPCClient<AppRouter>({
  links: [ipcLink({ transformer: superjson })],
});
```

Configure the same transformer when calling `initTRPC.create()` in the main process.
