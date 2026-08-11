import { _electron as electron, expect, test } from '@playwright/test';
import path from 'node:path';

test('supports SuperJSON over Electron IPC', async () => {
  const electronApp = await electron.launch({
    args: [path.resolve(process.cwd(), 'examples/basic-react-superjson')],
    executablePath: process.env.PLAYWRIGHT_ELECTRON_PATH ?? undefined,
  });

  const window = await electronApp.firstWindow();
  await expect(window.locator('[data-testid="greeting"]')).toHaveText('Hello Electron');
  await expect(window.locator('[data-testid="subscription"]')).toHaveText('Subscription ready');
  await window.getByRole('button', { name: 'Run mutation' }).click();
  await expect(window.locator('[data-testid="mutation"]')).toHaveText('MUTATION');

  await electronApp.close();
});
