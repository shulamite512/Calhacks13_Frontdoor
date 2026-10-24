import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SpacetimeDBProvider, useSpacetimeDB } from 'spacetimedb/react';
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

// A brand-new browser can take 5-15s to get its first answer from Maincloud, so say so
// instead of showing an empty page. (Reloading only restarts the slow handshake.)
function ConnectingNotice() {
  const { isActive } = useSpacetimeDB();
  return isActive ? null : <div className="connecting">Connecting to live data…</div>;
}

// Hash routing: #/board (nurse) and #/checkin (patient phone). Default is the phone page.
function App() {
  const [route, setRoute] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return (
    <>
      <ConnectingNotice />
      {route.startsWith('#/board') ? <Board /> : <CheckIn />}
    </>
  );
}

// No StrictMode: its dev-only double mount opens and drops an extra connection, which makes
// the slow first connect even slower.
createRoot(document.getElementById('root')!).render(
  <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
    <App />
  </SpacetimeDBProvider>
);
