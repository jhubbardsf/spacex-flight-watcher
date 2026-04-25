# spacex-flight-watcher

Personal automation. Once a day, checks upcoming SpaceX launches and
iMessages me (via Sendblue) when one is likely to be visible from Virginia
Beach, VA. Re-notifies each morning while the launch is still a viable
candidate, and flips notifications when weather changes or the launch
slips/scrubs.

The visibility judgment is made by Claude Haiku 4.5 on AWS Bedrock, given a
deterministic dossier of facts (launch site geometry, sun altitude, NWS
weather, trajectory). The LLM only judges — it never fetches data.

Single-environment SST v4 stack in `us-east-1`, stage `prod`. Cost is
effectively $0 (Lambda + S3 + EventBridge free tier; ~$0.03/year of Bedrock
at the current ~3 candidate launches per week).

## Architecture

```
EventBridge cron (daily 13:00 UTC = 9 AM EDT / 8 AM EST)
  ↓
Watcher Lambda:
  1. Fetch upcoming SpaceX launches  (Launch Library 2 — free, no auth)
  2. Filter to next 7 days
  3. For each launch:
     a. Sun altitude at VB at launch time   (suncalc)
     b. Sun altitude at launch pad           (suncalc)
     c. Great-circle distance + bearing VB → pad
     d. NWS hourly forecast for VB at launch time
     e. Build "facts dossier"
  4. One Bedrock Haiku 4.5 call per launch  →  Zod-validated verdict
       {visible, confidence: low|medium|high, reason, viewing_tip}
  5. State machine compares vs. last seen state in S3:
       new candidate / daily reminder / time slip / weather flip / scrub
  6. iMessage if appropriate. Persist updated state.
```

## Layout

```
sst.config.ts          # bucket, secrets, Lambda (with Bedrock IAM), cron
src/
  watcher.ts           # handler entrypoint + state machine
  lib/
    launches.ts        # Launch Library 2 client + types
    weather.ts         # NWS api.weather.gov client
    astronomy.ts       # suncalc + haversine + bearing
    judge.ts           # Bedrock Haiku 4.5 + Zod-validated JSON output
    sendblue.ts        # POST api.sendblue.co/api/send-message
    state.ts           # S3 state with TTL pruning
```

## Operations

```bash
bun install
bun sst deploy            # deploy to AWS
bun sst remove            # tear down (S3 bucket retained)
bun sst console           # web UI for resources/secrets/logs
bun typecheck             # tsc --noEmit
```

### Secrets

Set via SST (encrypted in SST state, injected as `Resource.X.value` at runtime):

```bash
bun sst secret set SendblueApiKey <value>
bun sst secret set SendblueApiSecret <value>
bun sst secret set SendblueFromNumber +16232843671
bun sst secret set SendblueVerifiedContact +14159186699
```

### Manual invocation

```bash
aws lambda invoke \
  --function-name <WatcherName> \
  --cli-binary-format raw-in-base64-out \
  --payload '{}' \
  /tmp/out.json && cat /tmp/out.json
```

### Inspect state

```bash
aws s3 cp s3://<WatchStateBucket>/watch-state.json - | jq
```

## Notification state machine

For each upcoming launch, the watcher computes (`newVerdict`, `newNet`,
`newForecast`) and compares against the last persisted state. Decisions:

| Old state                    | New verdict                       | Action                                |
| ---------------------------- | --------------------------------- | ------------------------------------- |
| (none)                       | visible, confidence ≥ medium      | "Possible launch view: ..."           |
| visible                      | visible, confidence ≥ medium, NET slip > 2h | "Launch time changed: ..."   |
| visible                      | visible, confidence ≥ medium, new ET day | "Reminder: launch tonight: ..." |
| visible                      | visible, confidence ≥ medium, same day | nothing (already notified)        |
| visible                      | not visible / low confidence      | "No longer a good viewing candidate"  |
| any                          | LL2 status = Hold/Failure         | "Launch scrubbed: ..."                |
| not_visible / scrubbed       | not visible / low confidence      | nothing                               |

State persists to `s3://.../watch-state.json` with a 60-day TTL prune.

## Visibility heuristics (encoded in the Bedrock system prompt)

- Cape Canaveral / Kennedy → ~1,200 km SSW of VB. **Often visible**,
  especially during civil/nautical twilight.
- Vandenberg (West Coast) → **never visible** from VB.
- Starbase / Boca Chica → ~1,800 km SW. **Generally not visible**.
- NE-bound trajectories (ISS, Starlink at high inclination) favor East
  Coast viewing; due-east or SE drops below horizon faster.
- Sun altitude at VB > 0° → daylight, not visible.
- Sun altitude < -18° → full dark, plume not illuminated, low confidence.
- Sweet spot: sun altitude at VB between -6° and -18° (twilight).

## Bedrock model

Cross-region inference profile `us.anthropic.claude-haiku-4-5-20251001-v1:0`.
The Lambda execution role is granted `bedrock:InvokeModel` on:
- `arn:aws:bedrock:us-east-1:*:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`
- `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`

Both ARNs are required because cross-region inference resolves the profile
to the underlying foundation model, and IAM checks both.

## Notes

- **Re-notify cadence**: re-fires once per ET calendar day while a launch
  remains a visible candidate. The "1 hour DST drift" of the cron means
  morning reminders arrive at 9 AM EDT in summer, 8 AM EST in winter.
- **NWS forecast horizon**: ~7 days. If a launch is further out, the
  weather field is null and the LLM correctly drops to lower confidence.
- **Retry safety**: state is persisted *after* iMessage send. A Sendblue
  outage on a given launch means the next run will re-evaluate and
  re-attempt. No double-notification because the state machine recognizes
  a launch we've already messaged about today.
