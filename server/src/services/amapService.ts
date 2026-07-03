import { gcj02ToWgs84, wgs84ToGcj02 } from '@trek/shared';

// ── Amap (高德) place provider ────────────────────────────────────────────────
// Active when AMAP_API_KEY is set (instance-wide China mode). Amap returns
// GCJ-02 coordinates; everything leaving this module is converted to WGS-84 so
// the rest of TREK keeps a single storage coordinate system.
// Place ids are namespaced as `amap:<poi id>` and ride in the osm_id field —
// mapsService intercepts the prefix before the OSM branch.
// ponytail: instance-wide env key, per-user keys (like Google) if ever needed.

const AMAP_BASE = 'https://restapi.amap.com';

export function getAmapKey(): string | null {
  return process.env.AMAP_API_KEY?.trim() || null;
}

interface AmapPoi {
  id: string;
  name: string;
  location?: string; // "lng,lat" (GCJ-02)
  pname?: string;
  cityname?: string;
  adname?: string;
  address?: string;
  type?: string;
  business?: {
    tel?: string;
    rating?: string;
    opentime_week?: string;
  };
}

interface AmapTip {
  id?: string | unknown[];
  name?: string;
  district?: string;
  address?: string | unknown[];
}

function parseLocation(location?: string): { lat: number | null; lng: number | null } {
  const [lngStr, latStr] = (location || '').split(',');
  const lng = parseFloat(lngStr);
  const lat = parseFloat(latStr);
  if (!isFinite(lat) || !isFinite(lng)) return { lat: null, lng: null };
  return gcj02ToWgs84(lat, lng);
}

function fullAddress(p: AmapPoi): string {
  // Amap's `address` is street-level only; prepend province/city/district.
  const parts = [p.pname, p.cityname, p.adname, typeof p.address === 'string' ? p.address : ''];
  return [...new Set(parts.filter(Boolean))].join('');
}

async function amapFetch(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const key = getAmapKey();
  if (!key) throw Object.assign(new Error('Amap API key not configured'), { status: 400 });
  const qs = new URLSearchParams({ ...params, key });
  const res = await fetch(`${AMAP_BASE}${path}?${qs}`);
  const data = await res.json() as Record<string, unknown> & { status?: string; info?: string };
  if (!res.ok || data.status !== '1') {
    const err = new Error(`Amap API error: ${data.info || res.statusText}`) as Error & { status: number };
    err.status = res.ok ? 502 : res.status;
    throw err;
  }
  return data;
}

function poiToPlace(p: AmapPoi): Record<string, unknown> {
  const { lat, lng } = parseLocation(p.location);
  const rating = parseFloat(p.business?.rating || '');
  return {
    google_place_id: null,
    google_ftid: null,
    osm_id: `amap:${p.id}`,
    name: p.name || '',
    address: fullAddress(p),
    lat,
    lng,
    rating: isFinite(rating) ? rating : null,
    website: null,
    phone: (typeof p.business?.tel === 'string' && p.business.tel) || null,
    types: p.type ? p.type.split(';') : [],
    source: 'amap',
  };
}

// ── Text search (v5 place/text) ──────────────────────────────────────────────

export async function searchAmapPlaces(
  query: string,
  locationBias?: { lat: number; lng: number },
): Promise<Record<string, unknown>[]> {
  const params: Record<string, string> = {
    keywords: query,
    page_size: '10',
    show_fields: 'business',
  };
  if (locationBias) {
    const g = wgs84ToGcj02(locationBias.lat, locationBias.lng);
    params.location = `${g.lng.toFixed(6)},${g.lat.toFixed(6)}`;
  }
  const data = await amapFetch('/v5/place/text', params);
  return ((data.pois as AmapPoi[]) || []).map(poiToPlace);
}

// ── Autocomplete (v3 assistant/inputtips) ────────────────────────────────────

export async function autocompleteAmap(
  input: string,
  locationBias?: { low: { lat: number; lng: number }; high: { lat: number; lng: number } },
): Promise<{ suggestions: { placeId: string; mainText: string; secondaryText: string }[]; source: string }> {
  const params: Record<string, string> = { keywords: input, datatype: 'poi' };
  if (locationBias) {
    const center = wgs84ToGcj02(
      (locationBias.low.lat + locationBias.high.lat) / 2,
      (locationBias.low.lng + locationBias.high.lng) / 2,
    );
    params.location = `${center.lng.toFixed(6)},${center.lat.toFixed(6)}`;
  }
  const data = await amapFetch('/v3/assistant/inputtips', params);
  const suggestions = ((data.tips as AmapTip[]) || [])
    // Tips without a POI id (bare keywords/districts) have id as an empty array.
    .filter((t): t is AmapTip & { id: string; name: string } => typeof t.id === 'string' && !!t.id && !!t.name)
    .slice(0, 5)
    .map(t => ({
      placeId: `amap:${t.id}`,
      mainText: t.name,
      secondaryText: [t.district, typeof t.address === 'string' ? t.address : ''].filter(Boolean).join(' '),
    }));
  return { suggestions, source: 'amap' };
}

// ── Place details (v5 place/detail) ──────────────────────────────────────────

export async function getAmapPlaceDetails(amapId: string): Promise<Record<string, unknown>> {
  const data = await amapFetch('/v5/place/detail', { id: amapId, show_fields: 'business' });
  const poi = ((data.pois as AmapPoi[]) || [])[0];
  if (!poi) throw Object.assign(new Error('Amap place not found'), { status: 404 });
  return {
    ...poiToPlace(poi),
    rating_count: null,
    opening_hours: poi.business?.opentime_week ? [poi.business.opentime_week] : null,
    open_now: null,
    google_maps_url: null,
    summary: null,
    reviews: [],
    cached_at: Date.now(),
  };
}

// ── Route planning (v3 direction) ────────────────────────────────────────────
// One Amap call per consecutive waypoint pair (walking/bicycling don't support
// vias), sequential to respect personal-tier QPS. Output mirrors what the
// client builds from OSRM: WGS-84 [lat,lng] geometry + per-leg distance/duration.

export interface AmapRouteResult {
  coordinates: [number, number][];
  distance: number;
  duration: number;
  legs: { distance: number; duration: number }[];
}

interface AmapPath {
  distance?: string | number;
  duration?: string | number;
  cost?: { duration?: string | number };
  steps?: { polyline?: string }[];
}

function parsePolyline(steps: { polyline?: string }[] | undefined): [number, number][] {
  const out: [number, number][] = [];
  for (const step of steps || []) {
    for (const pair of (step.polyline || '').split(';')) {
      const [lngStr, latStr] = pair.split(',');
      const lng = parseFloat(lngStr);
      const lat = parseFloat(latStr);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      const w = gcj02ToWgs84(lat, lng);
      out.push([w.lat, w.lng]);
    }
  }
  return out;
}

async function amapDirectionLeg(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  profile: 'driving' | 'walking' | 'cycling',
): Promise<{ coordinates: [number, number][]; distance: number; duration: number }> {
  const a = wgs84ToGcj02(from.lat, from.lng);
  const b = wgs84ToGcj02(to.lat, to.lng);
  const origin = `${a.lng.toFixed(6)},${a.lat.toFixed(6)}`;
  const destination = `${b.lng.toFixed(6)},${b.lat.toFixed(6)}`;

  if (profile === 'cycling') {
    // Bicycling lives on the v4 API with a different envelope (errcode/data).
    const key = getAmapKey();
    const res = await fetch(`${AMAP_BASE}/v4/direction/bicycling?origin=${origin}&destination=${destination}&key=${key}`);
    const data = await res.json() as { errcode?: number; data?: { paths?: AmapPath[] } };
    const path = data.data?.paths?.[0];
    if (!res.ok || data.errcode !== 0 || !path) {
      throw Object.assign(new Error('Amap bicycling route failed'), { status: 502 });
    }
    return {
      coordinates: parsePolyline(path.steps),
      distance: Number(path.distance) || 0,
      duration: Number(path.duration) || 0,
    };
  }

  const path = profile === 'walking' ? '/v3/direction/walking' : '/v3/direction/driving';
  const data = await amapFetch(path, { origin, destination });
  const route = (data.route as { paths?: AmapPath[] } | undefined)?.paths?.[0];
  if (!route) throw Object.assign(new Error('Amap route not found'), { status: 404 });
  return {
    coordinates: parsePolyline(route.steps),
    distance: Number(route.distance) || 0,
    duration: Number(route.duration ?? route.cost?.duration) || 0,
  };
}

export async function amapRoute(
  waypoints: { lat: number; lng: number }[],
  profile: 'driving' | 'walking' | 'cycling',
): Promise<AmapRouteResult> {
  const coordinates: [number, number][] = [];
  const legs: { distance: number; duration: number }[] = [];
  let distance = 0;
  let duration = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const leg = await amapDirectionLeg(waypoints[i], waypoints[i + 1], profile);
    coordinates.push(...leg.coordinates);
    legs.push({ distance: leg.distance, duration: leg.duration });
    distance += leg.distance;
    duration += leg.duration;
  }
  return { coordinates, distance, duration, legs };
}

// ── Reverse geocoding (v3 geocode/regeo) ─────────────────────────────────────

export async function reverseGeocodeAmap(
  lat: number,
  lng: number,
): Promise<{ name: string | null; address: string | null }> {
  const g = wgs84ToGcj02(lat, lng);
  const data = await amapFetch('/v3/geocode/regeo', {
    location: `${g.lng.toFixed(6)},${g.lat.toFixed(6)}`,
    extensions: 'all',
    radius: '300',
  });
  const regeo = data.regeocode as {
    formatted_address?: string | unknown[];
    pois?: { name?: string }[];
    aois?: { name?: string }[];
  } | undefined;
  const address = typeof regeo?.formatted_address === 'string' ? regeo.formatted_address : null;
  const name = regeo?.aois?.[0]?.name || regeo?.pois?.[0]?.name || null;
  return { name, address };
}
