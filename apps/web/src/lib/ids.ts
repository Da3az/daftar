/** Client-chosen ids: 8–64 URL-safe characters, unique per participant. */
export const newClientId = (): string => `web-${crypto.randomUUID()}`;

/** "3f6c2c1e9b" → "3f6c2 c1e9b" for reading aloud; anything else is shown as given. */
export const groupHandle = (handle: string): string =>
  /^[0-9a-f]{10}$/.test(handle) ? `${handle.slice(0, 5)} ${handle.slice(5)}` : handle;

export const HANDLE_PATTERN = /^[0-9a-f]{10}$/;
