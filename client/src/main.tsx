import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

/** Where the client starts. */
const root = document.getElementById('root');

if (root === null) {
  throw new Error('There is no #root element in index.html for the application to mount on.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
