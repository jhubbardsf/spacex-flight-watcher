import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";

// Cross-region inference profile for Haiku 4.5. Cheaper/faster than Sonnet,
// adequate for "weight a few weak signals into a yes/no" judgment.
const MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

const bedrock = new BedrockRuntimeClient({});

// What the model receives. All fields are deterministic; the LLM does not
// look anything up — it only synthesizes.
export type LaunchFacts = {
  name: string;
  netIso: string;
  netLocalLabel: string; // e.g. "Tonight at 9:47 PM ET"
  status: string;
  padName: string;
  locationName: string;
  orbitName: string | null;
  missionDescription: string | null;
  // Astronomy (from VB perspective unless noted)
  sunAltitudeAtVbDeg: number;
  darknessAtVb: string; // "night", "civil-twilight", etc.
  sunAltitudeAtPadDeg: number;
  darknessAtPad: string;
  // Geometry
  distanceVbToPadKm: number;
  bearingVbToPadDeg: number;
  bearingVbToPadCompass: string;
  // Weather at VB at launch time
  vbForecast: string | null;
  vbTemperatureF: number | null;
  vbPrecipitationProbability: number | null;
};

export const Verdict = z.object({
  visible: z.boolean(),
  confidence: z.enum(["low", "medium", "high"]),
  reason: z.string().max(200),
  viewing_tip: z.string().max(200).nullable(),
});
export type Verdict = z.infer<typeof Verdict>;

const SYSTEM = `You assess whether a SpaceX launch will likely be visible to the naked eye from Virginia Beach, VA (36.85°N, 75.98°W). Answer with a strict JSON object matching the schema; no prose outside the JSON.

Visibility heuristics you should apply:
- Cape Canaveral / Kennedy launches (~1,200 km SSW of VB) ARE often visible from Virginia Beach, especially during civil/nautical twilight when the rocket exhaust catches sunlight while the ground observer is in shadow.
- Northeasterly trajectories (ISS resupply, Starlink to inclined orbits) favor East Coast visibility. Due-east or southeasterly trajectories tend to drop below the horizon faster.
- Vandenberg launches (West Coast) are NEVER visible from Virginia Beach — set visible=false, confidence=high.
- Starbase / Boca Chica launches (~1,800 km SW of VB) are generally NOT visible from VB; confidence=high for not-visible unless there is a specific reason to think otherwise.
- Sky conditions: "Clear" / "Mostly Clear" / "Sunny" are good. "Partly Cloudy" reduces confidence one notch. "Mostly Cloudy" / "Overcast" / "Cloudy" generally means visible=false.
- Daylight launches (sun altitude > 0 at VB) are not naked-eye visible — set visible=false, confidence=high.
- Deep-night launches (sun altitude < -18 at VB) reduce booster-plume illumination; visible only for a brief boost-phase glow if at all — typically lower confidence.

Confidence calibration:
- high: trajectory + lighting + weather all clearly aligned (or clearly disqualified)
- medium: most signals point one way but at least one is ambiguous
- low: too many unknowns; treat as not-visible for notification purposes

viewing_tip: a 1-sentence pointer like "Look SSW around T+3 minutes for second-stage plume" if visible=true, else null.`;

const USER_TEMPLATE = (facts: LaunchFacts) =>
  `Mission: ${facts.name}
Status: ${facts.status}
Launch time (UTC): ${facts.netIso}
Local label: ${facts.netLocalLabel}
Pad: ${facts.padName} — ${facts.locationName}
Orbit: ${facts.orbitName ?? "unknown"}
Mission description: ${facts.missionDescription ?? "(none)"}

Sun altitude at Virginia Beach: ${facts.sunAltitudeAtVbDeg.toFixed(1)}° (${facts.darknessAtVb})
Sun altitude at launch pad: ${facts.sunAltitudeAtPadDeg.toFixed(1)}° (${facts.darknessAtPad})
Distance VB → pad: ${facts.distanceVbToPadKm.toFixed(0)} km, bearing ${facts.bearingVbToPadDeg.toFixed(0)}° (${facts.bearingVbToPadCompass})

Virginia Beach forecast at launch time:
  Sky: ${facts.vbForecast ?? "(no forecast available)"}
  Temperature: ${facts.vbTemperatureF !== null ? `${facts.vbTemperatureF}°F` : "(unknown)"}
  Precip probability: ${facts.vbPrecipitationProbability !== null ? `${facts.vbPrecipitationProbability}%` : "(unknown)"}

Output JSON only:
{"visible": <bool>, "confidence": "low"|"medium"|"high", "reason": "<≤200 chars>", "viewing_tip": "<≤200 chars or null>"}`;

type BedrockMessagesResponse = {
  content?: Array<{ type: string; text?: string }>;
};

function extractText(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Bedrock response was not an object");
  }
  const obj = raw as BedrockMessagesResponse;
  const block = obj.content?.find((c) => c.type === "text");
  const text = block?.text;
  if (!text) throw new Error("Bedrock response had no text block");
  return text;
}

// LLM may wrap JSON in ```json fences or include leading prose despite
// instructions. Pull the first balanced {...} block.
function findJsonBlock(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) throw new Error(`No JSON object in model output: ${text}`);
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced JSON object in model output: ${text}`);
}

export async function judge(facts: LaunchFacts): Promise<Verdict> {
  const cmd = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 400,
      system: SYSTEM,
      messages: [{ role: "user", content: USER_TEMPLATE(facts) }],
    }),
  });
  const res = await bedrock.send(cmd);
  const raw = JSON.parse(new TextDecoder().decode(res.body));
  const text = extractText(raw);
  const json = JSON.parse(findJsonBlock(text));
  return Verdict.parse(json);
}
