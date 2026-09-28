// Runs the zonemapdb queries off the main thread. Each search unpacks and parses one or more
// data blocks of a few MB of JSON; on the main thread that froze typing for ~300 ms.
import { format, search, totalAddresses, useBasePath } from "./search";

// search-client.ts names the worker after the page's base URL.
useBasePath(new URL("blockdb", self.name).href);

export type Request = { id: number; kind: "search"; input: string } | { id: number; kind: "total" };
export type Response =
  | { id: number; ok: true; value: string[] | number | null }
  | { id: number; ok: false; error: string };

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  try {
    const value =
      data.kind === "total"
        ? await totalAddresses()
        : ((await search(data.input))?.map(format) ?? null);
    self.postMessage({ id: data.id, ok: true, value } satisfies Response);
  } catch (e) {
    self.postMessage({ id: data.id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies Response);
  }
};
