import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

/**
 * Where the client starts.
 *
 * `StrictMode` on purpose, and it is worth knowing what it does before the first person
 * meets it: in development it mounts every component twice and runs every effect twice, so
 * that an effect which is not safe to run again fails now rather than in production. This
 * application's one effect asks the server who is signed in, which is a read and is safe.
 * A future effect that submits something will need a guard, and the doubled run is how it
 * will be found out.
 */
const root = document.getElementById('root');

/* Answered rather than asserted with a `!`, because the failure is otherwise a blank page
   and a null dereference in the console — and the cause is a one word typo in index.html
   that nothing else would ever mention. */
if (root === null) {
  throw new Error('There is no #root element in index.html for the application to mount on.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
