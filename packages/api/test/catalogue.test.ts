import { describe, expect, it } from "vitest";
import { validateDiscoveryExtension, declareDiscoveryExtension } from "@x402/extensions";
import { PAID_ROUTES } from "../src/routes.js";
import { inputExample } from "../src/paid.js";

const schemaOf = (params: NonNullable<(typeof PAID_ROUTES)[number]["params"]>) => ({
  type: "object",
  properties: Object.fromEntries(params.map((p) => [p.name, { type: p.type, description: p.description, ...(p.example === undefined ? {} : { example: p.example }) }])),
  required: params.filter((p) => p.required).map((p) => p.name),
});

describe("what the catalogue is told about each paid route", () => {
  it("gives every required parameter an example, so the catalogue accepts the route's description", () => {
    for (const r of PAID_ROUTES.filter((x) => x.params?.length)) {
      const ext = declareDiscoveryExtension({ input: inputExample(r.params!), inputSchema: schemaOf(r.params!) }) as { bazaar: { info: { input: Record<string, unknown> } } };
      // The server fills in the method when it mounts the route; the routes are all GETs.
      ext.bazaar.info.input.method = "GET";
      const v = validateDiscoveryExtension(ext.bazaar as never);
      expect(v.valid, `${r.path}: ${JSON.stringify(v.errors ?? [])}`).toBe(true);
    }
  });
});
