/**
 * Coordinate-system conversion between WGS-84 (GPS / OSM / storage),
 * GCJ-02 (Amap, QWeather, Tencent — mandated for Chinese basemaps) and
 * BD-09 (Baidu). Pure functions, zero dependencies.
 *
 * TREK stores WGS-84 everywhere; convert only at the boundaries:
 * rendering on a GCJ-02 basemap, importing Amap data, or generating
 * Amap/Baidu deep links. Accuracy of the inverse (GCJ→WGS) is ~1–2 m,
 * which is well below basemap offset (~100–700 m) and fine for travel use.
 *
 * Algorithm: the widely used public reimplementation of the GCJ-02
 * obfuscation (see wandergis/coordtransform, MIT).
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const A = 6378245.0; // krasovsky ellipsoid semi-major axis
const EE = 0.00669342162296594323; // eccentricity squared
const X_PI = (Math.PI * 3000.0) / 180.0;

/** GCJ-02 obfuscation only applies inside mainland China's bounding box. */
export function isOutsideChina(lat: number, lng: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret +=
    ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret +=
    ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

function delta(lat: number, lng: number): LatLng {
  const dLat0 = transformLat(lng - 105.0, lat - 35.0);
  const dLng0 = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const dLat = (dLat0 * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
  const dLng = (dLng0 * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: dLat, lng: dLng };
}

export function wgs84ToGcj02(lat: number, lng: number): LatLng {
  if (isOutsideChina(lat, lng)) return { lat, lng };
  const d = delta(lat, lng);
  return { lat: lat + d.lat, lng: lng + d.lng };
}

export function gcj02ToWgs84(lat: number, lng: number): LatLng {
  if (isOutsideChina(lat, lng)) return { lat, lng };
  const d = delta(lat, lng);
  return { lat: lat - d.lat, lng: lng - d.lng };
}

export function gcj02ToBd09(lat: number, lng: number): LatLng {
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * X_PI);
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * X_PI);
  return { lat: z * Math.sin(theta) + 0.006, lng: z * Math.cos(theta) + 0.0065 };
}

export function bd09ToGcj02(lat: number, lng: number): LatLng {
  const x = lng - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return { lat: z * Math.sin(theta), lng: z * Math.cos(theta) };
}

export function wgs84ToBd09(lat: number, lng: number): LatLng {
  const g = wgs84ToGcj02(lat, lng);
  return gcj02ToBd09(g.lat, g.lng);
}

export function bd09ToWgs84(lat: number, lng: number): LatLng {
  const g = bd09ToGcj02(lat, lng);
  return gcj02ToWgs84(g.lat, g.lng);
}

/** Coordinate system used by a map data/tile source. */
export type CoordSystem = 'wgs84' | 'gcj02' | 'bd09';

/** Convert a WGS-84 point (TREK storage) into the given target system. */
export function fromWgs84(lat: number, lng: number, target: CoordSystem): LatLng {
  if (target === 'gcj02') return wgs84ToGcj02(lat, lng);
  if (target === 'bd09') return wgs84ToBd09(lat, lng);
  return { lat, lng };
}

/** Convert a point in the given source system back to WGS-84 for storage. */
export function toWgs84(lat: number, lng: number, source: CoordSystem): LatLng {
  if (source === 'gcj02') return gcj02ToWgs84(lat, lng);
  if (source === 'bd09') return bd09ToWgs84(lat, lng);
  return { lat, lng };
}
