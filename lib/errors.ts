/** Expected request failures, safe to explain to the client. */
export class HttpError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
