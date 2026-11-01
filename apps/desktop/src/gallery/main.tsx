import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Gallery } from './gallery.tsx';
import '@dfai/shell/styles.css';
import './gallery.css';

const root = document.getElementById('root');
if (!root) throw new Error('gallery.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
