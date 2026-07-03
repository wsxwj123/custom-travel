import L from 'leaflet'
import { gcj02ToWgs84, wgs84ToGcj02 } from '@trek/shared'
import { useSettingsStore } from '../../store/settingsStore'

/**
 * Leaflet CRS for GCJ-02 basemaps (Amap/高德). Composes the WGS-84 → GCJ-02
 * shift into the projection, so every overlay (markers, polylines, clicks,
 * bounds) stays in WGS-84 app-side and lines up with Chinese tiles without
 * touching any call site. Swap the CRS on MapContainer/L.map and you're done.
 */
const gcj02Projection: L.Projection = {
  project(latlng: L.LatLng) {
    const g = wgs84ToGcj02(latlng.lat, latlng.lng)
    return L.Projection.SphericalMercator.project(new L.LatLng(g.lat, g.lng))
  },
  unproject(point: L.Point) {
    const g = L.Projection.SphericalMercator.unproject(point)
    const w = gcj02ToWgs84(g.lat, g.lng)
    return new L.LatLng(w.lat, w.lng)
  },
  bounds: L.Projection.SphericalMercator.bounds,
}

export const CRS_GCJ02: L.CRS = L.Util.extend({}, L.CRS.EPSG3857, {
  code: 'GCJ02',
  projection: gcj02Projection,
})

/** Amap/AutoNavi tiles are GCJ-02; everything else TREK offers is WGS-84. */
export function isGcj02TileUrl(url: string | undefined): boolean {
  return !!url && /autonavi\.com|amap\.com/i.test(url)
}

export function crsForTileUrl(url: string | undefined): L.CRS {
  return isGcj02TileUrl(url) ? CRS_GCJ02 : L.CRS.EPSG3857
}

/** Amap tile hosts shard on webrd01–04 / webst01–04 instead of Leaflet's a-c. */
export function subdomainsForTileUrl(url: string | undefined): string | string[] {
  return isGcj02TileUrl(url) ? ['1', '2', '3', '4'] : 'abc'
}

/**
 * "China map mode" — the user picked an Amap basemap. Drives route planning
 * (server-side Amap proxy instead of OSRM) and export links (uri.amap.com
 * instead of Google Maps), both unreachable/misaligned services in China.
 */
export function isChinaMapMode(): boolean {
  return isGcj02TileUrl(useSettingsStore.getState().settings.map_tile_url)
}

/** Amap deep link for one place (marker) or a first→last navigation. GCJ-02. */
export function generateAmapUrl(places: { lat: number; lng: number; name?: string }[]): string | null {
  const valid = places.filter(p => p.lat && p.lng)
  if (valid.length === 0) return null
  const g = (p: { lat: number; lng: number }) => {
    const c = wgs84ToGcj02(p.lat, p.lng)
    return `${c.lng.toFixed(6)},${c.lat.toFixed(6)}`
  }
  if (valid.length === 1) {
    return `https://uri.amap.com/marker?position=${g(valid[0])}&name=${encodeURIComponent(valid[0].name || '')}`
  }
  // uri.amap.com navigation has no multi-via support — link first → last.
  const from = valid[0]
  const to = valid[valid.length - 1]
  return `https://uri.amap.com/navigation?from=${g(from)},${encodeURIComponent(from.name || 'start')}&to=${g(to)},${encodeURIComponent(to.name || 'end')}&mode=car`
}

export const AMAP_TILE_PRESETS = [
  { name: '高德地图 Amap', url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}' },
  { name: '高德卫星 Amap Satellite', url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}' },
]
