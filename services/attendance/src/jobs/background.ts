// HTTP 202 ends a response, not its work. Track each accepted invocation independently so
// shutdown can cancel it and keep the database open until its current operation settles.
export class BackgroundJobs {
  private readonly active = new Map<AbortController, string>();
  private stopping = false;

  start(name: string, fn: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
    if (this.stopping) {
      throw Object.assign(new Error('The service is shutting down; retry this request after it restarts.'), { status: 503 });
    }
    const abort = new AbortController();
    this.active.set(abort, name);
    return Promise.resolve().then(() => {
      abort.signal.throwIfAborted();
      return fn(abort.signal);
    }).finally(() => { this.active.delete(abort); });
  }

  stop(): void {
    this.stopping = true;
    for (const abort of this.active.keys()) abort.abort();
  }

  inFlight(): string[] {
    return [...this.active.values()];
  }
}

export const backgroundJobs = new BackgroundJobs();
