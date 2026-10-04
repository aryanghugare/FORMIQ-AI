import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { allowedWriteOrigin } from "../lib/request-origin";

test("write origins support Docker hosts and HTTPS proxies while rejecting unrelated sites", () => {
  const savedApp = process.env.FORMIQ_APP_URL;
  const savedRender = process.env.RENDER_EXTERNAL_URL;
  delete process.env.FORMIQ_APP_URL;
  delete process.env.RENDER_EXTERNAL_URL;
  const check = (headers: Record<string, string>) =>
    allowedWriteOrigin(
      new NextRequest("http://0.0.0.0:3000/api/drawings", { headers }),
    );
  try {
    assert.equal(
      check({ host: "localhost:3000", origin: "http://localhost:3000" }),
      true,
    );
    assert.equal(
      check({ host: "localhost:3000", origin: "http://evil.example" }),
      false,
    );
    assert.equal(
      check({ host: "localhost:3000", origin: "http://localhost:3001" }),
      false,
    );
    assert.equal(check({ host: "localhost:3000", origin: "null" }), false);
    assert.equal(
      check({
        host: "localhost:3000",
        origin: "https://evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      }),
      false,
    );
    assert.equal(
      check({
        host: "formiq.example",
        origin: "https://formiq.example",
        "x-forwarded-proto": "https",
      }),
      true,
    );
    process.env.FORMIQ_APP_URL = "https://formiq.example";
    assert.equal(
      check({ host: "internal:3000", origin: "https://formiq.example" }),
      true,
    );
    assert.equal(
      check({
        host: "evil.example",
        origin: "https://evil.example",
        "x-forwarded-proto": "https",
      }),
      false,
    );
    assert.equal(
      check({ host: "formiq.example", origin: "http://formiq.example" }),
      false,
    );
  } finally {
    if (savedApp === undefined) delete process.env.FORMIQ_APP_URL;
    else process.env.FORMIQ_APP_URL = savedApp;
    if (savedRender === undefined) delete process.env.RENDER_EXTERNAL_URL;
    else process.env.RENDER_EXTERNAL_URL = savedRender;
  }
});
