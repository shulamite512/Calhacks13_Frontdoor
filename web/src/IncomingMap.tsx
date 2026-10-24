import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Patient } from './module_bindings/types';
import { HOSPITAL } from './config';

const COLORS: Record<string, string> = { critical: '#c62828', watch: '#c77700', normal: '#1f8a4c' };

function color(p: Patient) {
  return p.risk === 'critical' || p.acuity <= 2 ? COLORS.critical : COLORS[p.risk] ?? COLORS.normal;
}

// Live map of everyone on the way to the ER: walk-ins (circles) and ambulances (squares).
export default function IncomingMap({ patients }: { patients: Patient[] }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef(new Map<bigint, L.Marker>());
  const count = useRef(-1);

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: false, attributionControl: true }).setView(
      [HOSPITAL.lat, HOSPITAL.lng], 14
    );
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(m);
    L.marker([HOSPITAL.lat, HOSPITAL.lng], {
      icon: L.divIcon({ className: 'map-er', html: 'ER', iconSize: [34, 34] }),
    })
      .addTo(m)
      .bindTooltip(HOSPITAL.name, { direction: 'top', offset: [0, -14] });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      markers.current.clear();
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<bigint>();
    for (const p of patients) {
      seen.add(p.id);
      const ems = p.source === 'ems';
      const label = `${ems ? '🚑 ' : ''}${p.name.split(':')[0]} · ${p.etaMinutes}m`;
      const icon = L.divIcon({
        className: '',
        html: `<div class="map-dot ${ems ? 'ems' : ''}" style="background:${color(p)}"></div>`,
        iconSize: [18, 18],
      });
      let mk = markers.current.get(p.id);
      if (!mk) {
        mk = L.marker([p.lat, p.lng], { icon }).addTo(m);
        mk.bindTooltip(label, { permanent: true, direction: 'right', offset: [10, 0], className: 'map-label' });
        markers.current.set(p.id, mk);
      } else {
        mk.setLatLng([p.lat, p.lng]);
        mk.setIcon(icon);
        mk.setTooltipContent(label);
      }
    }
    for (const [id, mk] of markers.current) {
      if (!seen.has(id)) {
        mk.remove();
        markers.current.delete(id);
      }
    }
    // Re-frame only when someone joins or leaves, so the map doesn't jump on every move.
    if (patients.length !== count.current) {
      count.current = patients.length;
      const pts: L.LatLngExpression[] = [[HOSPITAL.lat, HOSPITAL.lng], ...patients.map(p => [p.lat, p.lng] as [number, number])];
      if (pts.length > 1) m.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 15 });
    }
  }, [patients]);

  return <div ref={el} className="map" />;
}
