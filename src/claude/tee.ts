/*
 * Claude proxy - chunk bridge.
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
