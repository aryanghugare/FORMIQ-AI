import { HttpError } from "./errors";
/** Limit bytes as they arrive, including chunked requests without Content-Length. */
export async function readLimitedBody(
  request: Request,
  limit: number,
): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) throw new HttpError("Request body is too large.", 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new HttpError("Request body is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
export async function readJson(request: Request): Promise<unknown> {
  const bytes = await readLimitedBody(request, 65536);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError("Invalid JSON request.");
  }
}
export async function readMultipart(request: Request): Promise<FormData> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("multipart/form-data")
  ) {
    throw new HttpError("Upload drawings using multipart/form-data.", 415);
  }
  const bytes = await readLimitedBody(request, 31 * 1024 * 1024);
  try {
    return await new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": request.headers.get("content-type")! },
      body: bytes as BodyInit,
    }).formData();
  } catch {
    throw new HttpError("Invalid multipart upload.");
  }
}
