import { schema, table, t, SenderError, type InferSchema, type ReducerCtx, type ViewCtx } from 'spacetimedb/server';

// ---------- Access model ----------
// - The Python server signs in as the database OWNER (recorded in `config` at publish). Only it
//   can write patient data, vitals, alerts, the forecast and the hospital network.
// - Nurses become STAFF by entering a PIN; the server checks it and calls grantStaff. Only staff
//   can acknowledge alerts and assign / hold / free beds, and only staff can read all patients.
// - A patient's phone sees only its own rows (matched by `phoneId`) through the my_* views.
// Patient tables are private; clients read them through the views below.

// ---------- Tables ----------

// status: 'incoming' (on the way) | 'waiting' (in lobby) | 'roomed' (has a bed) | 'discharged'
//         | 'redirected' (accepted a suggestion to go to another ER)
// risk:   'normal' | 'watch' | 'critical'
const patient = table(
  { name: 'patient' },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string(),
    age: t.u32(),
    complaint: t.string(),   // short chief complaint, e.g. "Chest pain"
    transcript: t.string(),  // what the patient said
    summary: t.string(),     // LLM summary for nurses
    acuity: t.u8(),          // ESI 1 (most urgent) .. 5
    redFlags: t.string(),    // comma separated
    status: t.string(),
    risk: t.string(),
    etaMinutes: t.u32(),
    lat: t.f64(),
    lng: t.f64(),
    bedId: t.option(t.u32()),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    // Appended later; defaults keep existing rows valid.
    source: t.string().default('walk-in'),  // 'walk-in' | 'ems'
    prep: t.string().default(''),           // comma separated things to have ready on arrival
    phoneId: t.string().default(''),        // hex identity of the phone that checked in ('' for demo seeds)
    specialty: t.string().default(''),      // department the patient likely needs (department.name), '' = ED only
    language: t.string().default('en'),     // patient's language: en, es, zh, vi, tl (voice + replies)
    familyToken: t.string().default(''),    // secret for the family status link ('' = not shared)
    advice: t.string().default(''),         // what FrontDoor told the patient (e.g. call 911 + best-equipped ER)
  }
);

const vitals = table(
  { name: 'vitals' },
  {
    id: t.u64().primaryKey().autoInc(),
    patientId: t.u64().index('btree'),
    hr: t.u32(),
    spo2: t.u32(),
    sbp: t.u32(),
    dbp: t.u32(),
    rr: t.u32(),
    tempC: t.f64(),
    recordedAt: t.timestamp(),
  }
);

// level: 'warning' | 'critical'
const alert = table(
  { name: 'alert' },
  {
    id: t.u64().primaryKey().autoInc(),
    patientId: t.u64().index('btree'),
    level: t.string(),
    reason: t.string(),
    createdAt: t.timestamp(),
    ackedBy: t.option(t.string()),
    ackedAt: t.option(t.timestamp()),
  }
);

// Waiting-room voice check-ins ("How are you feeling now?")
const followUp = table(
  { name: 'follow_up' },
  {
    id: t.u64().primaryKey().autoInc(),
    patientId: t.u64().index('btree'),
    question: t.string(),
    answer: t.string(),
    flagged: t.bool(),
    createdAt: t.timestamp(),
  }
);

// status: 'free' | 'reserved' (held for an incoming patient) | 'occupied' | 'cleaning'
const bed = table(
  { name: 'bed', public: true },
  {
    id: t.u32().primaryKey(),
    label: t.string(),
    zone: t.string(),
    status: t.string(),
    patientId: t.option(t.u64()),
  }
);

// Single row (id = 0), written by the forecaster in the Python server.
const forecast = table(
  { name: 'forecast', public: true },
  {
    id: t.u32().primaryKey(),
    horizonMinutes: t.u32(),
    expectedArrivals: t.u32(),
    bedsFree: t.u32(),
    bedsNeeded: t.u32(),
    bedsShort: t.i32(),     // > 0 means short
    basis: t.string(),      // human-readable explanation
    updatedAt: t.timestamp(),
  }
);

// Nearby emergency departments we can suggest when we're full. Written by the Python server
// (capacity is simulated for the demo).
const hospital = table(
  { name: 'hospital', public: true },
  {
    id: t.u32().primaryKey(),
    name: t.string(),
    lat: t.f64(),
    lng: t.f64(),
    bedsFree: t.u32(),
    waitMinutes: t.u32(),
    updatedAt: t.timestamp(),
  }
);

// A suggestion to an incoming walk-in to go to another ER instead.
// status: 'pending' | 'accepted' | 'declined'
const redirectOffer = table(
  { name: 'redirect_offer' },
  {
    id: t.u64().primaryKey().autoInc(),
    patientId: t.u64().index('btree'),
    hospitalId: t.u32(),
    driveMinutes: t.u32(),
    waitMinutes: t.u32(),
    status: t.string(),
    createdAt: t.timestamp(),
    reason: t.string().default(''),  // why this ER: "Cardiology: cath lab ready, 1 on call" etc.
  }
);

// Department readiness at the OTHER nearby ERs, so a patient can be matched to an ER that can
// treat their condition. Bed totals come from CDPH licensing; live status is simulated.
const hospitalDepartment = table(
  { name: 'hospital_department', public: true },
  {
    id: t.u32().primaryKey(),          // hospitalId * 100 + department index
    hospitalId: t.u32().index('btree'),
    name: t.string(),
    bedLabel: t.string(),
    bedsFree: t.u32(),
    bedsTotal: t.u32(),                // 0 = not offered at this hospital
    doctorsOnCall: t.u32(),
    resource: t.string(),
    resourceReady: t.bool(),
    note: t.string(),
    updatedAt: t.timestamp(),
  }
);

// Specialty readiness: does the department this patient needs have a doctor, a bed and its key
// resource right now? No patient data, so it's public. Seeded by the server, updated by staff.
const department = table(
  { name: 'department', public: true },
  {
    id: t.u32().primaryKey(),
    name: t.string(),            // 'Cardiology', 'Neurology', ...
    bedLabel: t.string(),        // 'CCU beds', 'Neuro ICU beds', ...
    bedsFree: t.u32(),
    bedsTotal: t.u32(),          // 0 = service not offered here
    doctorsOnCall: t.u32(),
    resource: t.string(),        // 'Cath lab', 'CT scanner', ...
    resourceReady: t.bool(),
    note: t.string(),
    updatedAt: t.timestamp(),
  }
);

// What the Charge-Nurse Assistant agent did or proposes. Private (mentions patients); staff read it
// through my_agent_actions.
// level: 'auto' (done by the agent, undoable) | 'approval' (waiting for a nurse)
// status: 'done' | 'pending' | 'approved' | 'rejected' | 'undone'
const agentAction = table(
  { name: 'agent_action' },
  {
    id: t.u64().primaryKey().autoInc(),
    patientId: t.u64(),       // 0 = not about one patient
    kind: t.string(),         // hold_bed | page | checklist | prioritize | suggest_bed | suggest_other_er | note
    level: t.string(),
    status: t.string(),
    summary: t.string(),      // one line for the board
    detail: t.string(),       // the agent's reasoning
    bedId: t.u32(),           // 0 = none
    trigger: t.string(),      // what woke the agent
    createdAt: t.timestamp(),
    decidedBy: t.option(t.string()),
  }
);

// Single row (id = 0): who owns the database (the Python server signs in as this identity).
const config = table(
  { name: 'config' },
  {
    id: t.u32().primaryKey(),
    owner: t.identity(),
  }
);

const staff = table(
  { name: 'staff' },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    grantedAt: t.timestamp(),
  }
);

const spacetimedb = schema({
  patient, vitals, alert, followUp, bed, forecast, hospital, redirectOffer, config, staff, department,
  hospitalDepartment, agentAction,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type VCtx = ViewCtx<InferSchema<typeof spacetimedb>>;

// ---------- Helpers ----------

const BEDS: Array<[string, string]> = [
  ['A1', 'Acute'], ['A2', 'Acute'], ['A3', 'Acute'], ['A4', 'Acute'],
  ['B1', 'Fast track'], ['B2', 'Fast track'], ['B3', 'Fast track'],
  ['R1', 'Resus'],
  // Overflow stretchers, used only when no regular bed is free.
  ['H1', 'Hallway'], ['H2', 'Hallway'], ['H3', 'Hallway'],
];
const VITALS_KEEP = 40;

// Beds that start occupied so the demo opens near capacity.
const START_OCCUPIED = new Set(['A1', 'A2', 'A3', 'B1', 'B2', 'R1']);

function seedBeds(ctx: Ctx) {
  BEDS.forEach(([label, zone], i) => {
    ctx.db.bed.insert({
      id: i + 1,
      label,
      zone,
      status: START_OCCUPIED.has(label) ? 'occupied' : 'free',
      patientId: undefined,
    });
  });
}

// Release any bed held (not yet occupied) for this patient.
function releaseHeld(ctx: Ctx, patientId: bigint) {
  for (const b of [...ctx.db.bed.iter()]) {
    if (b.status === 'reserved' && b.patientId === patientId) {
      ctx.db.bed.id.update({ ...b, status: 'free', patientId: undefined });
    }
  }
}

function requireServer(ctx: Ctx) {
  const c = ctx.db.config.id.find(0);
  if (!c || !c.owner.equals(ctx.sender)) throw new SenderError('only the FrontDoor server can do this');
}

function isServer(ctx: Ctx) {
  const c = ctx.db.config.id.find(0);
  return !!c && c.owner.equals(ctx.sender);
}

function requireStaff(ctx: Ctx) {
  const s = ctx.db.staff.identity.find(ctx.sender);
  if (!s) throw new SenderError('staff login required');
  return s;
}

function isStaffView(ctx: VCtx) {
  return !!ctx.db.staff.identity.find(ctx.sender);
}

// Patient ids this viewer may see: all for staff, otherwise only those checked in from this phone.
function visiblePatientIds(ctx: VCtx): Set<bigint> | 'all' {
  if (isStaffView(ctx)) return 'all';
  const me = ctx.sender.toHexString();
  return new Set([...ctx.db.patient.iter()].filter(p => p.phoneId === me).map(p => p.id));
}

function getPatient(ctx: Ctx, id: bigint) {
  const p = ctx.db.patient.id.find(id);
  if (!p) throw new SenderError(`patient ${id} not found`);
  return p;
}

const RISK_ORDER: Record<string, number> = { normal: 0, watch: 1, critical: 2 };

// Risk only escalates, so a later warning never hides an earlier critical.
function raiseRisk(ctx: Ctx, id: bigint, risk: string) {
  const p = getPatient(ctx, id);
  if (RISK_ORDER[risk] > RISK_ORDER[p.risk]) ctx.db.patient.id.update({ ...p, risk, updatedAt: ctx.timestamp });
}

// ---------- Lifecycle ----------

export const init = spacetimedb.init(ctx => {
  ctx.db.config.insert({ id: 0, owner: ctx.sender });
  seedBeds(ctx);
});

// ---------- Views (what each client may read) ----------

export const myPatients = spacetimedb.view(
  { name: 'my_patients', public: true },
  t.array(patient.rowType),
  ctx => {
    const ids = visiblePatientIds(ctx);
    return [...ctx.db.patient.iter()].filter(p => ids === 'all' || ids.has(p.id));
  }
);

export const myVitals = spacetimedb.view(
  { name: 'my_vitals', public: true },
  t.array(vitals.rowType),
  ctx => {
    const ids = visiblePatientIds(ctx);
    return [...ctx.db.vitals.iter()].filter(v => ids === 'all' || ids.has(v.patientId));
  }
);

export const myAlerts = spacetimedb.view(
  { name: 'my_alerts', public: true },
  t.array(alert.rowType),
  ctx => {
    const ids = visiblePatientIds(ctx);
    return [...ctx.db.alert.iter()].filter(a => ids === 'all' || ids.has(a.patientId));
  }
);

export const myOffers = spacetimedb.view(
  { name: 'my_offers', public: true },
  t.array(redirectOffer.rowType),
  ctx => {
    const ids = visiblePatientIds(ctx);
    return [...ctx.db.redirectOffer.iter()].filter(o => ids === 'all' || ids.has(o.patientId));
  }
);

// The caller's own staff record (empty if not logged in as staff).
export const myStaff = spacetimedb.view(
  { name: 'my_staff', public: true },
  t.array(staff.rowType),
  ctx => {
    const s = ctx.db.staff.identity.find(ctx.sender);
    return s ? [s] : [];
  }
);

export const myAgentActions = spacetimedb.view(
  { name: 'my_agent_actions', public: true },
  t.array(agentAction.rowType),
  ctx => (isStaffView(ctx) ? [...ctx.db.agentAction.iter()] : [])
);

// ---------- Assistant agent ----------

export const recordAgentAction = spacetimedb.reducer(
  {
    patientId: t.u64(), kind: t.string(), level: t.string(), status: t.string(),
    summary: t.string(), detail: t.string(), bedId: t.u32(), trigger: t.string(),
  },
  (ctx, args) => {
    requireServer(ctx);
    ctx.db.agentAction.insert({ id: 0n, ...args, createdAt: ctx.timestamp, decidedBy: undefined });
  }
);

// A nurse approves/rejects a proposal or undoes an automatic action. The board performs the
// underlying change (assign bed, free bed, offer ER) with the nurse's own permissions.
export const resolveAgentAction = spacetimedb.reducer(
  { actionId: t.u64(), status: t.string() },
  (ctx, { actionId, status }) => {
    const nurse = requireStaff(ctx);
    if (!['approved', 'rejected', 'undone', 'done'].includes(status)) throw new SenderError('bad status');
    const a = ctx.db.agentAction.id.find(actionId);
    if (!a) throw new SenderError(`action ${actionId} not found`);
    ctx.db.agentAction.id.update({ ...a, status, decidedBy: nurse.name });
  }
);

// ---------- Staff ----------

export const grantStaff = spacetimedb.reducer(
  { identity: t.identity(), name: t.string() },
  (ctx, { identity, name }) => {
    requireServer(ctx);
    const row = { identity, name, grantedAt: ctx.timestamp };
    if (ctx.db.staff.identity.find(identity)) ctx.db.staff.identity.update(row);
    else ctx.db.staff.insert(row);
  }
);

export const staffLogout = spacetimedb.reducer(ctx => {
  if (ctx.db.staff.identity.find(ctx.sender)) ctx.db.staff.identity.delete(ctx.sender);
});

// ---------- Reducers ----------

export const checkIn = spacetimedb.reducer(
  {
    name: t.string(),
    age: t.u32(),
    complaint: t.string(),
    transcript: t.string(),
    summary: t.string(),
    acuity: t.u8(),
    redFlags: t.string(),
    etaMinutes: t.u32(),
    lat: t.f64(),
    lng: t.f64(),
    source: t.string(),
    prep: t.string(),
    phoneId: t.string(),
    specialty: t.string(),
    language: t.string(),
  },
  (ctx, args) => {
    requireServer(ctx);
    const risk = args.acuity <= 2 ? 'watch' : 'normal';
    ctx.db.patient.insert({
      id: 0n,
      ...args,
      status: args.etaMinutes > 0 ? 'incoming' : 'waiting',
      risk,
      bedId: undefined,
      familyToken: '',
      advice: '',
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
  }
);

export const updateLocation = spacetimedb.reducer(
  { patientId: t.u64(), lat: t.f64(), lng: t.f64(), etaMinutes: t.u32() },
  (ctx, { patientId, lat, lng, etaMinutes }) => {
    requireServer(ctx);
    const p = getPatient(ctx, patientId);
    if (p.status !== 'incoming') return;
    ctx.db.patient.id.update({ ...p, lat, lng, etaMinutes, updatedAt: ctx.timestamp });
  }
);

// Hold a free bed for an incoming patient so it's ready when they arrive.
export const holdBed = spacetimedb.reducer(
  { bedId: t.u32(), patientId: t.u64() },
  (ctx, { bedId, patientId }) => {
    if (!isServer(ctx)) requireStaff(ctx);  // the Assistant agent (server) may hold beds too
    const b = ctx.db.bed.id.find(bedId);
    if (!b) throw new SenderError(`bed ${bedId} not found`);
    if (b.status !== 'free') throw new SenderError(`bed ${b.label} is ${b.status}`);
    getPatient(ctx, patientId);
    releaseHeld(ctx, patientId);
    ctx.db.bed.id.update({ ...b, status: 'reserved', patientId });
  }
);

export const setHospitalDepartment = spacetimedb.reducer(
  {
    id: t.u32(), hospitalId: t.u32(), name: t.string(), bedLabel: t.string(), bedsFree: t.u32(), bedsTotal: t.u32(),
    doctorsOnCall: t.u32(), resource: t.string(), resourceReady: t.bool(), note: t.string(),
  },
  (ctx, args) => {
    requireServer(ctx);
    const row = { ...args, updatedAt: ctx.timestamp };
    if (ctx.db.hospitalDepartment.id.find(args.id)) ctx.db.hospitalDepartment.id.update(row);
    else ctx.db.hospitalDepartment.insert(row);
  }
);

// What FrontDoor told the patient at check-in (e.g. "Call 911 now. Best-equipped ER: ...").
export const setAdvice = spacetimedb.reducer(
  { patientId: t.u64(), advice: t.string() },
  (ctx, { patientId, advice }) => {
    requireServer(ctx);
    const p = getPatient(ctx, patientId);
    ctx.db.patient.id.update({ ...p, advice, updatedAt: ctx.timestamp });
  }
);

// The patient chose to share a status link with family; the server generated the secret token.
export const setFamilyToken = spacetimedb.reducer(
  { patientId: t.u64(), token: t.string() },
  (ctx, { patientId, token }) => {
    requireServer(ctx);
    const p = getPatient(ctx, patientId);
    ctx.db.patient.id.update({ ...p, familyToken: token, updatedAt: ctx.timestamp });
  }
);

export const markArrived = spacetimedb.reducer({ patientId: t.u64() }, (ctx, { patientId }) => {
  requireServer(ctx);
  const p = getPatient(ctx, patientId);
  if (p.status === 'incoming') {
    ctx.db.patient.id.update({ ...p, status: 'waiting', etaMinutes: 0, updatedAt: ctx.timestamp });
  }
});

export const addVitals = spacetimedb.reducer(
  {
    patientId: t.u64(),
    hr: t.u32(),
    spo2: t.u32(),
    sbp: t.u32(),
    dbp: t.u32(),
    rr: t.u32(),
    tempC: t.f64(),
  },
  (ctx, args) => {
    requireServer(ctx);
    getPatient(ctx, args.patientId);
    ctx.db.vitals.insert({ id: 0n, ...args, recordedAt: ctx.timestamp });
    // Keep only the most recent readings per patient so the table stays small.
    const rows = [...ctx.db.vitals.patientId.filter(args.patientId)];
    if (rows.length > VITALS_KEEP) {
      rows.sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const r of rows.slice(0, rows.length - VITALS_KEEP)) ctx.db.vitals.id.delete(r.id);
    }
  }
);

export const addFollowUp = spacetimedb.reducer(
  { patientId: t.u64(), question: t.string(), answer: t.string(), flagged: t.bool() },
  (ctx, args) => {
    requireServer(ctx);
    getPatient(ctx, args.patientId);
    ctx.db.followUp.insert({ id: 0n, ...args, createdAt: ctx.timestamp });
  }
);

export const raiseAlert = spacetimedb.reducer(
  { patientId: t.u64(), level: t.string(), reason: t.string() },
  (ctx, { patientId, level, reason }) => {
    requireServer(ctx);
    getPatient(ctx, patientId);
    // Don't stack duplicates: skip if an open alert of the same level already exists.
    const open = [...ctx.db.alert.patientId.filter(patientId)].find(
      a => a.ackedAt === undefined && a.level === level
    );
    if (open) return;
    ctx.db.alert.insert({
      id: 0n,
      patientId,
      level,
      reason,
      createdAt: ctx.timestamp,
      ackedBy: undefined,
      ackedAt: undefined,
    });
    raiseRisk(ctx, patientId, level === 'critical' ? 'critical' : 'watch');
  }
);

// The responder's name comes from their staff record, so "who's on it" can't be faked.
export const ackAlert = spacetimedb.reducer({ alertId: t.u64() }, (ctx, { alertId }) => {
  const nurse = requireStaff(ctx);
  const a = ctx.db.alert.id.find(alertId);
  if (!a) throw new SenderError(`alert ${alertId} not found`);
  if (a.ackedAt !== undefined) return;
  ctx.db.alert.id.update({ ...a, ackedBy: nurse.name, ackedAt: ctx.timestamp });
});

export const assignBed = spacetimedb.reducer(
  { bedId: t.u32(), patientId: t.u64() },
  (ctx, { bedId, patientId }) => {
    requireStaff(ctx);
    const b = ctx.db.bed.id.find(bedId);
    if (!b) throw new SenderError(`bed ${bedId} not found`);
    const heldForThem = b.status === 'reserved' && b.patientId === patientId;
    if (b.status !== 'free' && !heldForThem) throw new SenderError(`bed ${b.label} is ${b.status}`);
    const p = getPatient(ctx, patientId);
    if (!heldForThem) releaseHeld(ctx, patientId);
    // Free the patient's previous bed, if any.
    if (p.bedId !== undefined) {
      const prev = ctx.db.bed.id.find(p.bedId);
      if (prev) ctx.db.bed.id.update({ ...prev, status: 'cleaning', patientId: undefined });
    }
    ctx.db.bed.id.update({ ...b, status: 'occupied', patientId });
    ctx.db.patient.id.update({ ...p, status: 'roomed', bedId, etaMinutes: 0, updatedAt: ctx.timestamp });
  }
);

// Frees a bed. Reserved -> free (hold released), occupied -> cleaning (patient discharged), cleaning -> free.
export const freeBed = spacetimedb.reducer({ bedId: t.u32() }, (ctx, { bedId }) => {
  requireStaff(ctx);
  const b = ctx.db.bed.id.find(bedId);
  if (!b) throw new SenderError(`bed ${bedId} not found`);
  if (b.status === 'reserved') {
    ctx.db.bed.id.update({ ...b, status: 'free', patientId: undefined });
    return;
  }
  if (b.patientId !== undefined) {
    const p = ctx.db.patient.id.find(b.patientId);
    if (p) ctx.db.patient.id.update({ ...p, status: 'discharged', bedId: undefined, updatedAt: ctx.timestamp });
  }
  ctx.db.bed.id.update({ ...b, status: b.status === 'occupied' ? 'cleaning' : 'free', patientId: undefined });
});

export const setForecast = spacetimedb.reducer(
  {
    horizonMinutes: t.u32(),
    expectedArrivals: t.u32(),
    bedsFree: t.u32(),
    bedsNeeded: t.u32(),
    bedsShort: t.i32(),
    basis: t.string(),
  },
  (ctx, args) => {
    requireServer(ctx);
    const row = { id: 0, ...args, updatedAt: ctx.timestamp };
    if (ctx.db.forecast.id.find(0)) ctx.db.forecast.id.update(row);
    else ctx.db.forecast.insert(row);
  }
);

export const setHospital = spacetimedb.reducer(
  { id: t.u32(), name: t.string(), lat: t.f64(), lng: t.f64(), bedsFree: t.u32(), waitMinutes: t.u32() },
  (ctx, args) => {
    requireServer(ctx);
    const row = { ...args, updatedAt: ctx.timestamp };
    if (ctx.db.hospital.id.find(args.id)) ctx.db.hospital.id.update(row);
    else ctx.db.hospital.insert(row);
  }
);

// Only stable walk-ins who haven't arrived can be offered another ER. Once someone is at our
// door we must see them (EMTALA), and ambulance diversion is a hospital-level decision.
export const offerRedirect = spacetimedb.reducer(
  { patientId: t.u64(), hospitalId: t.u32(), driveMinutes: t.u32(), waitMinutes: t.u32(), reason: t.string() },
  (ctx, { patientId, hospitalId, driveMinutes, waitMinutes, reason }) => {
    requireServer(ctx);
    const p = getPatient(ctx, patientId);
    if (p.status !== 'incoming') throw new SenderError('only patients still on the way can be redirected');
    if (p.source !== 'walk-in') throw new SenderError('ambulance patients are never redirected by FrontDoor');
    if (p.acuity <= 2 || p.risk === 'critical') throw new SenderError('ESI 1-2 / critical patients are never redirected');
    if (!ctx.db.hospital.id.find(hospitalId)) throw new SenderError(`hospital ${hospitalId} not found`);
    const pending = [...ctx.db.redirectOffer.patientId.filter(patientId)].find(o => o.status === 'pending');
    if (pending) ctx.db.redirectOffer.id.update({ ...pending, status: 'declined' });
    ctx.db.redirectOffer.insert({
      id: 0n, patientId, hospitalId, driveMinutes, waitMinutes, status: 'pending', createdAt: ctx.timestamp, reason,
    });
  }
);

export const respondRedirect = spacetimedb.reducer(
  { offerId: t.u64(), accept: t.bool() },
  (ctx, { offerId, accept }) => {
    const o = ctx.db.redirectOffer.id.find(offerId);
    if (!o) throw new SenderError(`offer ${offerId} not found`);
    const owner = getPatient(ctx, o.patientId);
    if (owner.phoneId !== ctx.sender.toHexString()) throw new SenderError('only the patient can answer this offer');
    if (o.status !== 'pending') return;
    ctx.db.redirectOffer.id.update({ ...o, status: accept ? 'accepted' : 'declined' });
    if (!accept) return;
    const p = getPatient(ctx, o.patientId);
    releaseHeld(ctx, p.id);
    ctx.db.patient.id.update({ ...p, status: 'redirected', etaMinutes: 0, updatedAt: ctx.timestamp });
  }
);

export const setDepartment = spacetimedb.reducer(
  {
    id: t.u32(), name: t.string(), bedLabel: t.string(), bedsFree: t.u32(), bedsTotal: t.u32(),
    doctorsOnCall: t.u32(), resource: t.string(), resourceReady: t.bool(), note: t.string(),
  },
  (ctx, args) => {
    requireServer(ctx);
    const row = { ...args, updatedAt: ctx.timestamp };
    if (ctx.db.department.id.find(args.id)) ctx.db.department.id.update(row);
    else ctx.db.department.insert(row);
  }
);

// Staff update a department's live status from the board (e.g. "cath lab busy", "1 CCU bed left").
export const updateDepartment = spacetimedb.reducer(
  { id: t.u32(), bedsFree: t.u32(), doctorsOnCall: t.u32(), resourceReady: t.bool() },
  (ctx, { id, bedsFree, doctorsOnCall, resourceReady }) => {
    requireStaff(ctx);
    const d = ctx.db.department.id.find(id);
    if (!d) throw new SenderError(`department ${id} not found`);
    ctx.db.department.id.update({
      ...d, bedsFree: Math.min(bedsFree, d.bedsTotal), doctorsOnCall, resourceReady, updatedAt: ctx.timestamp,
    });
  }
);

// Staff logins survive a reset so nurses stay signed in between demo runs.
export const resetDemo = spacetimedb.reducer(ctx => {
  requireServer(ctx);
  for (const r of [...ctx.db.vitals.iter()]) ctx.db.vitals.id.delete(r.id);
  for (const r of [...ctx.db.alert.iter()]) ctx.db.alert.id.delete(r.id);
  for (const r of [...ctx.db.followUp.iter()]) ctx.db.followUp.id.delete(r.id);
  for (const r of [...ctx.db.patient.iter()]) ctx.db.patient.id.delete(r.id);
  for (const r of [...ctx.db.bed.iter()]) ctx.db.bed.id.delete(r.id);
  for (const r of [...ctx.db.forecast.iter()]) ctx.db.forecast.id.delete(r.id);
  for (const r of [...ctx.db.redirectOffer.iter()]) ctx.db.redirectOffer.id.delete(r.id);
  for (const r of [...ctx.db.agentAction.iter()]) ctx.db.agentAction.id.delete(r.id);
  seedBeds(ctx);
});
