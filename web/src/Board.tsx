import { useEffect, useMemo, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import type { Timestamp } from 'spacetimedb';
import { reducers, tables } from './module_bindings';
import type { AgentAction, Alert, Bed, Department, Hospital, HospitalDepartment, Patient, RedirectOffer, Vitals } from './module_bindings/types';
import { api } from './api';
import IncomingMap from './IncomingMap';

const RISK_RANK: Record<string, number> = { critical: 0, watch: 1, normal: 2 };
const LANG_NAMES: Record<string, string> = { es: 'Spanish', zh: 'Chinese', vi: 'Vietnamese', tl: 'Tagalog' };
const BED_HINT: Record<string, string> = {
  occupied: 'Tap to discharge',
  cleaning: 'Tap when clean',
  reserved: 'Tap to release hold',
};

function ms(ts: Timestamp) {
  return Number(ts.microsSinceUnixEpoch / 1000n);
}

function ago(ts: Timestamp, now: number) {
  const s = Math.max(0, Math.round((now - ms(ts)) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

// Resus for the sickest, fast track for minor problems, acute otherwise.
// Hallway stretchers are a last resort and only when allowed (never for holds).
function pickBed(p: Patient, beds: readonly Bed[], allowHallway = false) {
  const free = beds.filter(b => b.status === 'free');
  const zones =
    p.risk === 'critical' || p.acuity <= 1 ? ['Resus', 'Acute', 'Fast track']
    : p.acuity >= 4 ? ['Fast track', 'Acute', 'Resus']
    : ['Acute', 'Resus', 'Fast track'];
  for (const z of allowHallway ? [...zones, 'Hallway'] : zones) {
    const b = free.find(b => b.zone === z);
    if (b) return b;
  }
  return undefined;
}

// Is the department this patient needs ready (doctor on call, a specialty bed, key resource)?
function readiness(p: Patient, departments: readonly Department[]) {
  if (!p.specialty) return null;
  const d = departments.find(d => d.name === p.specialty);
  if (!d) return null;
  if (d.bedsTotal === 0) return { ok: false, text: `Needs ${d.name}: not offered here. ${d.note}` };
  const gaps = [];
  if (d.doctorsOnCall === 0) gaps.push('no doctor on call');
  if (d.bedsFree === 0) gaps.push(`no ${d.bedLabel} free`);
  if (!d.resourceReady) gaps.push(`${d.resource} not ready`);
  return gaps.length
    ? { ok: false, text: `Needs ${d.name}: ${gaps.join(' · ')}` }
    : { ok: true, text: `Needs ${d.name}: ${d.doctorsOnCall} on call · ${d.bedsFree} ${d.bedLabel} · ${d.resource} ready` };
}

// Readiness of a department at another ER: ready / busy (gap) / not offered.
function deptState(d: HospitalDepartment | undefined) {
  if (!d || d.bedsTotal === 0) return 'none';
  return d.doctorsOnCall > 0 && d.bedsFree > 0 && d.resourceReady ? 'ok' : 'gap';
}

// Can FrontDoor suggest another ER? Only stable walk-ins who haven't arrived (EMTALA).
function canRedirect(p: Patient) {
  return p.status === 'incoming' && p.source === 'walk-in' && p.acuity >= 3 && p.risk !== 'critical';
}

// Staff gate: the board's data views return nothing until this browser is granted the staff role.
export default function Board() {
  const conn = useSpacetimeDB();
  const [me] = useTable(tables.myStaff);
  if (!conn.isActive) return null;
  if (me.length === 0) return <StaffLogin identity={conn.identity?.toHexString() ?? ''} />;
  return <BoardInner nurse={me[0].name} />;
}

function StaffLogin({ identity }: { identity: string }) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.staffLogin({ pin, identity, name: name || 'Charge RN' });
    } catch (err) {
      setError(String(err).includes('403') ? 'Wrong PIN' : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="phone login" onSubmit={login}>
      <h1 className="brand">FrontDoor</h1>
      <p className="muted">Staff sign-in for the charge nurse board.</p>
      <label>Your name<input value={name} onChange={e => setName(e.target.value)} placeholder="Charge RN" /></label>
      <label>Staff PIN<input value={pin} onChange={e => setPin(e.target.value)} type="password" inputMode="numeric" /></label>
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy || !pin || !identity}>Sign in</button>
    </form>
  );
}

function BoardInner({ nurse }: { nurse: string }) {
  const conn = useSpacetimeDB();
  const [patients] = useTable(tables.myPatients);
  const [vitals] = useTable(tables.myVitals);
  const [alerts] = useTable(tables.myAlerts);
  const [beds] = useTable(tables.bed);
  const [forecasts] = useTable(tables.forecast);
  const [hospitals] = useTable(tables.hospital);
  const [offers] = useTable(tables.myOffers);
  const [departments] = useTable(tables.department);
  const [hospitalDepts] = useTable(tables.hospitalDepartment);
  const updateDepartment = useReducer(reducers.updateDepartment);
  const [showAllDepts, setShowAllDepts] = useState(false);
  const ackAlert = useReducer(reducers.ackAlert);
  const assignBed = useReducer(reducers.assignBed);
  const freeBed = useReducer(reducers.freeBed);
  const holdBed = useReducer(reducers.holdBed);
  const resolveAction = useReducer(reducers.resolveAgentAction);
  const [agentActions] = useTable(tables.myAgentActions);
  const logout = useReducer(reducers.staffLogout);
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
  const incoming = sorted.filter(p => p.status === 'incoming').sort((a, b) => a.etaMinutes - b.etaMinutes);
  const waiting = sorted.filter(p => p.status === 'waiting');
  const allOpen = [...alerts]
    .filter(a => a.ackedAt === undefined)
    .sort((a, b) => (a.level === b.level ? Number(b.id - a.id) : a.level === 'critical' ? -1 : 1));
  // One banner per patient: the most severe, newest open alert.
  const openAlerts = allOpen.filter((a, i) => allOpen.findIndex(x => x.patientId === a.patientId) === i);

  function ackPatient(patientId: bigint) {
    for (const a of allOpen) if (a.patientId === patientId) ackAlert({ alertId: a.id });
  }
  const acked = [...alerts].filter(a => a.ackedAt !== undefined).sort((a, b) => Number(b.id - a.id));
  const recentAcked = acked
    .filter((a, i) => acked.findIndex(x => x.patientId === a.patientId) === i)
    .filter(a => !openAlerts.some(o => o.patientId === a.patientId))
    .slice(0, 3);
  const f = forecasts[0];

  const heldBed = (p: Patient) => beds.find(b => b.status === 'reserved' && b.patientId === p.id);

  function assign(p: Patient) {
    const b = heldBed(p) ?? pickBed(p, beds, true);
    if (b) assignBed({ bedId: b.id, patientId: p.id });
    else alert('No free beds, including hallway. Consider suggesting another ER to incoming walk-ins.');
  }

  function hold(p: Patient) {
    const held = heldBed(p);
    if (held) return freeBed({ bedId: held.id });  // second tap releases the hold
    const b = pickBed(p, beds);
    if (b) holdBed({ bedId: b.id, patientId: p.id });
    else alert('No free beds to hold');
  }

  // Copilot proposals run with the nurse's own permissions once approved.
  async function approve(a: AgentAction) {
    try {
      if (a.kind === 'suggest_bed') await assignBed({ bedId: a.bedId, patientId: a.patientId });
      if (a.kind === 'suggest_other_er') await api.suggestRedirect(Number(a.patientId));
      await resolveAction({ actionId: a.id, status: 'approved' });
    } catch (e) {
      alert(String(e));
    }
  }

  async function undo(a: AgentAction) {
    try {
      if (a.kind === 'hold_bed' && beds.find(b => b.id === a.bedId)?.status === 'reserved') await freeBed({ bedId: a.bedId });
      await resolveAction({ actionId: a.id, status: 'undone' });
    } catch (e) {
      alert(String(e));
    }
  }

  function suggest(p: Patient) {
    api.suggestRedirect(Number(p.id)).catch(e => alert(String(e)));
  }
  const short = (f?.bedsShort ?? 0) > 0;
  const bedActions = {
    beds, offers, hospitals, departments, short, agentActions, onAssign: assign, onHold: hold, onSuggest: suggest,
  };

  // Departments current patients need go first (with a count); the rest fold behind "Show all".
  const need = new Map<string, number>();
  for (const p of patients) {
    if (p.specialty && ['incoming', 'waiting', 'roomed'].includes(p.status)) {
      need.set(p.specialty, (need.get(p.specialty) ?? 0) + 1);
    }
  }
  const deptsSorted = [...departments].sort(
    (a, b) => (need.get(b.name) ?? 0) - (need.get(a.name) ?? 0) || a.id - b.id
  );
  const deptsShown = showAllDepts ? deptsSorted : deptsSorted.filter(d => need.has(d.name));

  function adjust(d: Department, change: Partial<Pick<Department, 'bedsFree' | 'doctorsOnCall' | 'resourceReady'>>) {
    const next = { bedsFree: d.bedsFree, doctorsOnCall: d.doctorsOnCall, resourceReady: d.resourceReady, ...change };
    updateDepartment({
      id: d.id,
      bedsFree: Math.max(0, Math.min(d.bedsTotal, next.bedsFree)),
      doctorsOnCall: Math.max(0, next.doctorsOnCall),
      resourceReady: next.resourceReady,
    });
  }
  const redirected = sorted.filter(p => p.status === 'redirected');
  const rooms = [...beds].filter(b => b.zone !== 'Hallway').sort((a, b) => a.id - b.id);
  const hallway = [...beds].filter(b => b.zone === 'Hallway').sort((a, b) => a.id - b.id);

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
        <div className="nurse">
          Signed in as <b>{nurse}</b> <button className="ghost" onClick={() => logout()}>Sign out</button>
        </div>
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

      <Copilot actions={agentActions} onApprove={approve} onReject={a => resolveAction({ actionId: a.id, status: 'rejected' })}
        onUndo={undo} />

      <main>
        <Column title="Incoming" patients={incoming} vitals={byPatient} alerts={alerts} {...bedActions}>
          <IncomingMap patients={incoming} hospitals={hospitals} />
        </Column>
        <Column title="Waiting room" patients={waiting} vitals={byPatient} alerts={alerts} {...bedActions} />
        <section className="col">
          <h2>Beds <span className="muted">{rooms.filter(b => b.status === 'free').length} free</span></h2>
          <div className="beds">
            {[...rooms, ...hallway].map(b => (
              <button key={b.id} className={`bed ${b.status}`} onClick={() => freeBed({ bedId: b.id })}
                title={BED_HINT[b.status] ?? 'Free'}>
                <b>{b.label}</b>
                <span>{b.zone}</span>
                <em>{b.patientId !== undefined ? `${b.status === 'reserved' ? 'Held: ' : ''}${name(b.patientId)}` : b.status}</em>
              </button>
            ))}
          </div>

          <h2 className="sub">
            Departments <span className="muted">{need.size} needed now · {departments.length} total</span>
          </h2>
          <div className="depts">
            {deptsShown.map(d => (
              <div key={d.id} className={`dept ${d.bedsTotal === 0 ? 'none' : ''}`} title={d.note}>
                <b>
                  {d.name}
                  {need.has(d.name) && <span className="need">{need.get(d.name)} pt{need.get(d.name) === 1 ? '' : 's'}</span>}
                  {d.note.includes('CDPH') && <span className="real" title={d.note}>licensed total: CDPH</span>}
                </b>
                {d.bedsTotal === 0 ? (
                  <span className="muted">{d.note}</span>
                ) : (
                  <span className="dept-controls">
                    <span className={d.doctorsOnCall ? '' : 'bad'}>
                      <button onClick={() => adjust(d, { doctorsOnCall: d.doctorsOnCall - 1 })}>−</button>
                      {d.doctorsOnCall} dr
                      <button onClick={() => adjust(d, { doctorsOnCall: d.doctorsOnCall + 1 })}>+</button>
                    </span>
                    <span className={d.bedsFree ? '' : 'bad'}>
                      <button onClick={() => adjust(d, { bedsFree: d.bedsFree - 1 })}>−</button>
                      {d.bedsFree}/{d.bedsTotal} {d.bedLabel}
                      <button onClick={() => adjust(d, { bedsFree: d.bedsFree + 1 })}>+</button>
                    </span>
                    <button className={`res ${d.resourceReady ? 'ready' : 'busy'}`}
                      onClick={() => adjust(d, { resourceReady: !d.resourceReady })}>
                      {d.resource}: {d.resourceReady ? 'ready' : 'busy'}
                    </button>
                  </span>
                )}
              </div>
            ))}
            <button className="ghost" onClick={() => setShowAllDepts(v => !v)}>
              {showAllDepts ? 'Show only needed departments' : `Show all ${departments.length} departments`}
            </button>
          </div>

          <h2 className="sub">Nearby ERs <span className="muted">simulated capacity</span></h2>
          <div className="network">
            {[...hospitals].sort((a, b) => a.waitMinutes - b.waitMinutes).map(h => (
              <div key={h.id} className={`er ${h.bedsFree === 0 ? 'full' : ''}`}>
                <b>{h.name}</b>
                <span>{h.bedsFree} ER beds · ~{h.waitMinutes} min wait</span>
                <div className="er-depts">
                  {[...need.keys()].map(name => {
                    const d = hospitalDepts.find(x => x.hospitalId === h.id && x.name === name);
                    const state = deptState(d);
                    return <span key={name} className={`chip ${state}`} title={d?.note ?? ''}>{name}</span>;
                  })}
                </div>
              </div>
            ))}
          </div>

          {redirected.length > 0 && (
            <>
              <h2 className="sub">Redirected <span className="muted">{redirected.length}</span></h2>
              {redirected.map(p => {
                const o = [...offers].reverse().find(o => o.patientId === p.id && o.status === 'accepted');
                const h = hospitals.find(h => h.id === o?.hospitalId);
                return (
                  <div key={String(p.id)} className="er">
                    <b>{p.name}</b> <span>{p.complaint} → {h?.name ?? 'another ER'}</span>
                  </div>
                );
              })}
            </>
          )}
        </section>
      </main>

      <footer>
        <button onClick={() => api.reset()}>Reset demo</button>
        <span className="muted">Demo controls: tap "Worsen" on a tile to simulate deterioration.</span>
      </footer>
    </div>
  );
}

type BedActions = {
  beds: readonly Bed[];
  offers: readonly RedirectOffer[];
  hospitals: readonly Hospital[];
  departments: readonly Department[];
  agentActions: readonly AgentAction[];
  short: boolean;
  onAssign: (p: Patient) => void;
  onHold: (p: Patient) => void;
  onSuggest: (p: Patient) => void;
};

function Column(props: BedActions & {
  title: string;
  patients: Patient[];
  vitals: Map<bigint, Vitals[]>;
  alerts: readonly Alert[];
  children?: React.ReactNode;
}) {
  return (
    <section className="col">
      <h2>{props.title} <span className="muted">{props.patients.length}</span></h2>
      {props.children}
      {props.patients.map(p => (
        <Tile key={String(p.id)} p={p} vitals={props.vitals.get(p.id) ?? []}
          beds={props.beds} offers={props.offers} hospitals={props.hospitals} departments={props.departments}
          agentActions={props.agentActions} short={props.short}
          onAssign={props.onAssign} onHold={props.onHold} onSuggest={props.onSuggest}
          held={props.beds.find(b => b.status === 'reserved' && b.patientId === p.id)}
          openAlert={props.alerts.some(a => a.patientId === p.id && a.ackedAt === undefined)} />
      ))}
      {props.patients.length === 0 && <p className="muted">None</p>}
    </section>
  );
}

function Tile({ p, vitals, offers, hospitals, departments, agentActions, short, onAssign, onHold, onSuggest, held, openAlert }: BedActions & {
  p: Patient; vitals: Vitals[]; held?: Bed; openAlert: boolean;
}) {
  const v = vitals[vitals.length - 1];
  const flags = p.redFlags.split(',').map(s => s.trim()).filter(Boolean);
  const prep = p.prep.split(',').map(s => s.trim()).filter(Boolean);
  const incoming = p.status === 'incoming';
  const offer = [...offers].reverse().find(o => o.patientId === p.id);
  const offerTo = hospitals.find(h => h.id === offer?.hospitalId)?.name;
  const ready = readiness(p, departments);
  const emsAdvice = agentActions.find(a => a.patientId === p.id && a.kind === 'ems_destination' && a.status !== 'rejected');
  return (
    <div className={`tile ${p.risk} ${openAlert ? 'pulse' : ''}`}>
      <div className="tile-head">
        <span className={`esi esi${p.acuity}`}>ESI {p.acuity}</span>
        <span className={`src ${p.source}`}>{p.source === 'ems' ? 'EMS' : 'Walk-in'}</span>
        {p.language !== 'en' && <span className="lang" title="Replies are spoken in this language">{LANG_NAMES[p.language] ?? p.language}</span>}
        <strong>{p.name}</strong> <span className="muted">{p.age}</span>
        {p.status === 'incoming' && <span className="eta">ETA {p.etaMinutes}m</span>}
      </div>
      <div className="complaint">{p.complaint}</div>
      <p className="summary">{p.summary}</p>
      {flags.length > 0 && <div className="flags">{flags.map(f => <span key={f}>{f}</span>)}</div>}
      {ready && <div className={`ready ${ready.ok ? 'ok' : 'gap'}`}>{ready.ok ? '✓' : '⚠'} {ready.text}</div>}
      {emsAdvice && (
        <div className="advice gap">🚑 {emsAdvice.summary}{emsAdvice.status === 'approved' ? ` · crew called by ${emsAdvice.decidedBy}` : ''}</div>
      )}
      {incoming && p.advice && (
        <div className={`advice ${p.advice.startsWith('Call 911') ? 'gap' : 'ok'}`}>Told patient: {p.advice}</div>
      )}
      {incoming && prep.length > 0 && (
        <div className="prep">
          <b>Prepare before arrival:</b> {prep.join(' · ')}
          {held && <span className="held">Bed {held.label} held</span>}
        </div>
      )}
      {incoming && p.source !== 'ems' ? (
        <div className="vitals muted">No vitals yet · symptoms by voice; wearable starts at triage</div>
      ) : v && (
        <div className="vitals" title="Demo replays real de-identified ER stays (MIMIC-IV-ED)">
          <span className="wearable">{incoming ? 'Paramedic monitor' : 'Wearable'}</span>
          <span className={v.hr >= 110 ? 'bad' : ''}>HR <b>{v.hr}</b></span>
          <span className={v.spo2 <= 93 ? 'bad' : ''}>SpO₂ <b>{v.spo2}</b></span>
          <span className={v.sbp <= 90 ? 'bad' : ''}>BP <b>{v.sbp}/{v.dbp}</b></span>
          <span className={v.rr >= 22 ? 'bad' : ''}>RR <b>{v.rr}</b></span>
          <Spark values={vitals.map(x => x.hr)} />
        </div>
      )}
      <div className="actions">
        {incoming ? (
          <button className={held ? 'ghost' : 'primary'} onClick={() => onHold(p)}>
            {held ? `Release ${held.label}` : 'Hold bed'}
          </button>
        ) : (
          <button className="primary" onClick={() => onAssign(p)}>Assign bed</button>
        )}
        {canRedirect(p) && offer?.status !== 'pending' && (
          <button className={short ? 'warn' : 'ghost'} onClick={() => onSuggest(p)}>Suggest another ER</button>
        )}
        {!incoming && <button className="ghost" onClick={() => api.worsen(Number(p.id))}>Worsen</button>}
      </div>
      {offer?.status === 'pending' && (
        <div className="offer">Better match offered: {offerTo}. {offer.reason} Waiting for patient…</div>
      )}
      {offer?.status === 'declined' && <div className="offer muted">Patient kept their spot here.</div>}
    </div>
  );
}

const KIND_ICON: Record<string, string> = {
  hold_bed: '🛏', ems_destination: '🚑', page: '📟', checklist: '📋', prioritize: '⚡', suggest_bed: '🛏', suggest_other_er: '🧭', note: '💬',
};

// The agent's live feed: proposals waiting for a nurse first, then what it did on its own.
function Copilot({ actions, onApprove, onReject, onUndo }: {
  actions: readonly AgentAction[];
  onApprove: (a: AgentAction) => void;
  onReject: (a: AgentAction) => void;
  onUndo: (a: AgentAction) => void;
}) {
  const sorted = [...actions].sort((a, b) => Number(b.id - a.id));
  const pending = sorted.filter(a => a.status === 'pending');
  const recent = sorted.filter(a => a.status !== 'pending').slice(0, 8);
  return (
    <section className="copilot">
      <h2>Copilot <span className="muted">AI agent · acts on urgent events · auto actions can be undone, others need approval</span></h2>
      {actions.length === 0 && <p className="muted">Watching the board. Nothing urgent yet.</p>}
      {pending.map(a => (
        <div key={String(a.id)} className="action pending" title={a.detail}>
          <span>{KIND_ICON[a.kind] ?? '•'}</span>
          <div><b>{a.summary}</b>{a.detail && <div className="muted">{a.detail}</div>}</div>
          <div className="btns">
            <button className="primary" onClick={() => onApprove(a)}>{a.kind === 'ems_destination' ? 'Crew called' : 'Approve'}</button>
            <button onClick={() => onReject(a)}>Reject</button>
          </div>
        </div>
      ))}
      {recent.map(a => (
        <div key={String(a.id)} className={`action ${a.status}`} title={a.detail}>
          <span>{KIND_ICON[a.kind] ?? '•'}</span>
          <div>
            {a.summary}
            {a.detail && a.kind !== 'page' && <span className="muted"> · {a.detail}</span>}
            {a.decidedBy && <span className="muted"> · {a.status} by {a.decidedBy}</span>}
          </div>
          {a.kind === 'hold_bed' && a.status === 'done' && (
            <div className="btns"><button className="ghost" onClick={() => onUndo(a)}>Undo</button></div>
          )}
        </div>
      ))}
    </section>
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
