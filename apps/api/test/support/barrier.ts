/**
 * A single-use rendezvous barrier.
 *
 * `arriveAndWait()` resolves for every participant only once `parties` of them
 * have arrived. Used to pin concurrency tests to a known interleaving: placing a
 * barrier between a transaction's read and its write guarantees that *all*
 * participants have read before *any* of them writes.
 *
 * Why this rather than a sleep: `setTimeout(50)` is a guess about the scheduler,
 * so it gives a test that reproduces a race most of the time. A barrier makes
 * the interleaving a fact, and turns the assertion into one about the structure
 * of the code under test.
 *
 * Why this rather than `Promise.all` of the reads followed by `Promise.all` of
 * the writes: that would restructure the code under test out of existence. The
 * production code path has to be the thing running.
 */
export class Barrier {
  readonly parties: number;

  #arrived = 0;
  #release!: () => void;
  #reject!: (reason: Error) => void;
  readonly #gate: Promise<void>;

  constructor(parties: number) {
    if (!Number.isInteger(parties) || parties < 1) {
      throw new RangeError(`barrier needs at least 1 party, got ${String(parties)}`);
    }

    this.parties = parties;
    this.#gate = new Promise<void>((resolve, reject) => {
      this.#release = resolve;
      this.#reject = reject;
    });

    // Nothing is awaiting the gate yet, and a rejection before then would be an
    // unhandled rejection. Attaching a no-op catch keeps `abort()` safe to call
    // at any point.
    this.#gate.catch(() => undefined);
  }

  get arrived(): number {
    return this.#arrived;
  }

  async arriveAndWait(): Promise<void> {
    this.#arrived += 1;

    if (this.#arrived > this.parties) {
      throw new Error(
        `barrier over-subscribed: ${String(this.#arrived)} arrivals for ${String(this.parties)} parties`,
      );
    }

    if (this.#arrived === this.parties) {
      this.#release();
    }

    return this.#gate;
  }

  /**
   * Release everyone with an error. Without this, one participant failing before
   * it reaches the barrier leaves the rest awaiting forever and the test fails
   * by timeout rather than by the real cause.
   */
  abort(reason: Error): void {
    this.#reject(reason);
  }
}
