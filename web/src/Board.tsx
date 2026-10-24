import { useEffect, useMemo, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import type { Timestamp } from 'spacetimedb';
import { reducers, tables } from './module_bindings';
import type { Alert, Bed, Patient, Vitals } from './module_bindings/types';
import { api } from './api';

const RISK_RANK: Record<string, number> = { critical: 0, watch: 1, normal: 2 };

function ms(ts: Timestamp) {
  return Number(ts.microsSinceUnixEpoch / 1000n);
}

function ago(ts: Timestamp, now: number) {
  const s = Math.max(0, Math.round((now - ms(ts)) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

// Resus for the sickest, fast track for minor problems, acute otherwise.
function pickBed(p: Patient, beds: readonly Bed[]) {
  const free = beds.filter(b => b.status === 'free');
  const zones =
    p.risk === 'critical' || p.acuity <= 1 ? ['Resus', 'Acute', 'Fast track']
    : p.acuity >= 4 ? ['Fast track', 'Acute', 'Resus']
    : ['Acute', 'Resus', 'Fast track'];
  for (const z of zones) {
    const b = free.find(b => b.zone === z);
    if (b) return b;
  }
  return undefined;
}

export default function Board() {
  const conn = useSpacetimeDB();
  const [patients] = useTable(tables.patient);
  const [vitals] = useTable(tables.vitals);
  const [alerts] = useTable(tables.alert);
  const [beds] = useTable(tables.bed);
  const [forecasts] = useTable(tables.forecast);
  const ackAlert = useReducer(reducers.ackAlert);
  const assignBed = useReducer(reducers.assignBed);
  const freeBed = useReducer(reducers.freeBed);
  const [nurse, setNurse] = useState('Charge RN');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(t);
  }, []);

  const byPatient = useMemo(() => {
    const m = new Map<bigint, Vitals[]>();
    for (const v of [...vitals].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const list = m.get(v.patientId) ?? [];
      list.push(v);
      m.set(v.patientId, list);
    }
    return m;
  }, [vitals]);

  const name = (id: bigint) => patients.find(p => p.id === id)?.name ?? `#${id}`;
  const sorted = [...patients].sort(
    (a, b) => RISK_RANK[a.risk] - RISK_RANK[b.risk] || a.acuity - b.acuity || Number(a.id - b.id)
  );
  const incoming = sorted.filter(p => p.status === 'incoming');
  const waiting = sorted.filter(p => p.status === 'waiting');
  const allOpen = [...alerts]
    .filter(a => a.ackedAt === undefined)
    .sort((a, b) => (a.level === b.level ? Number(b.id - a.id) : a.level === 'critical' ? -1 : 1));
  // One banner per patient: the most severe, newest open alert.
  const openAlerts = allOpen.filter((a, i) => allOpen.findIndex(x => x.patientId === a.patientId) === i);

  function ackPatient(patientId: bigint) {
    for (const a of allOpen) if (a.patientId === patientId) ackAlert({ alertId: a.id, nurse });
  }
  const acked = [...alerts].filter(a => a.ackedAt !== undefined).sort((a, b) => Number(b.id - a.id));
  const recentAcked = acked
    .filter((a, i) => acked.findIndex(x => x.patientId === a.patientId) === i)
    .filter(a => !openAlerts.some(o => o.patientId === a.patientId))
    .slice(0, 3);
  const f = forecasts[0];

  function assign(p: Patient) {
    const b = pickBed(p, beds);
    if (b) assignBed({ bedId: b.id, patientId: p.id });
    else alert('No free beds');
  }

  return (
    <div className="board">
      <header>
        <div>
          <span className="brand">FrontDoor</span> <span className="muted">Charge nurse board</span>
          <span className={`dot ${conn.isActive ? 'live' : ''}`} title={conn.isActive ? 'Live' : 'Connecting'} />
        </div>
        {f && (
          <div className={`forecast ${f.bedsShort > 0 ? 'short' : 'ok'}`} title={f.basis}>
            {f.bedsShort > 0
              ? `${f.bedsShort} bed${f.bedsShort === 1 ? '' : 's'} short in ${f.horizonMinutes} min`
              : `Beds OK for next ${f.horizonMinutes} min`}
            <small>{f.basis}</small>
          </div>
        )}
        <label className="nurse">You are <input value={nurse} onChange={e => setNurse(e.target.value)} /></label>
      </header>

      {(openAlerts.length > 0 || recentAcked.length > 0) && (
        <section className="alerts">
          {openAlerts.map(a => (
            <div key={String(a.id)} className={`alert ${a.level}`}>
              <strong>{name(a.patientId)}</strong> {a.reason} <span className="muted">{ago(a.createdAt, now)}</span>
              <button onClick={() => ackPatient(a.patientId)}>I'm on it</button>
            </div>
          ))}
          {recentAcked.map(a => (
            <div key={String(a.id)} className="alert acked">
              <strong>{name(a.patientId)}</strong> {a.reason} <span className="muted">· {a.ackedBy} is on it</span>
            </div>
          ))}
        </section>
      )}

      <main>
        <Column title="Incoming" patients={incoming} vitals={byPatient} alerts={alerts} onAssign={assign} />
        <Column title="Waiting room" patients={waiting} vitals={byPatient} alerts={alerts} onAssign={assign} />
        <section className="col">
          <h2>Beds <span className="muted">{beds.filter(b => b.status === 'free').length} free</span></h2>
          <div className="beds">
            {[...beds].sort((a, b) => a.id - b.id).map(b => (
              <button key={b.id} className={`bed ${b.status}`} onClick={() => freeBed({ bedId: b.id })}
                title={b.status === 'occupied' ? 'Tap to discharge' : b.status === 'cleaning' ? 'Tap when clean' : 'Free'}>
                <b>{b.label}</b>
                <span>{b.zone}</span>
                <em>{b.patientId !== undefined ? name(b.patientId) : b.status}</em>
              </button>
            ))}
          </div>
        </section>
      </main>

      <footer>
        <button onClick={() => api.reset()}>Reset demo</button>
        <span className="muted">Demo controls: tap "Worsen" on a tile to simulate deterioration.</span>
      </footer>
    </div>
  );
}

function Column(props: {
  title: string;
  patients: Patient[];
  vitals: Map<bigint, Vitals[]>;
  alerts: readonly Alert[];
  onAssign: (p: Patient) => void;
}) {
  return (
    <section className="col">
      <h2>{props.title} <span className="muted">{props.patients.length}</span></h2>
      {props.patients.map(p => (
        <Tile key={String(p.id)} p={p} vitals={props.vitals.get(p.id) ?? []} onAssign={props.onAssign}
          openAlert={props.alerts.some(a => a.patientId === p.id && a.ackedAt === undefined)} />
      ))}
      {props.patients.length === 0 && <p className="muted">None</p>}
    </section>
  );
}

function Tile({ p, vitals, onAssign, openAlert }: {
  p: Patient; vitals: Vitals[]; onAssign: (p: Patient) => void; openAlert: boolean;
}) {
  const v = vitals[vitals.length - 1];
  const flags = p.redFlags.split(',').map(s => s.trim()).filter(Boolean);
  return (
    <div className={`tile ${p.risk} ${openAlert ? 'pulse' : ''}`}>
      <div className="tile-head">
        <span className={`esi esi${p.acuity}`}>ESI {p.acuity}</span>
        <strong>{p.name}</strong> <span className="muted">{p.age}</span>
        {p.status === 'incoming' && <span className="eta">ETA {p.etaMinutes}m</span>}
      </div>
      <div className="complaint">{p.complaint}</div>
      <p className="summary">{p.summary}</p>
      {flags.length > 0 && <div className="flags">{flags.map(f => <span key={f}>{f}</span>)}</div>}
      {v && (
        <div className="vitals">
          <span className={v.hr >= 110 ? 'bad' : ''}>HR <b>{v.hr}</b></span>
          <span className={v.spo2 <= 93 ? 'bad' : ''}>SpO₂ <b>{v.spo2}</b></span>
          <span className={v.sbp <= 90 ? 'bad' : ''}>BP <b>{v.sbp}/{v.dbp}</b></span>
          <span className={v.rr >= 22 ? 'bad' : ''}>RR <b>{v.rr}</b></span>
          <Spark values={vitals.map(x => x.hr)} />
        </div>
      )}
      <div className="actions">
        <button className="primary" onClick={() => onAssign(p)}>Assign bed</button>
        <button className="ghost" onClick={() => api.worsen(Number(p.id))}>Worsen</button>
      </div>
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  const pts = values.slice(-20);
  if (pts.length < 2) return null;
  const lo = Math.min(...pts, 60), hi = Math.max(...pts, 120);
  const d = pts.map((y, i) => `${(i / (pts.length - 1)) * 80},${24 - ((y - lo) / (hi - lo)) * 22}`).join(' ');
  return (
    <svg className="spark" width="80" height="26" viewBox="0 0 80 26" aria-label="Heart rate trend">
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
