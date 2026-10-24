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

export type FollowUpResult = {
  level: 'none' | 'warning' | 'critical';
  reason: string;
  spoken_reply: string;
  heard: boolean;
};

export const api = {
  async transcribe(audio: Blob): Promise<string> {
    const form = new FormData();
    form.append('file', audio, audio.type.includes('mp4') ? 'audio.mp4' : 'audio.webm');
    const r = await fetch(`${API_URL}/transcribe`, { method: 'POST', body: form });
    if (!r.ok) throw new Error(`transcribe failed: ${r.status}`);
    return (await r.json()).text;
  },

  async speak(text: string): Promise<void> {
    const r = await fetch(`${API_URL}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
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

  checkIn: (b: { name: string; age: number; transcript: string; etaMinutes: number }) =>
    post<TriageResult>('/checkin', b),

  async followUpQuestion(patientId: number): Promise<string> {
    const r = await fetch(`${API_URL}/followup/question/${patientId}`);
    return (await r.json()).question;
  },

  followUp: (b: { patientId: number; question: string; answer: string }) => post<FollowUpResult>('/followup', b),

  location: (b: { patientId: number; lat: number; lng: number }) =>
    post<{ arrived: boolean; etaMinutes: number }>('/location', b),
  suggestRedirect: (patientId: number) => post('/redirect/suggest', { patientId }),
  drive: (patientId: number) => post('/demo/drive', { patientId }),
  worsen: (patientId: number) => post('/demo/worsen', { patientId }),
  arrive: (patientId: number) => post('/demo/arrive', { patientId }),
  reset: () => post('/demo/reset'),
};
