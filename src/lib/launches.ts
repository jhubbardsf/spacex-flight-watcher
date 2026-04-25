// Launch Library 2 client. Free tier: 15 req/hr, no auth. Once-daily polling
// keeps us well under the limit even if we re-fetch a few times per run.
//
// API shape: https://ll.thespacedevs.com/2.2.0/swagger/

const BASE = "https://ll.thespacedevs.com/2.2.0";

export type LaunchStatus =
  | "Go"
  | "TBC"
  | "TBD"
  | "Hold"
  | "Success"
  | "Failure"
  | "Partial Failure"
  | "In Flight"
  | "Launch Successful";

export type Launch = {
  id: string;
  name: string;
  net: string; // ISO 8601 launch time (no-earlier-than)
  windowStart: string | null;
  windowEnd: string | null;
  status: LaunchStatus;
  padName: string;
  padLat: number;
  padLon: number;
  locationName: string; // e.g. "Cape Canaveral, FL, USA"
  orbitName: string | null; // e.g. "Low Earth Orbit"
  missionDescription: string | null;
  webcastLive: boolean;
};

type RawLaunch = {
  id: string;
  name?: string | null;
  net?: string | null;
  window_start?: string | null;
  window_end?: string | null;
  status?: { abbrev?: string | null } | null;
  pad?: {
    name?: string | null;
    latitude?: string | number | null;
    longitude?: string | number | null;
    location?: { name?: string | null } | null;
  } | null;
  mission?: {
    description?: string | null;
    orbit?: { name?: string | null } | null;
  } | null;
  webcast_live?: boolean | null;
};

type RawResponse = { results?: RawLaunch[] };

function num(v: string | number | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number.parseFloat(v);
  throw new Error("Expected numeric pad coordinate");
}

function toLaunch(raw: RawLaunch): Launch | null {
  if (!raw.id || !raw.net || !raw.pad?.latitude || !raw.pad?.longitude) {
    return null;
  }
  return {
    id: raw.id,
    name: raw.name ?? "(unnamed)",
    net: raw.net,
    windowStart: raw.window_start ?? null,
    windowEnd: raw.window_end ?? null,
    status: (raw.status?.abbrev ?? "TBD") as LaunchStatus,
    padName: raw.pad.name ?? "(unknown pad)",
    padLat: num(raw.pad.latitude),
    padLon: num(raw.pad.longitude),
    locationName: raw.pad.location?.name ?? "(unknown location)",
    orbitName: raw.mission?.orbit?.name ?? null,
    missionDescription: raw.mission?.description ?? null,
    webcastLive: raw.webcast_live ?? false,
  };
}

// Fetch upcoming SpaceX launches within the given lookahead window.
// `lsp__name=SpaceX` is the canonical filter (Launch Service Provider).
export async function fetchUpcomingSpaceX(
  lookaheadDays: number,
): Promise<Launch[]> {
  const now = new Date();
  const horizon = new Date(now.getTime() + lookaheadDays * 86400_000);
  const params = new URLSearchParams({
    lsp__name: "SpaceX",
    net__gte: now.toISOString(),
    net__lte: horizon.toISOString(),
    limit: "20",
    mode: "detailed",
  });
  const url = `${BASE}/launch/upcoming/?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "spacex-flight-watcher/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`LL2 ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as RawResponse;
  const out: Launch[] = [];
  for (const r of data.results ?? []) {
    const parsed = toLaunch(r);
    if (parsed) out.push(parsed);
  }
  return out;
}

// "Active" = not yet successfully launched, not failed. We still notify on
// "Hold" / "TBD" / "TBC" because those are slip states the watcher should
// keep tracking until they resolve.
export function isActive(status: LaunchStatus): boolean {
  return ["Go", "TBC", "TBD", "Hold"].includes(status);
}

// Treat "TBD" as a soft scrub if the launch has been pushed past the window
// we last had it in — handled by the state machine, not here.
export function isScrubbed(status: LaunchStatus): boolean {
  return status === "Hold" || status === "Failure" || status === "Partial Failure";
}
