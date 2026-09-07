/**
 * Interleaves multiple async iterables, yielding each item as soon as its
 * source produces it (not source-by-source). Completes once every source is
 * exhausted. Used by compare-mode to run providers concurrently and stream
 * their events as they arrive rather than one provider at a time.
 */
export async function* mergeAsyncIterables<T>(sources: AsyncIterable<T>[]): AsyncGenerator<T> {
  const iterators = sources.map((s) => s[Symbol.asyncIterator]())
  const pending = new Map<number, Promise<{ index: number; result: IteratorResult<T> }>>()

  iterators.forEach((it, index) => {
    pending.set(
      index,
      it.next().then((result) => ({ index, result }))
    )
  })

  while (pending.size > 0) {
    const { index, result } = await Promise.race(pending.values())
    if (result.done) {
      pending.delete(index)
    } else {
      yield result.value
      pending.set(
        index,
        iterators[index].next().then((r) => ({ index, result: r }))
      )
    }
  }
}
