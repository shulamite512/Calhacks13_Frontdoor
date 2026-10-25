import { API_URL } from './config';

async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

export type TriageResult = {
  patientId: number | null;
  complaint: string;
  summary: string;
  acuity: number;
  red_flags: string[];
  spoken_reply: string;
};

export type Nearby = {
  inServiceArea: boolean;
  kmToOurEr: number;
  demoLocation: { lat: number; lng: number; label: string };
  ers: Array<{ name: string; driveMinutes: number; waitMinutes: number; km: number; open: boolean }>;
};

export type FamilyStatus = {
  firstName: string;
  hospital: string;
  status: string;
  etaMinutes: number;
  bed: { label: string; zone: string } | null;
  responder: string | null;
  redirectedTo: string | null;
  checkedInAt: number;
  updatedAt: number;
};

export type FollowUpResult = {
  level: 'none' | 'warning' | 'critical';
  reason: string;
  spoken_reply: string;
  heard: boolean;
};

// The staff PIN is kept for this browser tab only, for board actions that go through the server.
const PIN_KEY = 'frontdoor_staff_pin';
export function staffPin(): string {
  try {
    return sessionStorage.getItem(PIN_KEY) ?? '';
  } catch {
    return '';
  }
}
function rememberPin(pin: string) {
  try {
    sessionStorage.setItem(PIN_KEY, pin);
  } catch {
    /* storage unavailable */
  }
}

export const api = {
  async transcribe(audio: Blob, language = 'en'): Promise<string> {
    const form = new FormData();
    form.append('file', audio, audio.type.includes('mp4') ? 'audio.mp4' : 'audio.webm');
    form.append('language', language);
    const r = await fetch(`${API_URL}/transcribe`, { method: 'POST', body: form });
    if (!r.ok) throw new Error(`transcribe failed: ${r.status}`);
    return (await r.json()).text;
  },

  async speak(text: string, language = 'en'): Promise<void> {
    const r = await fetch(`${API_URL}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language }),
    });
    if (!r.ok) throw new Error(`speak failed: ${r.status}`);
    const url = URL.createObjectURL(await r.blob());
    const audio = new Audio(url);
    await new Promise<void>(resolve => {
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      audio.play().catch(() => resolve());
    });
    URL.revokeObjectURL(url);
  },

  checkIn: (b: { name: string; age: number; transcript: string; lat: number; lng: number; phoneId: string; language: string }) =>
    post<TriageResult>('/checkin', b),

  async staffLogin(b: { pin: string; identity: string; name: string }) {
    await post('/staff/login', b);
    rememberPin(b.pin);
  },

  async followUpQuestion(patientId: number): Promise<string> {
    const r = await fetch(`${API_URL}/followup/question/${patientId}`);
    return (await r.json()).question;
  },

  followUp: (b: { patientId: number; question: string; answer: string }) => post<FollowUpResult>('/followup', b),

  missedCheckins: (patientId: number, count: number) => post('/followup/missed', { patientId, count }),

  async nearby(lat: number, lng: number): Promise<Nearby> {
    const r = await fetch(`${API_URL}/nearby?lat=${lat}&lng=${lng}`);
    if (!r.ok) throw new Error(`nearby failed: ${r.status}`);
    return r.json();
  },

  familyShare: (b: { patientId: number; phoneId: string }) => post<{ token: string }>('/family/share', b),

  async familyStatus(token: string): Promise<FamilyStatus> {
    const r = await fetch(`${API_URL}/family/${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error(r.status === 404 ? 'This link is not valid.' : `status failed: ${r.status}`);
    return r.json();
  },

  location: (b: { patientId: number; lat: number; lng: number }) =>
    post<{ arrived: boolean; etaMinutes: number }>('/location', b),
  suggestRedirect: (patientId: number) => post('/redirect/suggest', { patientId, pin: staffPin() }),
  drive: (patientId: number) => post('/demo/drive', { patientId }),
  worsen: (patientId: number) => post('/demo/worsen', { patientId, pin: staffPin() }),
  arrive: (patientId: number) => post('/demo/arrive', { patientId }),
  reset: () => post('/demo/reset', { pin: staffPin() }),
};
