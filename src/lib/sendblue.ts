import { Resource } from "sst";

const ENDPOINT = "https://api.sendblue.co/api/send-message";

export async function sendImessage(content: string): Promise<void> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "sb-api-key-id": Resource.SendblueApiKey.value,
      "sb-api-secret-key": Resource.SendblueApiSecret.value,
    },
    body: JSON.stringify({
      number: Resource.SendblueVerifiedContact.value,
      from_number: Resource.SendblueFromNumber.value,
      content,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Sendblue ${res.status}: ${await res.text()}`);
  }
}
