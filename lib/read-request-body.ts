import "server-only";

export class RequestBodyTooLarge extends Error {}

export const MAX_NOTE_REQUEST_BYTES = 32 * 1024;

export function readRequestBody(request: Request, maxBytes: number) {
  if (Number(request.headers.get("Content-Length")) > maxBytes) {
    throw new RequestBodyTooLarge();
  }

  let bytes = 0;
  const body = request.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new RequestBodyTooLarge();
      controller.enqueue(chunk);
    },
  }));
  const contentType = request.headers.get("Content-Type");
  return new Response(body, { headers: contentType ? { "Content-Type": contentType } : {} });
}
