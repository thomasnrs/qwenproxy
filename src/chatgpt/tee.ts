/*
 * ChatGPT proxy — chunk bridge.
 *
 * The in-page hook tees the streamed /backend-api/conversation response back to
 * Node by calling the exposed __cgChunk(accountId, data). It is routed here to
 * the sink registered for that account. Dependency-free to avoid import cycles.
 */

type Sink = (data: string) => void

const sinks = new Map<string, Sink>()

export function registerSink(accountId: string, sink: Sink): void {
  sinks.set(accountId, sink)
}

export function unregisterSink(accountId: string): void {
  sinks.delete(accountId)
}

export function pushChunk(accountId: string, data: string): void {
  sinks.get(accountId)?.(data)
}
