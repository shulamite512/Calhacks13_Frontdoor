export const API_URL = import.meta.env.VITE_API_URL ?? '/api'; // proxied to the Python server (vite.config.ts)
export const STDB_URI = import.meta.env.VITE_STDB_URI ?? 'wss://maincloud.spacetimedb.com';
export const HOSPITAL = { name: 'CPMC Van Ness Campus ED', lat: 37.78616, lng: -122.42285 }; // ER entrance
export const STDB_DB = import.meta.env.VITE_STDB_DB ?? 'frontdoor-w3zl2';
