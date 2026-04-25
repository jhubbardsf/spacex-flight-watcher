import SunCalc from "suncalc";

// Virginia Beach oceanfront, where a beach launch-watching trip would happen.
export const VIRGINIA_BEACH = { lat: 36.8529, lon: -75.9779 } as const;

const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;

// Sun altitude in degrees above the horizon at the given location/time.
// Negative = below horizon (i.e. dark or twilight). Civil twilight = 0 to -6,
// nautical = -6 to -12, astronomical = -12 to -18, full dark = below -18.
export function sunAltitudeDeg(
  iso: string,
  lat: number,
  lon: number,
): number {
  const pos = SunCalc.getPosition(new Date(iso), lat, lon);
  return (pos.altitude * 180) / Math.PI;
}

export type DarknessLabel =
  | "daylight"
  | "civil-twilight"
  | "nautical-twilight"
  | "astronomical-twilight"
  | "night";

export function darknessLabel(altDeg: number): DarknessLabel {
  if (altDeg > 0) return "daylight";
  if (altDeg > -6) return "civil-twilight";
  if (altDeg > -12) return "nautical-twilight";
  if (altDeg > -18) return "astronomical-twilight";
  return "night";
}

// Great-circle distance in km between two lat/lon points (haversine).
export function distanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

// Initial bearing from point 1 to point 2 in degrees clockwise from true north.
// "From VB looking at the launch pad" = bearing from VB to pad.
export function bearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const phi1 = lat1 * DEG;
  const phi2 = lat2 * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const brng = (Math.atan2(y, x) * 180) / Math.PI;
  return (brng + 360) % 360;
}

export function compassFromBearing(deg: number): string {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const idx = Math.round(deg / 22.5) % 16;
  return dirs[idx]!;
}
