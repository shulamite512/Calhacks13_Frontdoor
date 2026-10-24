import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { DbConnection } from './module_bindings';
import { STDB_DB, STDB_URI } from './config';
import Board from './Board';
import CheckIn from './CheckIn';
import './index.css';

const TOKEN_KEY = 'frontdoor_token';

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

const connectionBuilder = DbConnection.builder()
  .withUri(STDB_URI)
  .withDatabaseName(STDB_DB)
  .withToken(readToken())
  .onConnect((_conn, _identity, token) => {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* storage unavailable */
    }
  });

// Hash routing: #/board (nurse) and #/checkin (patient phone). Default is the phone page.
function App() {
  const [route, setRoute] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route.startsWith('#/board') ? <Board /> : <CheckIn />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  </StrictMode>
);
