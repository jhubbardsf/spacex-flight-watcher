import {
  bearingDeg,
  compassFromBearing,
  darknessLabel,
  distanceKm,
  sunAltitudeDeg,
  VIRGINIA_BEACH,
} from "./lib/astronomy";
import { judge, type LaunchFacts, type Verdict } from "./lib/judge";
import { fetchUpcomingSpaceX, type Launch } from "./lib/launches";
import { sendImessage } from "./lib/sendblue";
import {
  loadState,
  saveState,
  todayInEt,
  type LaunchState,
  type WatchState,
} from "./lib/state";
import { forecastAt, type WeatherSnapshot } from "./lib/weather";

const LOOKAHEAD_DAYS = 7;
const SLIP_THRESHOLD_MS = 2 * 3600_000; // 2 hours
const MIN_CONFIDENCE_FOR_NOTIFY = new Set(["medium", "high"] as const);

// ----- formatting -------------------------------------------------------

function formatEtTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function netLocalLabel(iso: string): string {
  const launch = new Date(iso);
  const now = new Date();
  const dayDiff = Math.round((launch.getTime() - now.getTime()) / 86400_000);
  const time = launch.toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  if (dayDiff === 0) return `Tonight at ${time}`;
  if (dayDiff === 1) return `Tomorrow at ${time}`;
  return `${formatEtTime(iso)}`;
}

function formatVisibleMessage(
  prefix: string,
  l: Launch,
  v: Verdict,
  facts: LaunchFacts,
): string {
  const lines = [
    prefix,
    `${l.name}`,
    `${netLocalLabel(l.net)} (${facts.locationName})`,
    `Sky: ${facts.vbForecast ?? "?"}${facts.vbPrecipitationProbability !== null ? `, precip ${facts.vbPrecipitationProbability}%` : ""}`,
    `Look ${facts.bearingVbToPadCompass} (${facts.bearingVbToPadDeg.toFixed(0)}°)`,
    `Confidence: ${v.confidence}`,
  ];
  if (v.viewing_tip) lines.push(v.viewing_tip);
  return lines.join("\n");
}

function formatScrubMessage(l: Launch): string {
  return `Launch scrubbed: ${l.name}\nStatus is now "${l.status}". Will keep watching.`;
}

function formatNoLongerVisibleMessage(l: Launch, v: Verdict): string {
  return `Heads up: ${l.name} is no longer a good viewing candidate.\n${netLocalLabel(l.net)}\nReason: ${v.reason}`;
}

function formatSlipMessage(l: Launch, v: Verdict, facts: LaunchFacts): string {
  return formatVisibleMessage(
    `Launch time changed: ${l.name}`,
    l,
    v,
    facts,
  );
}

// ----- daily summary ----------------------------------------------------

type LaunchResult = {
  launch: Launch;
  facts: LaunchFacts;
  verdict: Verdict;
};

function formatDailySummary(results: LaunchResult[], totalFetched: number): string {
  const today = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const visibleNight = results.filter(
    (r) =>
      r.facts.sunAltitudeAtVbDeg < 0 &&
      r.verdict.visible &&
      (MIN_CONFIDENCE_FOR_NOTIFY as Set<string>).has(r.verdict.confidence),
  );

  const nightNotVisible = results.filter(
    (r) =>
      r.facts.sunAltitudeAtVbDeg < 0 &&
      !(r.verdict.visible && (MIN_CONFIDENCE_FOR_NOTIFY as Set<string>).has(r.verdict.confidence)),
  );

  const daytime = results.filter((r) => r.facts.sunAltitudeAtVbDeg >= 0);

  const lines: string[] = [
    `SpaceX Watch — ${today}`,
    "",
    `${totalFetched} launch${totalFetched !== 1 ? "es" : ""} in the next ${LOOKAHEAD_DAYS} days`,
  ];

  if (visibleNight.length > 0) {
    for (const r of visibleNight) {
      const sky = r.facts.vbForecast
        ? `${r.facts.vbForecast}${r.facts.vbPrecipitationProbability !== null ? `, precip ${r.facts.vbPrecipitationProbability}%` : ""}`
        : "forecast unavailable";
      lines.push(
        "",
        `VISIBLE FROM VB: ${r.launch.name}`,
        `${netLocalLabel(r.launch.net)} — ${r.facts.locationName}`,
        `Look ${r.facts.bearingVbToPadCompass} (${r.facts.bearingVbToPadDeg.toFixed(0)}°) | Sky: ${sky}`,
        `Confidence: ${r.verdict.confidence}`,
      );
      if (r.verdict.viewing_tip) lines.push(r.verdict.viewing_tip);
    }
  } else {
    lines.push("", "No launches visible from VB this week.");
  }

  if (nightNotVisible.length > 0) {
    lines.push("", `Other night launches (${nightNotVisible.length}):`);
    for (const r of nightNotVisible) {
      lines.push(`  ${r.launch.name} | ${netLocalLabel(r.launch.net)}`);
    }
  }

  if (daytime.length > 0) {
    lines.push("", `Daytime launches (${daytime.length}):`);
    for (const r of daytime) {
      lines.push(`  ${r.launch.name} | ${netLocalLabel(r.launch.net)}`);
    }
  }

  return lines.join("\n");
}

// ----- per-launch processing -------------------------------------------

async function buildFacts(l: Launch): Promise<LaunchFacts> {
  const sunVb = sunAltitudeDeg(l.net, VIRGINIA_BEACH.lat, VIRGINIA_BEACH.lon);
  const sunPad = sunAltitudeDeg(l.net, l.padLat, l.padLon);
  const dist = distanceKm(VIRGINIA_BEACH.lat, VIRGINIA_BEACH.lon, l.padLat, l.padLon);
  const brng = bearingDeg(VIRGINIA_BEACH.lat, VIRGINIA_BEACH.lon, l.padLat, l.padLon);

  let weather: WeatherSnapshot | null = null;
  try {
    weather = await forecastAt(l.net);
  } catch (err) {
    // NWS occasionally 5xx's; not fatal — LLM handles missing weather.
    console.warn(`weather fetch failed for ${l.id}:`, err);
  }

  return {
    name: l.name,
    netIso: l.net,
    netLocalLabel: netLocalLabel(l.net),
    status: l.status,
    padName: l.padName,
    locationName: l.locationName,
    orbitName: l.orbitName,
    missionDescription: l.missionDescription,
    sunAltitudeAtVbDeg: sunVb,
    darknessAtVb: darknessLabel(sunVb),
    sunAltitudeAtPadDeg: sunPad,
    darknessAtPad: darknessLabel(sunPad),
    distanceVbToPadKm: dist,
    bearingVbToPadDeg: brng,
    bearingVbToPadCompass: compassFromBearing(brng),
    vbForecast: weather?.shortForecast ?? null,
    vbTemperatureF: weather?.temperatureF ?? null,
    vbPrecipitationProbability: weather?.precipitationProbability ?? null,
  };
}

type Action =
  | { kind: "none" }
  | { kind: "scrub" }
  | { kind: "new_candidate"; verdict: Verdict; facts: LaunchFacts }
  | { kind: "no_longer_visible"; verdict: Verdict }
  | { kind: "time_slip"; verdict: Verdict; facts: LaunchFacts };

function decide(
  l: Launch,
  v: Verdict,
  facts: LaunchFacts,
  prior: LaunchState | undefined,
): Action {
  // 1. Scrub takes priority over visibility judgment.
  if (l.status === "Hold" || l.status === "Failure" || l.status === "Partial Failure") {
    if (prior && prior.lastVerdict !== "scrubbed") return { kind: "scrub" };
    return { kind: "none" };
  }

  const wouldNotify =
    v.visible &&
    (MIN_CONFIDENCE_FOR_NOTIFY as Set<string>).has(v.confidence);

  if (!wouldNotify) {
    // Newly-not-visible: only flip-notify if the previous state was visible.
    if (prior && prior.lastVerdict === "visible") {
      return { kind: "no_longer_visible", verdict: v };
    }
    return { kind: "none" };
  }

  // It's a viable candidate now. What did we say last time?
  if (!prior || prior.lastVerdict !== "visible") {
    return { kind: "new_candidate", verdict: v, facts };
  }

  // Was visible before; is launch time materially different?
  const slip = Math.abs(new Date(l.net).getTime() - new Date(prior.net).getTime());
  if (slip > SLIP_THRESHOLD_MS) {
    return { kind: "time_slip", verdict: v, facts };
  }

  // Already notified about this visible launch — daily summary covers reminders.
  return { kind: "none" };
}

async function actOn(action: Action, l: Launch): Promise<{ messaged: boolean; verdict: Verdict | null }> {
  switch (action.kind) {
    case "none":
      return { messaged: false, verdict: null };
    case "scrub":
      await sendImessage(formatScrubMessage(l));
      return { messaged: true, verdict: null };
    case "no_longer_visible":
      await sendImessage(formatNoLongerVisibleMessage(l, action.verdict));
      return { messaged: true, verdict: action.verdict };
    case "new_candidate":
      await sendImessage(
        formatVisibleMessage(`Possible launch view: ${l.name}`, l, action.verdict, action.facts),
      );
      return { messaged: true, verdict: action.verdict };
    case "time_slip":
      await sendImessage(formatSlipMessage(l, action.verdict, action.facts));
      return { messaged: true, verdict: action.verdict };
  }
}

function nextStateFor(
  l: Launch,
  v: Verdict | null,
  forecast: string | null,
  prior: LaunchState | undefined,
  todayEt: string,
  messaged: boolean,
): LaunchState {
  const nowIso = new Date().toISOString();
  const isScrub =
    l.status === "Hold" ||
    l.status === "Failure" ||
    l.status === "Partial Failure";
  let lastVerdict: LaunchState["lastVerdict"];
  if (isScrub) lastVerdict = "scrubbed";
  else if (v && v.visible && (MIN_CONFIDENCE_FOR_NOTIFY as Set<string>).has(v.confidence))
    lastVerdict = "visible";
  else lastVerdict = "not_visible";

  return {
    name: l.name,
    net: l.net,
    lastVerdict,
    lastConfidence: v?.confidence ?? prior?.lastConfidence ?? null,
    lastForecast: forecast ?? prior?.lastForecast ?? null,
    lastNotifiedAt: messaged ? nowIso : (prior?.lastNotifiedAt ?? nowIso),
    lastNotifiedDay: messaged ? todayEt : (prior?.lastNotifiedDay ?? ""),
    firstSeenAt: prior?.firstSeenAt ?? nowIso,
  };
}

// ----- handler ----------------------------------------------------------

export type RunSummary = {
  examined: number;
  judged: number;
  messaged: number;
  errors: number;
};

export const handler = async (): Promise<RunSummary> => {
  const launches = await fetchUpcomingSpaceX(LOOKAHEAD_DAYS);
  console.log(`Fetched ${launches.length} upcoming SpaceX launches`);

  const state = await loadState();
  const todayEt = todayInEt();

  let judged = 0;
  let messaged = 0;
  let errors = 0;

  const results: LaunchResult[] = [];

  for (const l of launches) {
    try {
      const facts = await buildFacts(l);
      const verdict = await judge(facts);
      judged += 1;
      results.push({ launch: l, facts, verdict });
      console.log(
        `${l.id} ${l.name}: visible=${verdict.visible} conf=${verdict.confidence} reason="${verdict.reason}"`,
      );

      const prior = state.launches[l.id];
      const action = decide(l, verdict, facts, prior);
      const { messaged: didMessage, verdict: actionVerdict } = await actOn(action, l);
      if (didMessage) messaged += 1;

      state.launches[l.id] = nextStateFor(
        l,
        actionVerdict ?? verdict,
        facts.vbForecast,
        prior,
        todayEt,
        didMessage,
      );
    } catch (err) {
      errors += 1;
      console.error(`Failed to process ${l.id} (${l.name}):`, err);
      // Don't update state on failure — next run will retry cleanly.
    }
  }

  // Send one daily summary covering all upcoming launches. The per-launch
  // event-driven alerts above handle scrubs, time slips, and new candidates;
  // this single message is the daily "here's the full picture" digest.
  if (state.summaryLastDay !== todayEt) {
    const summary = formatDailySummary(results, launches.length);
    await sendImessage(summary);
    state.summaryLastDay = todayEt;
    messaged += 1;
    console.log("Sent daily summary");
  }

  await saveState(state);

  return {
    examined: launches.length,
    judged,
    messaged,
    errors,
  };
};
