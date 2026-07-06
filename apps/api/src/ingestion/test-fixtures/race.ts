export function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })

  return { promise, reject, resolve }
}

export function createGate() {
  const entered = createDeferred<void>()
  const release = createDeferred<void>()

  return {
    entered: entered.promise,
    release: release.resolve,
    async wait() {
      entered.resolve()
      await release.promise
    },
  }
}
