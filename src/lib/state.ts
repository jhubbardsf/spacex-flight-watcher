import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Resource } from "sst";

const s3 = new S3Client({});
const KEY = "watch-state.json";
const TTL_DAYS = 60; // safety prune for entries that fell out of LL2 results

const RETAIN_MS = TTL_DAYS * 86400_000;

// Per-launch persisted memory. Drives the "what changed since last run?"
// decisions in the watcher state machine.
export type LaunchState = {
  name: string;
  net: string; // last-seen launch time (used to detect slip)
  lastVerdict: "visible" | "not_visible" | "scrubbed";
  lastConfidence: "low" | "medium" | "high" | null;
  lastForecast: string | null; // last seen weather summary (cloud check)
  lastNotifiedAt: string; // ISO of most recent iMessage about this launch
  lastNotifiedDay: string; // YYYY-MM-DD in ET — records when we last messaged
  firstSeenAt: string;
};

export type WatchState = {
  launches: Record<string, LaunchState>;
  lastSummaryDay?: string; // YYYY-MM-DD in ET — throttles daily digest to once per day
};

async function getJson<T>(key: string): Promise<T | null> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: Resource.WatchStateBucket.name, Key: key }),
    );
    if (!res.Body) return null;
    const body = await res.Body.transformToString();
    return JSON.parse(body) as T;
  } catch (err) {
    if (err instanceof NoSuchKey) return null;
    throw err;
  }
}

async function putJson(key: string, value: unknown): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: Resource.WatchStateBucket.name,
      Key: key,
      Body: JSON.stringify(value, null, 2),
      ContentType: "application/json",
    }),
  );
}

export async function loadState(): Promise<WatchState> {
  const raw = await getJson<WatchState | Record<string, LaunchState>>(KEY);
  if (!raw) return { launches: {} };
  // Backward compat: old state was a flat Record<id, LaunchState> with no
  // `launches` wrapper. LL2 IDs are UUIDs so the key "launches" can't collide.
  if (!("launches" in raw)) {
    return { launches: raw as Record<string, LaunchState> };
  }
  return raw as WatchState;
}

export async function saveState(state: WatchState): Promise<void> {
  // Prune anything older than TTL — protects against state-file growth if
  // a launch ID stops appearing in LL2 results without our state machine
  // ever marking it scrubbed (e.g. mission renamed, launch removed).
  const cutoff = Date.now() - RETAIN_MS;
  const pruned: WatchState = {
    lastSummaryDay: state.lastSummaryDay,
    launches: {},
  };
  for (const [id, entry] of Object.entries(state.launches)) {
    if (new Date(entry.firstSeenAt).getTime() >= cutoff) pruned.launches[id] = entry;
  }
  await putJson(KEY, pruned);
}

export function todayInEt(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // en-CA gives YYYY-MM-DD
}
