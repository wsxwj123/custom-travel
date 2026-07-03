import { wgs84ToGcj02 } from '@trek/shared';
import type { HourlyEntry, WeatherResult } from './weatherService';

// ── QWeather (和风天气) provider ─────────────────────────────────────────────
// Active when QWEATHER_API_KEY is set — Open-Meteo is unreliable from mainland
// China. Covers current weather and forecasts up to 7 days (free tier); dates
// beyond that or in the past return null so weatherService falls back to its
// Open-Meteo archive/climate paths.
// ponytail: 7d + 24h endpoints only; 30d/72h/history are paid tiers.

export function getQWeatherKey(): string | null {
  return process.env.QWEATHER_API_KEY?.trim() || null;
}

function getQWeatherHost(): string {
  // New QWeather accounts get a dedicated API host; the shared legacy host
  // still works as a fallback but is being retired.
  return process.env.QWEATHER_API_HOST?.trim() || 'devapi.qweather.com';
}

interface QWeatherDaily {
  fxDate: string;
  tempMax: string;
  tempMin: string;
  iconDay: string;
  textDay: string;
  sunrise?: string;
  sunset?: string;
  precip?: string;
  windSpeedDay?: string;
}

interface QWeatherHourly {
  fxTime: string;
  temp: string;
  icon: string;
  precip?: string;
  pop?: string;
  windSpeed?: string;
  humidity?: string;
}

// QWeather icon code → TREK's coarse condition buckets (same values as WMO_MAP).
export function iconToMain(icon: number): string {
  if (icon === 100 || icon === 150) return 'Clear';
  if (icon < 300) return 'Clouds';
  if (icon >= 302 && icon <= 304) return 'Thunderstorm';
  if (icon === 309) return 'Drizzle';
  if (icon < 400) return 'Rain';
  if (icon < 500) return 'Snow';
  if (icon < 600) return 'Fog';
  return 'Clouds';
}

async function qwFetch<T extends Record<string, unknown>>(path: string, lat: string, lng: string, lang: string): Promise<T> {
  const key = getQWeatherKey();
  if (!key) throw new Error('QWeather API key not configured');
  // QWeather uses GCJ-02 for mainland China; coordinates take max 2 decimals.
  const g = wgs84ToGcj02(parseFloat(lat), parseFloat(lng));
  const params = new URLSearchParams({ location: `${g.lng.toFixed(2)},${g.lat.toFixed(2)}`, lang });
  const res = await fetch(`https://${getQWeatherHost()}${path}?${params}`, {
    headers: { 'X-QW-Api-Key': key },
  });
  const data = await res.json() as T & { code?: string };
  if (!res.ok || data.code !== '200') {
    throw new Error(`QWeather API error: ${data.code || res.status}`);
  }
  return data;
}

async function fetchDailyEntry(lat: string, lng: string, dateStr: string, lang: string): Promise<QWeatherDaily | null> {
  const data = await qwFetch<{ daily?: QWeatherDaily[] }>('/v7/weather/7d', lat, lng, lang);
  return data.daily?.find(d => d.fxDate === dateStr) || null;
}

/** Mirrors weatherService's simple getWeather. Returns null when out of range. */
export async function qweatherGetWeather(
  lat: string,
  lng: string,
  date: string | undefined,
  lang: string,
): Promise<WeatherResult | null> {
  if (!date) {
    const data = await qwFetch<{ now?: { temp: string; icon: string; text: string } }>('/v7/weather/now', lat, lng, lang);
    if (!data.now) return null;
    return {
      temp: Math.round(parseFloat(data.now.temp)),
      main: iconToMain(parseInt(data.now.icon, 10)),
      description: data.now.text || '',
      type: 'current',
    };
  }

  const daily = await fetchDailyEntry(lat, lng, date.slice(0, 10), lang);
  if (!daily) return null; // outside the 7-day window → Open-Meteo fallback
  return {
    temp: Math.round((parseFloat(daily.tempMax) + parseFloat(daily.tempMin)) / 2),
    temp_max: Math.round(parseFloat(daily.tempMax)),
    temp_min: Math.round(parseFloat(daily.tempMin)),
    main: iconToMain(parseInt(daily.iconDay, 10)),
    description: daily.textDay || '',
    type: 'forecast',
  };
}

/** Mirrors weatherService's getDetailedWeather. Hourly only for the next 24h. */
export async function qweatherGetDetailedWeather(
  lat: string,
  lng: string,
  date: string,
  lang: string,
): Promise<WeatherResult | null> {
  const dateStr = date.slice(0, 10);
  const daily = await fetchDailyEntry(lat, lng, dateStr, lang);
  if (!daily) return null;

  let hourlyData: HourlyEntry[] = [];
  const isToday = new Date().toISOString().slice(0, 10) === dateStr;
  if (isToday) {
    try {
      const data = await qwFetch<{ hourly?: QWeatherHourly[] }>('/v7/weather/24h', lat, lng, lang);
      hourlyData = (data.hourly || [])
        .filter(h => h.fxTime.startsWith(dateStr))
        .map(h => ({
          hour: parseInt(h.fxTime.slice(11, 13), 10),
          temp: Math.round(parseFloat(h.temp)),
          precipitation: parseFloat(h.precip || '0') || 0,
          precipitation_probability: parseInt(h.pop || '0', 10) || 0,
          main: iconToMain(parseInt(h.icon, 10)),
          wind: Math.round(parseFloat(h.windSpeed || '0') || 0),
          humidity: parseInt(h.humidity || '0', 10) || 0,
        }));
    } catch { /* hourly is optional garnish — keep the daily result */ }
  }

  return {
    type: 'forecast',
    temp: Math.round((parseFloat(daily.tempMax) + parseFloat(daily.tempMin)) / 2),
    temp_max: Math.round(parseFloat(daily.tempMax)),
    temp_min: Math.round(parseFloat(daily.tempMin)),
    main: iconToMain(parseInt(daily.iconDay, 10)),
    description: daily.textDay || '',
    sunrise: daily.sunrise || null,
    sunset: daily.sunset || null,
    precipitation_sum: parseFloat(daily.precip || '0') || 0,
    precipitation_probability_max: 0,
    wind_max: Math.round(parseFloat(daily.windSpeedDay || '0') || 0),
    hourly: hourlyData,
  };
}
