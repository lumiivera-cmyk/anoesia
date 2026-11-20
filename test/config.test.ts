import { expect, test } from "bun:test";
import { envText, loadConfig, vertexLocation } from "../src/config.ts";

const base = { GOOGLE_APPLICATION_CREDENTIALS: "gcp-key.json", GOOGLE_CLOUD_PROJECT: "my-project" };

test("global uses the address without a region", () => {
  const { vertex } = loadConfig({ ...base, GOOGLE_CLOUD_LOCATION: "global" });
  expect(vertex.baseUrl).toBe("https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/endpoints/openapi");
});

test("a region gets its own address", () => {
  const { vertex } = loadConfig({ ...base, GOOGLE_CLOUD_LOCATION: "us-central1" });
  expect(vertex.baseUrl).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/my-project/locations/us-central1/endpoints/openapi");
});

test("stray quotes left in .env values are dropped", () => {
  const { vertex } = loadConfig({
    GOOGLE_APPLICATION_CREDENTIALS: '"gcp-key.json',
    GOOGLE_CLOUD_PROJECT: "my-project'",
    GOOGLE_CLOUD_LOCATION: 'global"',
  });
  expect(vertex.baseUrl).toBe("https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/endpoints/openapi");
  expect(vertex.keyFile.endsWith("/gcp-key.json")).toBe(true);
  expect(envText(' "us-east5" ')).toBe("us-east5");
});

test("a location that can't be one falls back to global", () => {
  expect(vertexLocation(undefined)).toBe("global");
  expect(vertexLocation("US-Central1")).toBe("us-central1");
  expect(vertexLocation("global # main")).toBe("global");
});
