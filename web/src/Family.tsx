import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api, type FamilyStatus } from './api';

const POLL_MS = 5000;

// Live position while the patient is on the way (they chose to share; hidden once they arrive).
function FamilyMap({ me, dest, name, eta }: {
  me: { lat: number; lng: number }; dest: { name: string; lat: number; lng: number }; name: string; eta: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const pin = useRef<L.Marker | null>(null);
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(m);
    L.marker([dest.lat, dest.lng], { icon: L.divIcon({ className: 'map-er', html: 'ER', iconSize: [30, 30] }) })
      .addTo(m).bindTooltip(dest.name, { direction: 'top' });
    m.fitBounds(L.latLngBounds([[me.lat, me.lng], [dest.lat, dest.lng]]), { padding: [30, 30], maxZoom: 15 });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      pin.current = null;
    };
    // Build the map once per destination; the pin effect below follows the car.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dest.lat, dest.lng, dest.name]);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const label = `${name} · ${eta} min away`;
    const icon = L.divIcon({ className: '', html: '<div class="map-dot" style="background:#0b6e6e"></div>', iconSize: [18, 18] });
    if (!pin.current) {
      pin.current = L.marker([me.lat, me.lng], { icon }).addTo(m);
      pin.current.bindTooltip(label, { permanent: true, direction: 'right', offset: [10, 0], className: 'map-label' });
    } else {
      pin.current.setLatLng([me.lat, me.lng]);
      pin.current.setTooltipContent(label);
    }
  }, [me.lat, me.lng, name, eta]);
  return <div ref={el} className="map family-map" />;
}

// What a family member sees from the shared link: status and, while driving, location; never symptoms or vitals.
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

  if (error && !s) return <div className="phone"><h1 className="brand">Siren</h1><p className="error">{error}</p></div>;
  if (!s) return <div className="phone"><h1 className="brand">Siren</h1><p className="muted">Loading…</p></div>;

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
      <h1 className="brand">Siren</h1>
      <p className="muted">Live updates for {s.firstName}'s family</p>
      {s.status === 'redirected' ? (
        <div className="card status go">
          <div className="muted">Change of plan</div>
          <div className="big">{s.firstName} is heading to {s.redirectedTo ?? 'another ER'}</div>
          <p>They chose a nearby ER that can see them sooner.</p>
        </div>
      ) : (
        <>
        {s.location && <FamilyMap me={s.location} dest={s.destination} name={s.firstName} eta={s.etaMinutes} />}
        <ul className="timeline">
          {steps.map(step => <li key={step.label} className={step.done ? 'done' : ''}>{step.label}</li>)}
        </ul>
        </>
      )}
      <p className="fine">
        Updated {new Date(s.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
        Shared by {s.firstName}. Medical details stay private.
      </p>
    </div>
  );
}
