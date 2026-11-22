/**
 * Lightweight line-level diff for comparing a dream proposal against the
 * memory it would supersede.
 *
 * Pure TypeScript with zero runtime dependencies. Inputs larger than the LCS
 * cap fall back to a simple old-removed / new-added pair so very long bodies
 * never stall the Settings thread.
 * @module dsh-memory/client/diff
 */

/** One line in a computed diff. */
export interface DiffLine {
  kind: 'same' | 'add' | 'remove'
  text: string
}

const MAX_LCS_CELLS = 40_000

/**
 * Compute a line-by-line diff between `before` and `after`.
 * @param before - Existing memory body.
 * @param after - Proposed memory body.
 * @returns Ordered diff lines.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const left = before === '' ? [] : before.split(/\r?\n/)
  const right = after === '' ? [] : after.split(/\r?\n/)
  if (left.length === 0 && right.length === 0) return []
  if (left.length * right.length > MAX_LCS_CELLS) {
    return [
      ...left.map((text): DiffLine => ({ kind: 'remove', text })),
      ...right.map((text): DiffLine => ({ kind: 'add', text })),
    ]
  }

  const rows = left.length + 1
  const cols = right.length + 1
  const table = new Uint16Array(rows * cols)
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      if (left[i] === right[j]) {
        table[i * cols + j] = (table[(i + 1) * cols + (j + 1)] ?? 0) + 1
      } else {
        const down = table[(i + 1) * cols + j] ?? 0
        const across = table[i * cols + (j + 1)] ?? 0
        table[i * cols + j] = down >= across ? down : across
      }
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      out.push({ kind: 'same', text: left[i]! })
      i += 1
      j += 1
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + (j + 1)] ?? 0)) {
      out.push({ kind: 'remove', text: left[i]! })
      i += 1
    } else {
      out.push({ kind: 'add', text: right[j]! })
      j += 1
    }
  }
  while (i < left.length) {
    out.push({ kind: 'remove', text: left[i]! })
    i += 1
  }
  while (j < right.length) {
    out.push({ kind: 'add', text: right[j]! })
    j += 1
  }
  return out
}
