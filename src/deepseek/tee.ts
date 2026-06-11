/*
 * DeepSeek proxy — chunk bridge.
 *
 * The in-page fetch hook (installed on each account's browser page) tees the
 * streamed /chat/completion response back to Node by calling the exposed
 * __dsChunk(reqId, data) function. That lands here and is routed to the sink
 * registered for the request id. Kept dependency-free to avoid import cycles
 * between browser.ts (which exposes the function) and complete.ts (which
 * registers sinks).
 */

type Sink = (data: string) => void

const sinks = new Map<string, Sink>()

export function registerSink(reqId: string, sink: Sink): void {
  sinks.set(reqId, sink)
}

export function unregisterSink(reqId: string): void {
  sinks.delete(reqId)
}

export function pushChunk(reqId: string, data: string): void {
  sinks.get(reqId)?.(data)
}
