import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ipcLink } from 'electron-trpc/renderer';
import { createTRPCReact } from '@trpc/react-query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AppRouter } from '../electron/api';

const trpcReact = createTRPCReact<AppRouter>();

function App() {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpcReact.createClient({
      links: [ipcLink()],
    })
  );

  return (
    <trpcReact.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <HelloElectron />
      </QueryClientProvider>
    </trpcReact.Provider>
  );
}

function HelloElectron() {
  const { data } = trpcReact.greeting.useQuery({ name: 'Electron' });
  const [subscriptionText, setSubscriptionText] = useState('Connecting');
  const shout = trpcReact.shout.useMutation();
  trpcReact.subscription.useSubscription(undefined, {
    onData: (data) => {
      setSubscriptionText(data.text);
    },
  });

  if (!data) {
    return null;
  }

  return (
    <main>
      <div data-testid="greeting">{data.text}</div>
      <div data-testid="subscription">{subscriptionText}</div>
      <button onClick={() => shout.mutate('mutation')}>Run mutation</button>
      <div data-testid="mutation">{shout.data}</div>
    </main>
  );
}

const rootElement = document.getElementById('react-root');
if (!rootElement) {
  throw new Error('Could not find the React root element');
}
createRoot(rootElement).render(<App />);
