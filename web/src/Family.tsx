import { useEffect, useState } from 'react';
import { api, type FamilyStatus } from './api';

const POLL_MS = 5000;

// What a family member sees from the shared link: status only, never symptoms or vitals.
export default function Family({ token }: { token: string }) {
  const [s, setS] = useState<FamilyStatus | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.familyStatus(token)
        .then(r => alive && (setS(r), setError('')))
        .catch(e => alive && setError(String(e.message ?? e)));
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [token]);

  if (error && !s) return <div className="phone"><h1 className="brand">FrontDoor</h1><p className="error">{error}</p></div>;
  if (!s) return <div className="phone"><h1 className="brand">FrontDoor</h1><p className="muted">Loading…</p></div>;

  const atEr = ['waiting', 'roomed', 'discharged'].includes(s.status);
  const steps = [
    { label: `${s.firstName} checked in with ${s.hospital}`, done: true },
    { label: s.status === 'incoming' ? `On the way · about ${s.etaMinutes} min` : 'Arrived at the ER', done: atEr },
    { label: s.responder ? `${s.responder} is with ${s.firstName}` : 'Waiting for a nurse', done: !!s.responder },
    { label: s.bed ? `In bed ${s.bed.label} (${s.bed.zone})` : 'Waiting for a bed', done: !!s.bed || s.status === 'discharged' },
    { label: 'Visit complete', done: s.status === 'discharged' },
  ];

  return (
    <div className="phone family">
      <h1 className="brand">FrontDoor</h1>
      <p className="muted">Live updates for {s.firstName}'s family</p>
      {s.status === 'redirected' ? (
        <div className="card status go">
          <div className="muted">Change of plan</div>
          <div className="big">{s.firstName} is heading to {s.redirectedTo ?? 'another ER'}</div>
          <p>They chose a nearby ER that can see them sooner.</p>
        </div>
      ) : (
        <ul className="timeline">
          {steps.map(step => <li key={step.label} className={step.done ? 'done' : ''}>{step.label}</li>)}
        </ul>
      )}
      <p className="fine">
        Updated {new Date(s.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
        Shared by {s.firstName}. Medical details stay private.
      </p>
    </div>
  );
}
