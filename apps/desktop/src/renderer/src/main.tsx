import './styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { bootstrap } from './app/bootstrap';
import { EmptyState } from './ui';

const container = document.getElementById('root');
if (!container) throw new Error('index.html has no #root element.');
const root = createRoot(container);

void bootstrap().then((result) => {
  if (result.ok) {
    root.render(<StrictMode><App runtime={result.runtime} /></StrictMode>);
    return;
  }
  root.render(
    <div className="ms-unconfigured">
      <EmptyState tone="error">Mini-Summa could not connect to its core. {result.message}</EmptyState>
    </div>,
  );
});
