/// <reference path="./.sst/platform/config.d.ts" />

// Single-environment personal automation. Once-daily check for upcoming
// SpaceX launches that might be visible from Virginia Beach. Uses Bedrock
// (Claude Haiku 4.5 cross-region inference profile) for the visibility
// judgment over deterministic launch + weather + astronomy facts.
//
// Deploy:   bun sst deploy
// Secrets:  bun sst secret set <Name> <value>
// Console:  bun sst console

const HAIKU_INFERENCE_PROFILE =
  "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const HAIKU_FOUNDATION_MODEL =
  "anthropic.claude-haiku-4-5-20251001-v1:0";

export default $config({
  app() {
    return {
      name: "spacex-flight-watcher",
      removal: "retain", // S3 state survives `sst remove`
      home: "aws",
      providers: { aws: { region: "us-east-1" } },
    };
  },

  async run() {
    // ------------------------------------------------------------------
    // Secrets — set with: bun sst secret set <Name> <value>
    // ------------------------------------------------------------------
    const sendblueApiKey = new sst.Secret("SendblueApiKey");
    const sendblueApiSecret = new sst.Secret("SendblueApiSecret");
    const sendblueFromNumber = new sst.Secret("SendblueFromNumber");
    const sendblueVerifiedContact = new sst.Secret("SendblueVerifiedContact");

    const sendblueLinks = [
      sendblueApiKey,
      sendblueApiSecret,
      sendblueFromNumber,
      sendblueVerifiedContact,
    ] as const;

    // ------------------------------------------------------------------
    // State storage — single private bucket, one key (watch-state.json).
    // ------------------------------------------------------------------
    const watchStateBucket = new sst.aws.Bucket("WatchStateBucket");

    // ------------------------------------------------------------------
    // Watcher Lambda
    //
    // Bedrock IAM: cross-region inference profiles require permission on
    // BOTH the inference-profile ARN AND every region-replicated foundation-
    // model ARN the profile fans out to. The us.* profile spans us-east-1,
    // us-east-2, us-west-2, so we wildcard the region in the foundation-
    // model ARN.
    // ------------------------------------------------------------------
    const watcher = new sst.aws.Function("Watcher", {
      handler: "src/watcher.handler",
      link: [watchStateBucket, ...sendblueLinks],
      timeout: "3 minutes", // LL2 + NWS + N×Bedrock per run
      memory: "512 MB",
      permissions: [
        {
          actions: ["bedrock:InvokeModel"],
          resources: [
            `arn:aws:bedrock:us-east-1:*:inference-profile/${HAIKU_INFERENCE_PROFILE}`,
            `arn:aws:bedrock:*::foundation-model/${HAIKU_FOUNDATION_MODEL}`,
          ],
        },
      ],
    });

    // ------------------------------------------------------------------
    // Schedule — daily 13:00 UTC = 9 AM EDT / 8 AM EST. EventBridge cron
    // expressions are UTC-only; the 1-hour DST drift is acceptable for a
    // morning reminder. Swap to aws.scheduler.Schedule if precise local
    // time is needed.
    // ------------------------------------------------------------------
    new sst.aws.Cron("WatcherSchedule", {
      schedule: "cron(0 13 * * ? *)",
      job: watcher.arn,
    });

    return {
      WatcherName: watcher.name,
      WatchStateBucket: watchStateBucket.name,
    };
  },
});
