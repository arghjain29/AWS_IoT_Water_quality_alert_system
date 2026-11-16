// Small helpers used by both Lambda functions: DynamoDB access and time handling.
// The AWS SDK v3 is already included in the Lambda Node.js runtime, so nothing is bundled.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Table names come from environment variables set by Terraform.
export const tables = {
  get readings() { return process.env.READINGS_TABLE ?? "WaterReadings"; },
  get alerts() { return process.env.ALERTS_TABLE ?? "WaterAlerts"; },
  get registry() { return process.env.REGISTRY_TABLE ?? "DeviceRegistry"; },
  get aggregates() { return process.env.AGGREGATES_TABLE ?? "WaterReadingAggregates"; },
};

let documentClient;

// The "document client" lets us read/write plain JS objects instead of DynamoDB's typed JSON.
export function db() {
  if (!documentClient) {
    // DYNAMODB_ENDPOINT is only set by the tests (in-memory fake DynamoDB).
    const local = process.env.DYNAMODB_ENDPOINT;
    const client = new DynamoDBClient(local
      ? { endpoint: local, region: "local", credentials: { accessKeyId: "test", secretAccessKey: "test" } }
      : {});
    documentClient = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }
  return documentClient;
}

export function resetDb() {
  documentClient = undefined;
}

// "now" is replaceable so tests can move time forward.
export const clock = { now: () => new Date() };

// ---- time: always ISO-8601 UTC like 2026-11-16T10:00:00.123Z ---------------
export function iso(date) {
  return date.toISOString();
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export function parseIso(text) {
  if (typeof text !== "string" || !ISO_WITH_ZONE.test(text)) {
    throw new Error("timestamp must be ISO-8601 with a timezone, e.g. 2026-11-16T10:00:00Z");
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error("invalid timestamp");
  return date;
}

export const addSeconds = (date, seconds) => new Date(date.getTime() + seconds * 1000);

export function log(level, message, extra = {}) {
  // One JSON object per line: easy to search in CloudWatch Logs (and used by the
  // CloudWatch dashboard). level/message go last so extra fields can't overwrite them.
  console.log(JSON.stringify({ ...extra, level, message }));
}
