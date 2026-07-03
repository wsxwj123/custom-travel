import { describe, expect, it } from 'vitest';

import {
  bd09ToGcj02,
  fromWgs84,
  gcj02ToBd09,
  gcj02ToWgs84,
  isOutsideChina,
  toWgs84,
  wgs84ToGcj02,
} from './coord';

// Tiananmen Square — canonical reference point used by coordtransform et al.
const TIANANMEN_WGS = { lat: 39.90734, lng: 116.39129 };
// Known GCJ-02 value for the same point (from Amap picker), tolerance ~1e-4 deg (~10 m).
const TIANANMEN_GCJ = { lat: 39.90875, lng: 116.39754 };

function distDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return Math.max(Math.abs(a.lat - b.lat), Math.abs(a.lng - b.lng));
}

describe('coord', () => {
  it('wgs84ToGcj02 matches known Amap reference within ~10m', () => {
    const g = wgs84ToGcj02(TIANANMEN_WGS.lat, TIANANMEN_WGS.lng);
    expect(distDeg(g, TIANANMEN_GCJ)).toBeLessThan(1e-4);
  });

  it('gcj02ToWgs84 inverts wgs84ToGcj02 within ~2m', () => {
    const g = wgs84ToGcj02(TIANANMEN_WGS.lat, TIANANMEN_WGS.lng);
    const w = gcj02ToWgs84(g.lat, g.lng);
    expect(distDeg(w, TIANANMEN_WGS)).toBeLessThan(2e-5);
  });

  it('bd09 round-trips through gcj02 within ~2m', () => {
    const b = gcj02ToBd09(TIANANMEN_GCJ.lat, TIANANMEN_GCJ.lng);
    const g = bd09ToGcj02(b.lat, b.lng);
    expect(distDeg(g, TIANANMEN_GCJ)).toBeLessThan(2e-5);
  });

  it('is a no-op outside mainland China', () => {
    const paris = { lat: 48.8566, lng: 2.3522 };
    expect(isOutsideChina(paris.lat, paris.lng)).toBe(true);
    expect(wgs84ToGcj02(paris.lat, paris.lng)).toEqual(paris);
    expect(gcj02ToWgs84(paris.lat, paris.lng)).toEqual(paris);
  });

  it('fromWgs84/toWgs84 dispatch by coord system', () => {
    const g = fromWgs84(TIANANMEN_WGS.lat, TIANANMEN_WGS.lng, 'gcj02');
    expect(distDeg(g, TIANANMEN_GCJ)).toBeLessThan(1e-4);
    const w = toWgs84(g.lat, g.lng, 'gcj02');
    expect(distDeg(w, TIANANMEN_WGS)).toBeLessThan(2e-5);
    expect(fromWgs84(1, 2, 'wgs84')).toEqual({ lat: 1, lng: 2 });
  });
});
