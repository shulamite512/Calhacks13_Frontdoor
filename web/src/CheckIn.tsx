import { useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from './module_bindings';
import { api, type FollowUpResult, type TriageResult } from './api';
import { useRecorder } from './useRecorder';

type Step = 'form' | 'listening' | 'thinking' | 'done';
type Session = { result: TriageResult; name: string };

const SESSION_KEY = 'frontdoor_session';

function loadSession(): Session | null {
  try {
    const s = localStorage.getItem(SESSION_KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function saveSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable */
  }
}

export default function CheckIn() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [eta, setEta] = useState('10');
  const [transcript, setTranscript] = useState('');
  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState('');
  const rec = useRecorder();
  const { identity } = useSpacetimeDB();

  async function recordSymptoms() {
    if (rec.recording) return rec.stop();
    setError('');
    try {
      setStep('listening');
      const blob = await rec.start();
      setStep('thinking');
      setTranscript(await api.transcribe(blob));
      setStep('form');
    } catch (e) {
      setError(String(e));
      setStep('form');
    }
  }

  async function submit() {
    if (!name || !age || transcript.trim().length < 3) return setError('Please add your name, age and symptoms.');
    if (!identity) return setError('Still connecting, try again in a moment.');
    setError('');
    setStep('thinking');
    try {
      const r = await api.checkIn({
        name, age: Number(age), transcript, etaMinutes: Number(eta) || 0, phoneId: identity.toHexString(),
      });
      const s = { result: r, name };
      saveSession(s);
      setSession(s);
      setStep('done');
      await api.speak(r.spoken_reply);
    } catch (e) {
      setError(String(e));
      setStep('form');
    }
  }

  function startOver() {
    saveSession(null);
    setSession(null);
    setTranscript('');
    setStep('form');
  }

  if (session) return <Waiting session={session} onStartOver={startOver} />;

  return (
    <div className="phone">
      <h1 className="brand">FrontDoor</h1>
      <p className="muted">Check in to the ER before you arrive.</p>

      <label>Name<input value={name} onChange={e => setName(e.target.value)} placeholder="Your full name" /></label>
      <div className="row">
        <label>Age<input value={age} onChange={e => setAge(e.target.value)} inputMode="numeric" /></label>
        <label>Minutes away<input value={eta} onChange={e => setEta(e.target.value)} inputMode="numeric" /></label>
      </div>

      <button className={`mic ${rec.recording ? 'on' : ''}`} onClick={recordSymptoms} disabled={step === 'thinking'}>
        {rec.recording ? 'Tap when done' : step === 'thinking' ? 'Working...' : 'Tap and describe your symptoms'}
      </button>

      <label>What we heard
        <textarea value={transcript} onChange={e => setTranscript(e.target.value)} rows={4}
          placeholder="Or type your symptoms here" />
      </label>

      {error && <p className="error">{error}</p>}
      <button className="primary" onClick={submit} disabled={step === 'thinking'}>Check in</button>
      <p className="fine">If this is life-threatening, call 911.</p>
    </div>
  );
}

// Live status from the database: what the patient should know right now.
function LiveStatus({ patientId }: { patientId: number }) {
  // These views only return rows checked in from this phone.
  const [patients] = useTable(tables.myPatients);
  const [alerts] = useTable(tables.myAlerts);
  const [beds] = useTable(tables.bed);
  const [offers] = useTable(tables.myOffers);
  const [hospitals] = useTable(tables.hospital);
  const respond = useReducer(reducers.respondRedirect);
  const pid = BigInt(patientId);
  const p = patients.find(x => x.id === pid);
  if (!p) return null;

  const responder = [...alerts]
    .filter(a => a.patientId === pid && a.ackedBy !== undefined)
    .sort((a, b) => Number(b.id - a.id))[0]?.ackedBy;
  const bed = p.bedId !== undefined ? beds.find(b => b.id === p.bedId) : undefined;
  const offer = [...offers].filter(o => o.patientId === pid).sort((a, b) => Number(b.id - a.id))[0];
  const other = offer ? hospitals.find(h => h.id === offer.hospitalId) : undefined;

  if (p.status === 'redirected' && other) {
    const directions = `https://www.google.com/maps/dir/?api=1&destination=${other.lat},${other.lng}`;
    return (
      <div className="card status go">
        <div className="muted">Change of plan</div>
        <div className="big">Head to {other.name}</div>
        <p>About {offer.driveMinutes} min away, ~{offer.waitMinutes} min wait. Tell their front desk your symptoms when you arrive.</p>
        <a className="directions" href={directions} target="_blank" rel="noreferrer">Open directions</a>
      </div>
    );
  }
  if (offer?.status === 'pending' && other) {
    return (
      <div className="card status offer-card">
        <div className="muted">Our ER is very busy right now</div>
        <div className="big">{other.name} can likely see you sooner</div>
        <p>About {offer.driveMinutes} min away with a ~{offer.waitMinutes} min wait. It's your choice.</p>
        <div className="row">
          <button className="primary" onClick={() => respond({ offerId: offer.id, accept: true })}>
            Go to {other.name.split(' (')[0]}
          </button>
          <button onClick={() => respond({ offerId: offer.id, accept: false })}>Keep my spot</button>
        </div>
      </div>
    );
  }

  if (p.status === 'roomed' && bed) {
    return (
      <div className="card status go">
        <div className="muted">Your bed is ready</div>
        <div className="big">Bed {bed.label}</div>
        <p>{bed.zone} area. Please check in at the desk and staff will walk you there.</p>
      </div>
    );
  }
  if (p.status === 'discharged') {
    return <div className="card status"><strong>Your visit is complete.</strong></div>;
  }
  return (
    <div className={`card status ${responder ? 'go' : ''}`}>
      <div className="muted">{p.status === 'incoming' ? 'On your way' : 'In the waiting room'}</div>
      {responder ? (
        <div className="big">{responder} is coming to you now</div>
      ) : p.status === 'incoming' ? (
        <div className="big">The ER is expecting you{p.etaMinutes ? ` in about ${p.etaMinutes} min` : ''}</div>
      ) : (
        <div className="big">The team knows you're here</div>
      )}
    </div>
  );
}

function Waiting({ session, onStartOver }: { session: Session; onStartOver: () => void }) {
  const { result, name } = session;
  const [busy, setBusy] = useState(false);
  const [arrived, setArrived] = useState(false);
  const [log, setLog] = useState<Array<{ a: string; r: FollowUpResult }>>([]);
  const [listening, setListening] = useState(false);
  const [sharing, setSharing] = useState(false);
  const rec = useRecorder();
  const pid = result.patientId;

  // Send GPS to the ER every ~10s until we're close enough to count as arrived.
  function shareLocation(patientId: number) {
    if (!navigator.geolocation) return;
    setSharing(true);
    let last = 0;
    const watch = navigator.geolocation.watchPosition(
      async pos => {
        if (Date.now() - last < 10_000) return;
        last = Date.now();
        const r = await api.location({ patientId, lat: pos.coords.latitude, lng: pos.coords.longitude });
        if (r.arrived) {
          navigator.geolocation.clearWatch(watch);
          setSharing(false);
          setArrived(true);
        }
      },
      () => setSharing(false),
      { enableHighAccuracy: true }
    );
  }

  async function checkOnMe() {
    if (rec.recording) return rec.stop();
    if (pid == null) return;
    setBusy(true);
    try {
      const q = await api.followUpQuestion(pid);
      await api.speak(q);
      setListening(true);
      const blob = await rec.start();
      setListening(false);
      const a = await api.transcribe(blob);
      const r = await api.followUp({ patientId: pid, question: q, answer: a });
      if (r.heard) setLog(l => [{ a, r }, ...l]);
      await api.speak(r.spoken_reply);
    } finally {
      setListening(false);
      setBusy(false);
    }
  }

  return (
    <div className="phone">
      <h1 className="brand">FrontDoor</h1>
      <div className="card ok">
        <strong>You're checked in, {name.split(' ')[0]}.</strong>
        <p>{result.spoken_reply}</p>
      </div>

      {pid != null && <LiveStatus patientId={pid} />}

      {!arrived && pid != null && (
        <>
          <button className="primary" onClick={() => api.arrive(pid).then(() => setArrived(true))}>
            I've arrived
          </button>
          <div className="row">
            <button onClick={() => shareLocation(pid)} disabled={sharing}>
              {sharing ? 'Sharing location' : 'Share my location'}
            </button>
            <button className="ghost" onClick={() => api.drive(pid)}>Simulate drive</button>
          </div>
        </>
      )}

      <button className={`mic ${listening ? 'on' : ''}`} onClick={checkOnMe} disabled={busy && !listening}>
        {listening ? 'Listening... tap when done' : busy ? 'Working...' : 'Check on me now'}
      </button>

      {log.map((e, i) => (
        <div key={i} className={`card ${e.r.level === 'none' ? '' : 'warn'}`}>
          <div className="muted">You said</div>
          <p>"{e.a}"</p>
          <div className="muted">{e.r.spoken_reply}</div>
        </div>
      ))}
      <p className="fine">If you feel much worse, tell the front desk right away or call 911.</p>
      <button className="ghost" onClick={onStartOver}>Start a new check-in</button>
    </div>
  );
}
