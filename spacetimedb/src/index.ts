import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';

// ---------- Tables ----------

// status: 'incoming' (on the way) | 'waiting' (in lobby) | 'roomed' (has a bed) | 'discharged'
// risk:   'normal' | 'watch' | 'critical'
const patient = table(
  { name: 'patient', public: true },
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
  }
);

const vitals = table(
  { name: 'vitals', public: true },
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
  { name: 'alert', public: true },
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
  { name: 'follow_up', public: true },
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

const spacetimedb = schema({ patient, vitals, alert, followUp, bed, forecast });
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

// ---------- Helpers ----------

const BEDS: Array<[string, string]> = [
  ['A1', 'Acute'], ['A2', 'Acute'], ['A3', 'Acute'], ['A4', 'Acute'],
  ['B1', 'Fast track'], ['B2', 'Fast track'], ['B3', 'Fast track'],
  ['R1', 'Resus'],
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
  seedBeds(ctx);
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
  },
  (ctx, args) => {
    const risk = args.acuity <= 2 ? 'watch' : 'normal';
    ctx.db.patient.insert({
      id: 0n,
      ...args,
      status: args.etaMinutes > 0 ? 'incoming' : 'waiting',
      risk,
      bedId: undefined,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
  }
);

export const updateLocation = spacetimedb.reducer(
  { patientId: t.u64(), lat: t.f64(), lng: t.f64(), etaMinutes: t.u32() },
  (ctx, { patientId, lat, lng, etaMinutes }) => {
    const p = getPatient(ctx, patientId);
    if (p.status !== 'incoming') return;
    ctx.db.patient.id.update({ ...p, lat, lng, etaMinutes, updatedAt: ctx.timestamp });
  }
);

// Hold a free bed for an incoming patient so it's ready when they arrive.
export const holdBed = spacetimedb.reducer(
  { bedId: t.u32(), patientId: t.u64() },
  (ctx, { bedId, patientId }) => {
    const b = ctx.db.bed.id.find(bedId);
    if (!b) throw new SenderError(`bed ${bedId} not found`);
    if (b.status !== 'free') throw new SenderError(`bed ${b.label} is ${b.status}`);
    getPatient(ctx, patientId);
    releaseHeld(ctx, patientId);
    ctx.db.bed.id.update({ ...b, status: 'reserved', patientId });
  }
);

export const markArrived = spacetimedb.reducer({ patientId: t.u64() }, (ctx, { patientId }) => {
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
    getPatient(ctx, args.patientId);
    ctx.db.followUp.insert({ id: 0n, ...args, createdAt: ctx.timestamp });
  }
);

export const raiseAlert = spacetimedb.reducer(
  { patientId: t.u64(), level: t.string(), reason: t.string() },
  (ctx, { patientId, level, reason }) => {
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

export const ackAlert = spacetimedb.reducer(
  { alertId: t.u64(), nurse: t.string() },
  (ctx, { alertId, nurse }) => {
    const a = ctx.db.alert.id.find(alertId);
    if (!a) throw new SenderError(`alert ${alertId} not found`);
    if (a.ackedAt !== undefined) return;
    ctx.db.alert.id.update({ ...a, ackedBy: nurse, ackedAt: ctx.timestamp });
  }
);

export const assignBed = spacetimedb.reducer(
  { bedId: t.u32(), patientId: t.u64() },
  (ctx, { bedId, patientId }) => {
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
    const row = { id: 0, ...args, updatedAt: ctx.timestamp };
    if (ctx.db.forecast.id.find(0)) ctx.db.forecast.id.update(row);
    else ctx.db.forecast.insert(row);
  }
);

export const resetDemo = spacetimedb.reducer(ctx => {
  for (const r of [...ctx.db.vitals.iter()]) ctx.db.vitals.id.delete(r.id);
  for (const r of [...ctx.db.alert.iter()]) ctx.db.alert.id.delete(r.id);
  for (const r of [...ctx.db.followUp.iter()]) ctx.db.followUp.id.delete(r.id);
  for (const r of [...ctx.db.patient.iter()]) ctx.db.patient.id.delete(r.id);
  for (const r of [...ctx.db.bed.iter()]) ctx.db.bed.id.delete(r.id);
  for (const r of [...ctx.db.forecast.iter()]) ctx.db.forecast.id.delete(r.id);
  seedBeds(ctx);
});
