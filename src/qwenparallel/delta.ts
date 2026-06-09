/*
 * Qwen parallel proxy — incremental delta helper.
 *
 * Qwen sometimes streams cumulative content (the full text so far) and sometimes
 * strict deltas. This reconstructs the new fragment either way. Copied verbatim
 * from the main route so the parallel service stays self-contained.
 */

export interface DeltaResult {
  delta: string
  matchedContent: string
}

export function getIncrementalDelta(oldStr: string, newStr: string): DeltaResult {
  if (!oldStr) {
    return { delta: newStr, matchedContent: newStr }
  }
  if (newStr === oldStr) {
    return { delta: '', matchedContent: oldStr }
  }

  // If newStr is cumulative it shares a common prefix with oldStr. Limit the
  // scan window to avoid O(n) work on very long cumulative content.
  const scanWindow = Math.min(2000, oldStr.length)
  let commonPrefixLen = 0
  const maxLen = Math.min(scanWindow, newStr.length)
  while (commonPrefixLen < maxLen && oldStr[commonPrefixLen] === newStr[commonPrefixLen]) {
    commonPrefixLen++
  }

  const threshold = Math.min(scanWindow, 4)
  if (commonPrefixLen >= threshold) {
    return { delta: newStr.substring(commonPrefixLen), matchedContent: newStr }
  }

  // Prefix check failed — treat as strictly incremental. We avoid fallback
  // overlap searches which cause false-positive corruption on repetitive code.
  return { delta: newStr, matchedContent: oldStr + newStr }
}
