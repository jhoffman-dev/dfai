import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/app.tsx';
import '../ui/app.css';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root to mount the app in.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
