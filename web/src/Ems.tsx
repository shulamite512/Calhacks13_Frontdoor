import { useEffect, useRef, useState } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from './module_bindings';
import { api, type CrewVitals, type EmsAssessment, type VitalKey } from './api';
import { useRecorder } from './useRecorder';

type Loc = { lat: number; lng: number; mode: 'gps' | 'demo' };
type Run = { patientId: number; unit: string; hospital: string; gps: boolean; crew: VitalKey[] };
type VitalForm = Record<VitalKey, string>;

const EMPTY_VITALS: VitalForm = { hr: '', sbp: '', dbp: '', spo2: '', rr: '' };

function toForm(v: CrewVitals): VitalForm {
  const f = { ...EMPTY_VITALS };
  for (const k of Object.keys(f) as VitalKey[]) if (v[k] != null) f[k] = String(v[k]);
  return f;
}

function fromForm(f: VitalForm): CrewVitals {
  const v: CrewVitals = {};
  for (const k of Object.keys(f) as VitalKey[]) if (/^\d+$/.test(f[k].trim())) v[k] = Number(f[k]);
  return v;
}

// HR, BP, SpO2, RR inputs; values from the spoken report are marked so the crew checks them.
function VitalsInputs({ form, onChange, fromReport }: {
  form: VitalForm; onChange: (f: VitalForm) => void; fromReport?: CrewVitals;
}) {
  const field = (k: VitalKey, label: string) => (
    <label className={fromReport?.[k] != null ? 'from-report' : ''}>{label}
      <input value={form[k]} inputMode="numeric" onChange={e => onChange({ ...form, [k]: e.target.value })} />
    </label>
  );
  return (
    <div className="vital-inputs">
      {field('hr', 'HR')}{field('sbp', 'BP sys')}{field('dbp', 'BP dia')}{field('spo2', 'SpO₂ %')}{field('rr', 'RR')}
    </div>
  );
}

// Demo position for the ambulance (Mission District, SF) when the tablet is outside the network area.
const DEMO_LOC: Loc = { lat: 37.7599, lng: -122.4148, mode: 'demo' };
const RUN_KEY = 'frontdoor_ems_run';

function loadRun(): Run | null {
  try {
    const s = localStorage.getItem(RUN_KEY);
    return s ? { crew: [], ...JSON.parse(s) } : null;
  } catch {
    return null;
  }
}

function saveRun(r: Run | null) {
  try {
    if (r) localStorage.setItem(RUN_KEY, JSON.stringify(r));
    else localStorage.removeItem(RUN_KEY);
  } catch {
    /* storage unavailable */
  }
}

// The ambulance crew's tablet: speak the report, see which ERs can take the patient, pre-notify one.
export default function Ems() {
  const [run, setRun] = useState<Run | null>(loadRun);
  const [unit, setUnit] = useState('Medic 21');
  const [age, setAge] = useState('');
  const [sex, setSex] = useState('');
  const [loc, setLoc] = useState<Loc | null>(null);
  const [report, setReport] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [a, setA] = useState<EmsAssessment | null>(null);
  const [vitals, setVitals] = useState<VitalForm>(EMPTY_VITALS);
  const rec = useRecorder();
  const { identity } = useSpacetimeDB();

  useEffect(() => {
    if (run) return;
    const demo = () => setLoc(DEMO_LOC);
    if (!navigator.geolocation) return demo();
    navigator.geolocation.getCurrentPosition(
      async pos => {
        const l = { lat: pos.coords.latitude, lng: pos.coords.longitude, mode: 'gps' as const };
        try {
          setLoc((await api.nearby(l.lat, l.lng)).inServiceArea ? l : DEMO_LOC);
        } catch {
          demo();
        }
      },
      demo,
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, [run]);

  async function speak() {
    if (rec.recording) return rec.stop();
    setError('');
    try {
      setBusy('listening');
      const blob = await rec.start();
      setBusy('transcribing');
      setReport(await api.transcribe(blob, 'en'));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy('');
    }
  }

  async function assess() {
    if (!age || report.trim().length < 5) return setError('Add the patient age and your report.');
    if (!loc) return setError('Still finding the ambulance location, one moment.');
    setError('');
    setBusy('assessing');
    try {
      const r = await api.emsAssess({ transcript: report, age: Number(age), lat: loc.lat, lng: loc.lng });
      setA(r);
      setVitals(toForm(r.vitals));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy('');
    }
  }

  async function notify(hospitalId: number, hospital: string) {
    if (!a || !loc) return;
    if (!identity) return setError('Still connecting, try again in a moment.');
    setBusy('notifying');
    try {
      const v = fromForm(vitals);
      const r = await api.emsNotify({
        unit, age: Number(age), sex, transcript: report, lat: loc.lat, lng: loc.lng, phoneId: identity.toHexString(),
        hospitalId, complaint: a.complaint, summary: a.summary, acuity: a.acuity, redFlags: a.red_flags,
        prep: a.prep, specialty: a.specialty, vitals: v,
      });
      if (r.patientId == null) throw new Error('Pre-notification was not recorded.');
      const next = { patientId: r.patientId, unit, hospital, gps: loc.mode === 'gps', crew: Object.keys(v) as VitalKey[] };
      saveRun(next);
      setRun(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy('');
    }
  }

  function newPatient() {
    saveRun(null);
    setRun(null);
    setA(null);
    setReport('');
    setVitals(EMPTY_VITALS);
    setAge('');
    setSex('');
  }

  if (run) return <EnRoute run={run} onDone={newPatient} onCrew={crew => {
    const next = { ...run, crew };
    saveRun(next);
    setRun(next);
  }} />;

  return (
    <div className="phone ems">
      <h1 className="brand">FrontDoor <span className="ems-tag">EMS</span></h1>
      <p className="muted">
        {!loc ? 'Finding ambulance location…' : loc.mode === 'gps' ? '📍 Using GPS' : '📍 Demo location: Mission District, SF'}
      </p>
      <div className="row">
        <label>Unit<input value={unit} onChange={e => setUnit(e.target.value)} /></label>
        <label>Age<input value={age} onChange={e => setAge(e.target.value)} inputMode="numeric" /></label>
        <label>Sex
          <select value={sex} onChange={e => setSex(e.target.value)}>
            <option value="">–</option><option value="male">Male</option><option value="female">Female</option>
          </select>
        </label>
      </div>

      <button className={`mic ${rec.recording ? 'on' : ''}`} onClick={speak} disabled={!!busy && !rec.recording}>
        {rec.recording ? 'Tap when done' : busy === 'transcribing' ? 'Transcribing…' : '🎙 Speak your report'}
      </button>
      <label>Report
        <textarea value={report} onChange={e => setReport(e.target.value)} rows={4}
          placeholder="e.g. 64 male, crushing chest pain 30 min, ST elevation on 12-lead, BP 150/90, aspirin given" />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="primary" onClick={assess} disabled={!!busy}>
        {busy === 'assessing' ? 'Finding ERs…' : 'Find ERs that can take this patient'}
      </button>

      {a && (
        <>
          <div className={`card ${a.acuity <= 2 ? 'warn' : ''}`}>
            <div><b>ESI {a.acuity}</b> · {a.complaint} · needs {a.specialty || 'emergency care'}</div>
            <p>{a.summary}</p>
            {a.red_flags.length > 0 && <div className="fine">Red flags: {a.red_flags.join(', ')}</div>}
            {a.prep.length > 0 && <div className="fine">ER will prep: {a.prep.join(', ')}</div>}
          </div>
          <div className="card">
            <div className="muted">
              Vitals to send{Object.values(a.vitals).some(x => x != null) ? ' · highlighted = heard in your report, please check' : ''}
            </div>
            <VitalsInputs form={vitals} onChange={setVitals} fromReport={a.vitals} />
            <div className="fine">Anything left blank is shown to the ER as simulated monitor data.</div>
          </div>
          <div className="card options">
            <div className="muted">Destinations, nearest capable first</div>
            {a.options.map(o => (
              <div key={o.hospitalId} className={`opt ${o.canTreat ? 'ok' : 'no'}`}>
                <div className="opt-head">
                  <b>{o.canTreat ? '✓' : '✗'} {o.name}</b>
                  <span>{o.driveMinutes} min</span>
                </div>
                <div className="opt-reason">{o.reason}</div>
                {o.onFrontDoor ? (
                  <button className={o.canTreat ? 'primary' : ''} onClick={() => notify(o.hospitalId, o.name)} disabled={!!busy}>
                    {busy === 'notifying' ? 'Sending…' : `Pre-notify ${o.name.split(' (')[0]}`}
                  </button>
                ) : o.canTreat && <div className="fine">Not on FrontDoor yet: call it in by radio.</div>}
              </div>
            ))}
          </div>
        </>
      )}
      <p className="fine">Destination decisions follow your local EMS protocols and medical control.</p>
    </div>
  );
}

// Read each new hospital reply aloud (Cartesia Sonic) so the crew keeps their eyes on the patient.
function SpeakReplies({ lines }: { lines: string[] }) {
  const said = useRef(new Set<string>());
  const key = lines.join('|');
  useEffect(() => {
    const fresh = lines.filter(l => !said.current.has(l));
    fresh.forEach(l => said.current.add(l));
    if (fresh.length) void api.speak(fresh.join(' ')).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

// After pre-notifying: live monitor feed going out, and the hospital's replies coming back.
function EnRoute({ run, onDone, onCrew }: { run: Run; onDone: () => void; onCrew: (crew: VitalKey[]) => void }) {
  const { identity } = useSpacetimeDB();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<VitalForm>(EMPTY_VITALS);
  const [sendError, setSendError] = useState('');
  // These views only return the patient this tablet pre-notified.
  const [patients] = useTable(tables.myPatients);
  const [vitals] = useTable(tables.myVitals);
  const [alerts] = useTable(tables.myAlerts);
  const [beds] = useTable(tables.bed);
  const pid = BigInt(run.patientId);
  const p = patients.find(x => x.id === pid);
  const enRoute = p?.status === 'incoming';

  // With real GPS, keep the ER's map and ETA current.
  useEffect(() => {
    if (!run.gps || !enRoute || !navigator.geolocation) return;
    const watch = navigator.geolocation.watchPosition(
      pos => void api.location({ patientId: run.patientId, lat: pos.coords.latitude, lng: pos.coords.longitude }).catch(() => {}),
      () => {},
      { enableHighAccuracy: true },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [run.gps, run.patientId, enRoute]);

  if (!p) return <div className="phone ems"><h1 className="brand">FrontDoor <span className="ems-tag">EMS</span></h1><p className="muted">Sending…</p></div>;

  const v = [...vitals].filter(x => x.patientId === pid).sort((x, y) => Number(y.id - x.id))[0];
  const bed = beds.find(b => b.patientId === pid);
  const responder = [...alerts]
    .filter(x => x.patientId === pid && x.ackedBy !== undefined)
    .sort((x, y) => Number(y.id - x.id))[0]?.ackedBy;
  const divert = p.advice.startsWith('Divert suggested') ? p.advice : '';
  const spoken = [
    bed && `Bed ${bed.label} held for your patient.`,
    responder && `${responder} acknowledged.`,
    divert && `The hospital suggests ${divert.replace(/^Divert suggested:\s*/, '').split(' (')[0]}.`,
  ].filter(Boolean) as string[];

  const Src = ({ k }: { k: VitalKey[] }) => {
    const crew = k.every(x => run.crew.includes(x));
    return <span className={`vsrc ${crew ? 'crew' : ''}`}>{crew ? 'crew' : 'sim'}</span>;
  };

  async function sendVitals() {
    if (!identity) return setSendError('Still connecting, try again in a moment.');
    const changed = fromForm(form);
    if (!Object.keys(changed).length) return setSendError('Enter at least one reading.');
    try {
      const r = await api.emsVitals({ patientId: run.patientId, phoneId: identity.toHexString(), vitals: changed });
      onCrew(Object.keys(r.crew) as VitalKey[]);
      setEditing(false);
      setSendError('');
    } catch (e) {
      setSendError(String(e));
    }
  }

  const replies = [
    { text: `${run.hospital} received your report`, done: true },
    { text: bed ? `Bed ${bed.label} (${bed.zone}) ${bed.status === 'reserved' ? 'held' : 'assigned'} for your patient` : 'Waiting for a bed', done: !!bed },
    { text: responder ? `${responder} acknowledged` : 'Waiting for a nurse to acknowledge', done: !!responder },
    { text: enRoute ? `Expected in about ${p.etaMinutes} min` : 'Arrived: hand over at the ambulance bay', done: !enRoute },
  ];

  return (
    <div className="phone ems">
      <SpeakReplies lines={spoken} />
      <h1 className="brand">FrontDoor <span className="ems-tag">EMS</span></h1>
      <div className="card status go">
        <div className="muted">{run.unit} · pre-notified</div>
        <div className="big">{run.hospital}</div>
        <p>ESI {p.acuity} · {p.complaint}</p>
      </div>
      {divert && (
        <div className="card offer-card">
          <div className="muted">The hospital suggests another destination</div>
          <p><b>{divert.replace(/^Divert suggested:\s*/, '')}</b></p>
          <div className="fine">Your call, per protocol and medical control.</div>
        </div>
      )}
      <div className="card">
        <div className="muted">Vitals the ER sees {enRoute ? '· live' : ''}</div>
        {v ? (
          <div className="vitals">
            <span className={v.hr > 120 || v.hr < 50 ? 'bad' : ''}>HR <b>{v.hr}</b><Src k={['hr']} /></span>
            <span className={v.sbp < 90 || v.sbp > 180 ? 'bad' : ''}>BP <b>{v.sbp}/{v.dbp}</b><Src k={['sbp', 'dbp']} /></span>
            <span className={v.spo2 < 92 ? 'bad' : ''}>SpO₂ <b>{v.spo2}%</b><Src k={['spo2']} /></span>
            <span>RR <b>{v.rr}</b><Src k={['rr']} /></span>
          </div>
        ) : <div className="vitals muted">Connecting…</div>}
        <div className="fine">crew = your readings · sim = simulated monitor (no real monitor connected in this demo)</div>
        {enRoute && !editing && (
          <button className="ghost" onClick={() => {
            setForm(v ? toForm({ hr: v.hr, sbp: v.sbp, dbp: v.dbp, spo2: v.spo2, rr: v.rr }) : EMPTY_VITALS);
            setEditing(true);
          }}>Update vitals</button>
        )}
        {editing && (
          <>
            <VitalsInputs form={form} onChange={setForm} />
            {sendError && <p className="error">{sendError}</p>}
            <div className="row">
              <button className="primary" onClick={sendVitals}>Send to ER</button>
              <button onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </>
        )}
      </div>
      <div className="muted">Hospital replies</div>
      <ul className="timeline">
        {replies.map(r => <li key={r.text} className={r.done ? 'done' : ''}>{r.text}</li>)}
      </ul>
      <div className="row">
        {enRoute && <button className="ghost" onClick={() => api.drive(run.patientId)}>Simulate drive</button>}
        <button onClick={onDone}>New patient</button>
      </div>
    </div>
  );
}
