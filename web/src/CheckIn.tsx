import { useEffect, useRef, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from './module_bindings';
import { api, type ErOption, type FollowUpResult, type Nearby, type TriageResult } from './api';
import { useRecorder } from './useRecorder';
import { LANGS, t, type Lang } from './i18n';

type Step = 'form' | 'listening' | 'thinking' | 'done';
type Loc = { lat: number; lng: number; mode: 'gps' | 'demo'; outside?: boolean; denied?: boolean };

// Demo location (our ER network is in San Francisco).
const DEMO_LOC: Loc = { lat: 37.80292, lng: -122.4484, mode: 'demo' };
type Session = { result: TriageResult; name: string; lang?: Lang };

const SESSION_KEY = 'frontdoor_session';
// Automatic waiting-room check-ins: the first soon after arrival, then on a steady interval.
const AUTO_FIRST_MS = 30_000;
const AUTO_EVERY_MS = 120_000;
const AUTO_LISTEN_MS = 8_000;
const MISSES_BEFORE_ALERT = 2;

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
  const [loc, setLoc] = useState<Loc | null>(null);
  const [near, setNear] = useState<Nearby | null>(null);
  const [transcript, setTranscript] = useState('');
  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState('');
  const [lang, setLang] = useState<Lang>('en');
  const rec = useRecorder();
  const { identity } = useSpacetimeDB();

  // Ask for the driver's location as soon as the page opens, then show the ERs around them.
  useEffect(() => {
    if (session) return;
    useMyLocation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function showNearby(l: Loc) {
    setLoc(l);
    try {
      const n = await api.nearby(l.lat, l.lng);
      if (l.mode === 'gps' && !n.inServiceArea) {
        // Our ER network is in San Francisco; from elsewhere, use the demo location instead.
        const demo = { lat: n.demoLocation.lat, lng: n.demoLocation.lng, mode: 'demo' as const, outside: true };
        setLoc(demo);
        setNear(await api.nearby(demo.lat, demo.lng));
        return;
      }
      setNear(n);
    } catch {
      setNear(null);
    }
  }

  function useMyLocation() {
    setLoc(null);
    setNear(null);
    if (!navigator.geolocation) return void showNearby(DEMO_LOC);
    navigator.geolocation.getCurrentPosition(
      pos => void showNearby({ lat: pos.coords.latitude, lng: pos.coords.longitude, mode: 'gps' }),
      () => void showNearby({ ...DEMO_LOC, denied: true }),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }

  async function recordSymptoms() {
    if (rec.recording) return rec.stop();
    setError('');
    try {
      setStep('listening');
      const blob = await rec.start();
      setStep('thinking');
      setTranscript(await api.transcribe(blob, lang));
      setStep('form');
    } catch (e) {
      setError(String(e));
      setStep('form');
    }
  }

  async function submit() {
    if (!name || !age || transcript.trim().length < 3) return setError('Please add your name, age and symptoms.');
    if (!identity) return setError('Still connecting, try again in a moment.');
    if (!loc) return setError('Still finding your location, one moment.');
    setError('');
    setStep('thinking');
    try {
      const r = await api.checkIn({
        name, age: Number(age), transcript, lat: loc.lat, lng: loc.lng, phoneId: identity.toHexString(), language: lang,
      });
      const s = { result: r, name, lang };
      saveSession(s);
      setSession(s);
      setStep('done');
      await api.speak(r.spoken_reply, lang);
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
      <div className="langs" role="group" aria-label="Language">
        {LANGS.map(l => (
          <button key={l.code} className={l.code === lang ? 'on' : ''} onClick={() => setLang(l.code)}>{l.label}</button>
        ))}
      </div>
      <p className="muted">{t('tagline', lang)}</p>

      <div className="nearby">
        <div className="loc">
          {!loc ? t('locating', lang)
            : loc.mode === 'gps' ? `📍 ${t('usingGps', lang)}`
            : `📍 ${t('usingDemo', lang)}${loc.outside ? ` · ${t('outside', lang)}` : loc.denied ? ` · ${t('denied', lang)}` : ''}`}
          {loc && (
            <button className="ghost" onClick={() => (loc.mode === 'gps' ? showNearby(DEMO_LOC) : useMyLocation())}>
              {loc.mode === 'gps' ? t('useDemo', lang) : t('useGps', lang)}
            </button>
          )}
        </div>
        {near && near.ers.length > 0 && (
          <>
            <div className="muted">{t('nearYou', lang)}</div>
            {near.ers.slice(0, 4).map(er => (
              <div key={er.name} className={`near-er ${er.open ? '' : 'full'}`}>
                <b>{er.name}</b>
                <span>{er.driveMinutes} {t('minDrive', lang)} · ~{er.waitMinutes} {t('minWait', lang)}</span>
              </div>
            ))}
            <div className="fine">{t('nearHint', lang)}</div>
          </>
        )}
      </div>

      <label>{t('name', lang)}<input value={name} onChange={e => setName(e.target.value)} /></label>
      <label>{t('age', lang)}<input value={age} onChange={e => setAge(e.target.value)} inputMode="numeric" /></label>

      <button className={`mic ${rec.recording ? 'on' : ''}`} onClick={recordSymptoms} disabled={step === 'thinking'}>
        {rec.recording ? t('tapDone', lang) : step === 'thinking' ? t('working', lang) : t('describe', lang)}
      </button>

      <label>{t('heard', lang)}
        <textarea value={transcript} onChange={e => setTranscript(e.target.value)} rows={4}
          placeholder={t('typeHere', lang)} />
      </label>

      {error && <p className="error">{error}</p>}
      <button className="primary" onClick={submit} disabled={step === 'thinking'}>{t('checkIn', lang)}</button>
      <p className="fine">{t('call911', lang)}</p>
    </div>
  );
}

// "Call 911 now: an ambulance is..." -> "An ambulance is..." (the heading already says call 911).
function advice911(advice: string) {
  const rest = advice.replace(/^Call 911 now:?\s*/, '');
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

function fmt(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const OPTIONS_REFRESH_MS = 30_000;

// The ERs that could treat this patient right now: doctors, beds, equipment, drive and wait.
function Options({ patientId, lang }: { patientId: number; lang: Lang }) {
  const [data, setData] = useState<{ specialty: string; options: ErOption[] } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.options(patientId).then(d => alive && setData(d)).catch(() => {});
    load();
    const id = setInterval(load, OPTIONS_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [patientId]);
  if (!data) return null;
  return (
    <div className="card options">
      <div className="muted">{t('yourOptions', lang)} · {data.specialty}</div>
      {data.options.map(o => (
        <div key={o.hospitalId} className={`opt ${o.canTreat ? 'ok' : 'no'}`}>
          <div className="opt-head">
            <b>{o.canTreat ? '✓' : '✗'} {o.name}</b>
            <span>{o.driveMinutes} {t('minDrive', lang)}{o.waitMinutes ? ` · ~${o.waitMinutes} ${t('minWait', lang)}` : ''}</span>
          </div>
          <div className="opt-reason">{o.reason}</div>
          {o.canTreat && (
            <a href={`https://www.google.com/maps/dir/?api=1&destination=${o.lat},${o.lng}`} target="_blank" rel="noreferrer">
              {t('directions', lang)}
            </a>
          )}
        </div>
      ))}
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
        <div className="muted">A better match for you right now</div>
        <div className="big">{other.name}</div>
        {offer.reason && <p>{offer.reason}</p>}
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

  if (p.status === 'incoming' && p.advice.startsWith('Call 911')) {
    return (
      <div className="card status urgent">
        <div className="big">Call 911 now</div>
        <p>{advice911(p.advice)}</p>
        <a className="call911" href="tel:911">Call 911</a>
      </div>
    );
  }
  if (p.status === 'incoming' && p.advice && !responder) {
    return (
      <div className="card status go">
        <div className="muted">Matched to the right ER</div>
        <div className="big">{p.advice}</div>
        {p.etaMinutes > 0 && <p>The ER is expecting you in about {p.etaMinutes} min.</p>}
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
  const lang: Lang = session.lang ?? 'en';
  const { identity } = useSpacetimeDB();
  const [familyLink, setFamilyLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [arrived, setArrived] = useState(false);
  const [log, setLog] = useState<Array<{ a: string; r: FollowUpResult }>>([]);
  const [listening, setListening] = useState(false);
  const [sharing, setSharing] = useState(false);
  const rec = useRecorder();
  const pid = result.patientId;

  // Automatic check-ins run only while the patient is in the waiting room.
  const [patients] = useTable(tables.myPatients);
  const status = patients.find(p => pid != null && p.id === BigInt(pid))?.status;
  const [auto, setAuto] = useState(true);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const misses = useRef(0);
  const firstDone = useRef(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (status !== 'waiting' || !auto) return setNextAt(null);
    if (nextAt === null && !busy) setNextAt(Date.now() + (firstDone.current ? AUTO_EVERY_MS : AUTO_FIRST_MS));
  }, [status, auto, nextAt, busy]);

  useEffect(() => {
    if (nextAt !== null && now >= nextAt && !busy) {
      firstDone.current = true;
      setNextAt(null);
      void checkOnMe(true);
    }
  }, [now, nextAt, busy]);

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

  async function shareWithFamily() {
    if (pid == null || !identity) return;
    const { token } = await api.familyShare({ patientId: pid, phoneId: identity.toHexString() });
    const url = `${window.location.origin}${window.location.pathname}#/family/${token}`;
    setFamilyLink(url);
    try {
      if (navigator.share) await navigator.share({ title: 'FrontDoor status', url });
      else await navigator.clipboard.writeText(url);
    } catch {
      /* user cancelled share or clipboard blocked; the link is shown below */
    }
  }

  async function checkOnMe(automatic = false) {
    if (rec.recording) return rec.stop();
    if (pid == null) return;
    setBusy(true);
    try {
      const q = await api.followUpQuestion(pid);
      await api.speak(q, lang);
      setListening(true);
      const blob = await rec.start(automatic ? AUTO_LISTEN_MS : undefined);
      setListening(false);
      const a = await api.transcribe(blob, lang);
      const r = await api.followUp({ patientId: pid, question: q, answer: a });
      if (r.heard) {
        misses.current = 0;
        setLog(l => [{ a, r }, ...l]);
      } else if (automatic && ++misses.current >= MISSES_BEFORE_ALERT) {
        // Someone who stops answering may be getting worse: tell a nurse.
        misses.current = 0;
        await api.missedCheckins(pid, MISSES_BEFORE_ALERT);
      }
      await api.speak(r.spoken_reply, lang);
    } finally {
      setListening(false);
      setBusy(false);
    }
  }

  return (
    <div className="phone">
      <h1 className="brand">FrontDoor</h1>
      <div className="card ok">
        <strong>{t('checkedIn', lang)}, {name.split(' ')[0]}.</strong>
        <p>{result.spoken_reply}</p>
      </div>

      {pid != null && <LiveStatus patientId={pid} />}
      {pid != null && status === 'incoming' && <Options patientId={pid} lang={lang} />}

      {!arrived && pid != null && (
        <>
          <button className="primary" onClick={() => api.arrive(pid).then(() => setArrived(true))}>
            {t('arrived', lang)}
          </button>
          <div className="row">
            <button onClick={() => shareLocation(pid)} disabled={sharing}>
              {sharing ? 'Sharing location' : 'Share my location'}
            </button>
            <button className="ghost" onClick={() => api.drive(pid)}>Simulate drive</button>
          </div>
        </>
      )}

      <button className={`mic ${listening ? 'on' : ''}`} onClick={() => checkOnMe()} disabled={busy && !listening}>
        {listening ? t('listening', lang) : busy ? t('working', lang) : t('checkOnMe', lang)}
      </button>

      {status === 'waiting' && (
        <label className="auto">
          <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />
          {t('autoCheckins', lang)}
          {auto && nextAt !== null && !busy && (
            <span className="muted"> · {t('nextIn', lang)} {fmt(nextAt - now)}</span>
          )}
        </label>
      )}

      <button onClick={shareWithFamily}>{t('shareFamily', lang)}</button>
      {familyLink && (
        <p className="fine">{t('linkCopied', lang)}<br /><a href={familyLink}>{familyLink}</a></p>
      )}

      {log.map((e, i) => (
        <div key={i} className={`card ${e.r.level === 'none' ? '' : 'warn'}`}>
          <div className="muted">{t('youSaid', lang)}</div>
          <p>"{e.a}"</p>
          <div className="muted">{e.r.spoken_reply}</div>
        </div>
      ))}
      <p className="fine">{t('feelWorse', lang)}</p>
      <button className="ghost" onClick={onStartOver}>Start a new check-in</button>
    </div>
  );
}
