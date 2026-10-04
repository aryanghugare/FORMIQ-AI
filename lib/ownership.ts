import { AsyncLocalStorage } from "node:async_hooks";
import { HttpError } from "./errors";

const owners = new AsyncLocalStorage<string>();
export function withOwner<T>(userId: string, work: () => T): T {
  return owners.run(userId, work);
}
export function ownerId(): string {
  const id = owners.getStore();
  if (!id) throw new HttpError("Please sign in to continue.", 401);
  return id;
}
