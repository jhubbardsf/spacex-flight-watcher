// US National Weather Service forecast client. Free, no API key required.
//
// Two-step flow per NWS docs:
//   1. GET /points/{lat},{lon}  →  returns gridX/gridY for that location
//   2. GET /gridpoints/{office}/{gridX},{gridY}/forecast/hourly
//
// We cache the points lookup at module scope since the grid for VB is
// stable forever (the only way it changes is if NOAA rezones the grid).

const VB_LAT = 36.8529;
const VB_LON = -75.9779;
const HEADERS = {
  Accept: "application/geo+json",
  "User-Agent": "spacex-flight-watcher/1.0 (josh@joshuahubbard.dev)",
};

type PointsResponse = {
  properties?: { forecastHourly?: string };
};

type HourlyForecast = {
  startTime: string;
  endTime: string;
  temperature: number;
  shortForecast: string;
  probabilityOfPrecipitation?: { value: number | null } | null;
};

type ForecastResponse = {
  properties?: { periods?: HourlyForecast[] };
};

let cachedHourlyUrl: string | null = null;

async function getHourlyUrl(): Promise<string> {
  if (cachedHourlyUrl) return cachedHourlyUrl;
  const res = await fetch(
    `https://api.weather.gov/points/${VB_LAT},${VB_LON}`,
    { headers: HEADERS, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`NWS points ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as PointsResponse;
  const url = data.properties?.forecastHourly;
  if (!url) throw new Error("NWS points response missing forecastHourly URL");
  cachedHourlyUrl = url;
  return url;
}

export type WeatherSnapshot = {
  shortForecast: string;
  temperatureF: number;
  precipitationProbability: number | null;
  // skyCover/cloudCover isn't in the hourly periods endpoint by default;
  // shortForecast string ("Mostly Clear", "Partly Cloudy", "Cloudy",
  // "Overcast") is what the LLM gets to interpret.
};

// Fetch the hourly forecast period closest to (and not before) the target
// time. Returns null if the time is outside the forecast horizon (~7 days).
export async function forecastAt(targetIso: string): Promise<WeatherSnapshot | null> {
  const hourlyUrl = await getHourlyUrl();
  const res = await fetch(hourlyUrl, {
    headers: HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`NWS hourly ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as ForecastResponse;
  const periods = data.properties?.periods ?? [];
  const target = new Date(targetIso).getTime();
  const match = periods.find((p) => {
    const start = new Date(p.startTime).getTime();
    const end = new Date(p.endTime).getTime();
    return target >= start && target < end;
  });
  if (!match) return null;
  return {
    shortForecast: match.shortForecast,
    temperatureF: match.temperature,
    precipitationProbability: match.probabilityOfPrecipitation?.value ?? null,
  };
}
