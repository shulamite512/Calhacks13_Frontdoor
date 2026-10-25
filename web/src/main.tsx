import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SpacetimeDBProvider, useSpacetimeDB } from 'spacetimedb/react';
import { DbConnection } from './module_bindings';
import { API_URL, STDB_DB, STDB_URI } from './config';
import Board from './Board';
import CheckIn from './CheckIn';
import Ems from './Ems';
import Family from './Family';
import './index.css';

const TOKEN_KEY = 'frontdoor_token';
const KEEP_AWAKE_MS = 5 * 60_000;

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

// Hash routing: #/board (nurse), #/ems (ambulance crew) and #/checkin (patient phone). Default is the phone page.
function App() {
  const [route, setRoute] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Free hosting sleeps after ~15 min without requests; the board reads the database directly, so
  // ping the server while any page is open to keep vitals and the Assistant running.
  useEffect(() => {
    const ping = () => void fetch(`${API_URL}/health`).catch(() => {});
    ping();
    const id = setInterval(ping, KEEP_AWAKE_MS);
    return () => clearInterval(id);
  }, []);
  const screen = route.startsWith('#/board') ? 'board' : route.startsWith('#/ems') ? 'ems' : 'phone';
  return (
    <>
      {!route.startsWith('#/family/') && (
        // Demo switcher between the three screens (the family page stays private to the family).
        <nav className="screens">
          <a href="#/" className={screen === 'phone' ? 'on' : ''}>📱 Patient</a>
          <a href="#/board" className={screen === 'board' ? 'on' : ''}>🏥 Nurse board</a>
          <a href="#/ems" className={screen === 'ems' ? 'on' : ''}>🚑 Ambulance</a>
        </nav>
      )}
      {!route.startsWith('#/family/') && <ConnectingNotice />}
      {route.startsWith('#/board') ? <Board />
        : route.startsWith('#/ems') ? <Ems />
        : route.startsWith('#/family/') ? <Family token={route.slice('#/family/'.length)} />
        : <CheckIn />}
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
