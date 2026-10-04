import { test } from "node:test";
import assert from "node:assert/strict";
import { readLimitedBody, readMultipart, readJson } from "../lib/request-body";
import { HttpError } from "../lib/errors";
function streamed(total: number) {
  let pulls = 0,
    cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls > total) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://localhost/upload", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
  return { request, state: () => ({ pulls, cancelled }) };
}
test("chunked oversized body is cancelled before the full request is buffered", async () => {
  const { request, state } = streamed(10000);
  await assert.rejects(
    readLimitedBody(request, 2048),
    (e) => e instanceof HttpError && e.status === 413,
  );
  assert.ok(state().cancelled);
  assert.ok(state().pulls < 10);
});
test("Content-Length cannot conceal an oversized stream", async () => {
  const { request } = streamed(20);
  request.headers.set("content-length", "1");
  await assert.rejects(
    readLimitedBody(request, 2048),
    (e) => e instanceof HttpError && e.status === 413,
  );
});
test("invalid JSON and multipart uploads return client errors", async () => {
  await assert.rejects(
    readJson(
      new Request("http://localhost", { method: "POST", body: "invalid" }),
    ),
    (e) => e instanceof HttpError && e.status === 400,
  );
  await assert.rejects(
    readMultipart(
      new Request("http://localhost", { method: "POST", body: "invalid" }),
    ),
    (e) => e instanceof HttpError && e.status === 415,
  );
  await assert.rejects(
    readMultipart(
      new Request("http://localhost", {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=x" },
        body: "invalid",
      }),
    ),
    (e) => e instanceof HttpError && e.status === 400,
  );
});
