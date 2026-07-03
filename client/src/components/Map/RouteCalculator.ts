import { useSettingsStore } from '../../store/settingsStore'
import type { DistanceUnit, RouteResult, RouteSegment, RouteWithLegs, Waypoint, RouteAnchors } from '../../types'
import { formatDistance } from '../../utils/units'
import { generateAmapUrl, isChinaMapMode } from './chinaCrs'

// Server-side Amap route proxy (China mode). Returns null when the server has
// no AMAP_API_KEY (501) so callers fall back to OSRM; the flag is remembered
// to avoid re-probing on every route.
let amapRouteUnavailable = false
interface ProxyRouteResult {
  coordinates: [number, number][]
  distance: number
  duration: number
  legs: { distance: number; duration: number }[]
}
async function fetchAmapRoute(
  waypoints: Waypoint[],
  profile: 'driving' | 'walking' | 'cycling',
  signal?: AbortSignal,
): Promise<ProxyRouteResult | null> {
  if (amapRouteUnavailable) return null
  const response = await fetch('/api/maps/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ waypoints: waypoints.map(p => ({ lat: p.lat, lng: p.lng })), profile }),
    signal,
  })
  if (response.status === 501) {
    amapRouteUnavailable = true
    return null
  }
  if (!response.ok) throw new Error('Route could not be calculated')
  return await response.json()
}

const OSRM_BASE = 'https://router.project-osrm.org/route/v1'

// FOSSGIS hosts OSRM with real per-profile routing (car/foot/bike) — the
// project-osrm.org demo is car-only (it ignores the profile in the URL). Use
// the matching profile so walking routes follow footpaths, not the road network.
const OSRM_PROFILE_BASE: Record<'driving' | 'walking' | 'cycling', string> = {
  driving: 'https://routing.openstreetmap.de/routed-car/route/v1/driving',
  walking: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot',
  cycling: 'https://routing.openstreetmap.de/routed-bike/route/v1/bike',
}

// Cache route responses keyed by the exact waypoint list. Routes are stable, so
// this avoids re-hitting the public OSRM demo server on every day switch / reorder.
const routeCache = new Map<string, RouteWithLegs>()
const ROUTE_CACHE_MAX = 200

/** Fetches a full route via OSRM and returns coordinates, distance, and duration estimates for driving/walking. */
export async function calculateRoute(
  waypoints: Waypoint[],
  profile: 'driving' | 'walking' | 'cycling' = 'driving',
  { signal }: { signal?: AbortSignal } = {}
): Promise<RouteResult> {
  if (!waypoints || waypoints.length < 2) {
    throw new Error('At least 2 waypoints required')
  }

  let coordinates: [number, number][]
  let distance: number
  let routeDuration: number

  const amapResult = isChinaMapMode() ? await fetchAmapRoute(waypoints, profile, signal) : null
  if (amapResult) {
    coordinates = amapResult.coordinates
    distance = amapResult.distance
    routeDuration = amapResult.duration
  } else {
    const coords = waypoints.map((p) => `${p.lng},${p.lat}`).join(';')
    const url = `${OSRM_BASE}/${profile}/${coords}?overview=full&geometries=geojson&steps=false`

    const response = await fetch(url, { signal })
    if (!response.ok) {
      throw new Error('Route could not be calculated')
    }

    const data = await response.json()

    if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
      throw new Error('No route found')
    }

    const route = data.routes[0]
    coordinates = route.geometry.coordinates.map(([lng, lat]: [number, number]) => [lat, lng])
    distance = route.distance
    routeDuration = route.duration
  }

  let duration: number
  if (profile === 'walking') {
    duration = distance / (5000 / 3600)
  } else if (profile === 'cycling') {
    duration = distance / (15000 / 3600)
  } else {
    duration = routeDuration
  }

  const walkingDuration = distance / (5000 / 3600)
  const drivingDuration: number = routeDuration

  return {
    coordinates,
    distance,
    duration,
    distanceText: formatRouteDistance(distance),
    durationText: formatDuration(duration),
    walkingText: formatDuration(walkingDuration),
    drivingText: formatDuration(drivingDuration),
  }
}

/**
 * Prepends a hotel→first-waypoint run and appends a last-waypoint→hotel run to the
 * day's activity runs, so the drawn route starts and ends at the day's accommodation
 * (matching the sidebar's hotel connectors). A bookend is only added when both its
 * hotel and the first/last located waypoint exist; passing nulls leaves `runs`
 * untouched. The shared first/last waypoint is repeated so the polylines join.
 */
export function withHotelBookends(
  runs: Waypoint[][],
  firstWay: Waypoint | undefined,
  lastWay: Waypoint | undefined,
  startHotel: Waypoint | null,
  endHotel: Waypoint | null,
): Waypoint[][] {
  const out: Waypoint[][] = []
  if (startHotel && firstWay) out.push([startHotel, firstWay])
  out.push(...runs)
  if (endHotel && lastWay) out.push([lastWay, endHotel])
  return out
}

export function generateGoogleMapsUrl(places: Waypoint[]): string | null {
  const valid = places.filter((p) => p.lat && p.lng)
  if (valid.length === 0) return null
  if (isChinaMapMode()) return generateAmapUrl(valid)
  if (valid.length === 1) {
    return `https://www.google.com/maps/search/?api=1&query=${valid[0].lat},${valid[0].lng}`
  }
  const stops = valid.map((p) => `${p.lat},${p.lng}`).join('/')
  return `https://www.google.com/maps/dir/${stops}`
}

// Squared planar distance — enough for nearest-neighbor comparisons and cheaper than a full haversine.
function sqDist(a: Waypoint, b: Waypoint): number {
  return (a.lat - b.lat) ** 2 + (a.lng - b.lng) ** 2
}

// Length of visiting `order` in sequence, optionally pinned to a fixed start and/or end anchor.
// With start === end this is a closed loop back to the anchor (a day out from and back to the hotel).
function tourLength(order: Waypoint[], start?: Waypoint, end?: Waypoint): number {
  if (order.length === 0) return 0
  let total = 0
  if (start) total += Math.sqrt(sqDist(start, order[0]))
  for (let i = 0; i < order.length - 1; i++) total += Math.sqrt(sqDist(order[i], order[i + 1]))
  if (end) total += Math.sqrt(sqDist(order[order.length - 1], end))
  return total
}

// Greedy nearest-neighbor ordering, seeded at the start anchor when there is one.
function nearestNeighborOrder<T extends Waypoint>(valid: T[], start?: Waypoint): T[] {
  const visited = new Set<number>()
  const result: T[] = []
  let current: Waypoint
  if (start) {
    current = start
  } else {
    current = valid[0]
    visited.add(0)
    result.push(valid[0])
  }
  while (result.length < valid.length) {
    let nearestIdx = -1
    let minDist = Infinity
    for (let i = 0; i < valid.length; i++) {
      if (visited.has(i)) continue
      const d = sqDist(valid[i], current)
      if (d < minDist) { minDist = d; nearestIdx = i }
    }
    if (nearestIdx === -1) break
    visited.add(nearestIdx)
    current = valid[nearestIdx]
    result.push(valid[nearestIdx])
  }
  return result
}

// 2-opt: repeatedly reverse a sub-segment whenever it shortens the tour. This removes the crossings
// a pure nearest-neighbor pass leaves behind. The start/end anchors stay fixed, so a round trip
// (start === end) is untangled into a clean loop rather than an open path.
function twoOptImprove<T extends Waypoint>(order: T[], start?: Waypoint, end?: Waypoint): T[] {
  if (order.length < 3) return order
  let best = order
  let bestLen = tourLength(best, start, end)
  let improved = true
  while (improved) {
    improved = false
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1))
        const len = tourLength(candidate, start, end)
        if (len < bestLen - 1e-12) {
          best = candidate
          bestLen = len
          improved = true
        }
      }
    }
  }
  return best
}

/**
 * Reorders waypoints to minimize travel distance: a nearest-neighbor pass for a good starting order,
 * then 2-opt to untangle crossings. Optional anchors (e.g. the day's accommodation) pin the route's
 * ends — start === end makes it a loop out from and back to the hotel; a transfer day runs start → end.
 */
export function optimizeRoute<T extends Waypoint>(places: T[], anchors: RouteAnchors = {}): T[] {
  const { start, end } = anchors
  const valid = places.filter((p) => p.lat && p.lng)
  if (valid.length <= 1) return places
  // Two unanchored stops have no meaningful order to optimize; anchors can still flip them.
  if (valid.length === 2 && !start && !end) return places

  const order = twoOptImprove(nearestNeighborOrder(valid, start), start, end)

  // A round trip's loop direction is arbitrary, so orient it to begin at the stop nearest the hotel —
  // that reads naturally as "leave the hotel, head to the closest place, …, come back".
  if (start && end && start.lat === end.lat && start.lng === end.lng && order.length > 1) {
    if (sqDist(order[order.length - 1], start) < sqDist(order[0], start)) order.reverse()
  }

  return order
}

/** Fetches per-leg distance/duration from OSRM and returns segment metadata (midpoints, walking/driving times). */
export async function calculateSegments(
  waypoints: Waypoint[],
  { signal }: { signal?: AbortSignal } = {}
): Promise<RouteSegment[]> {
  if (!waypoints || waypoints.length < 2) return []

  let legs: { distance: number; duration: number }[]
  const amapResult = isChinaMapMode() ? await fetchAmapRoute(waypoints, 'driving', signal) : null
  if (amapResult) {
    legs = amapResult.legs
  } else {
    const coords = waypoints.map((p) => `${p.lng},${p.lat}`).join(';')
    const url = `${OSRM_BASE}/driving/${coords}?overview=false&geometries=geojson&steps=false&annotations=distance,duration`

    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error('Route could not be calculated')

    const data = await response.json()
    if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error('No route found')

    legs = data.routes[0].legs
  }
  return legs.map((leg: { distance: number; duration: number }, i: number): RouteSegment => {
    const from: [number, number] = [waypoints[i].lat, waypoints[i].lng]
    const to: [number, number] = [waypoints[i + 1].lat, waypoints[i + 1].lng]
    const mid: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]
    const walkingDuration = leg.distance / (5000 / 3600)
    return {
      mid, from, to,
      distance: leg.distance,
      duration: leg.duration,
      walkingText: formatDuration(walkingDuration),
      drivingText: formatDuration(leg.duration),
      distanceText: formatRouteDistance(leg.distance),
    }
  })
}

/**
 * One OSRM call per waypoint-run that returns BOTH the real road geometry (for the
 * map) and per-leg distance/duration (for the sidebar connectors). Results are cached
 * by the exact waypoint list. Throws on OSRM failure so callers can fall back to a
 * straight line.
 */
export async function calculateRouteWithLegs(
  waypoints: Waypoint[],
  { signal, profile = 'driving' }: { signal?: AbortSignal; profile?: 'driving' | 'walking' | 'cycling' } = {}
): Promise<RouteWithLegs> {
  if (!waypoints || waypoints.length < 2) {
    return { coordinates: [], distance: 0, duration: 0, legs: [] }
  }

  const coords = waypoints.map((p) => `${p.lng},${p.lat}`).join(';')
  // The cached result carries formatted leg distances, so the active distance unit is
  // part of the key — otherwise switching km↔mi would return stale text (#1300).
  const cacheKey = `${profile}:${getDistanceUnit()}:${coords}`
  const cached = routeCache.get(cacheKey)
  if (cached) return cached

  let coordinates: [number, number][]
  let rawLegs: { distance: number; duration: number }[]
  let totalDistance: number
  let totalDuration: number

  const amapResult = isChinaMapMode() ? await fetchAmapRoute(waypoints, profile, signal) : null
  if (amapResult) {
    coordinates = amapResult.coordinates
    rawLegs = amapResult.legs
    totalDistance = amapResult.distance
    totalDuration = amapResult.duration
  } else {
    const url = `${OSRM_PROFILE_BASE[profile]}/${coords}?overview=full&geometries=geojson&annotations=distance,duration`
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error('Route could not be calculated')

    const data = await response.json()
    if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error('No route found')

    const route = data.routes[0]
    coordinates = route.geometry.coordinates.map(
      ([lng, lat]: [number, number]) => [lat, lng]
    )
    rawLegs = route.legs || []
    totalDistance = route.distance
    totalDuration = route.duration
  }

  const legs: RouteSegment[] = rawLegs.map(
    (leg: { distance: number; duration: number }, i: number): RouteSegment => {
      const from: [number, number] = [waypoints[i].lat, waypoints[i].lng]
      const to: [number, number] = [waypoints[i + 1].lat, waypoints[i + 1].lng]
      const mid: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]
      const walkingDuration = leg.distance / (5000 / 3600)
      return {
        mid, from, to,
        distance: leg.distance,
        duration: leg.duration,
        walkingText: formatDuration(walkingDuration),
        drivingText: formatDuration(leg.duration),
        distanceText: formatRouteDistance(leg.distance),
        durationText: formatDuration(leg.duration),
      }
    }
  )

  const result: RouteWithLegs = { coordinates, distance: totalDistance, duration: totalDuration, legs }
  routeCache.set(cacheKey, result)
  if (routeCache.size > ROUTE_CACHE_MAX) {
    const oldest = routeCache.keys().next().value
    if (oldest !== undefined) routeCache.delete(oldest)
  }
  return result
}

function getDistanceUnit(): DistanceUnit {
  return useSettingsStore.getState().settings.distance_unit === 'imperial' ? 'imperial' : 'metric'
}

function formatRouteDistance(meters: number): string {
  const unit = getDistanceUnit()
  if (unit === 'metric' && meters < 1000) {
    return `${Math.round(meters)} m`
  }
  return formatDistance(meters / 1000, unit)
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) {
    return `${h} h ${m} min`
  }
  return `${m} min`
}
