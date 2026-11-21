import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/app.tsx';
import { composeApp, deviceAdapters } from './composition.ts';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root to mount the app in.');

const services = await composeApp(await deviceAdapters());

createRoot(root).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
