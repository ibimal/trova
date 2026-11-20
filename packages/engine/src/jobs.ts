// Background jobs: one runs at a time, at the lowest priority. A job waits between units of work
// while an interactive request is in flight or indexing is paused.

import type { EngineEvent, JobInfo, JobKind } from "@trova/contract";
import type { Sidecar } from "./sidecar.js";

export interface JobCtx {
  info: JobInfo;
  cancelled(): boolean;
  progress(done: number, total: number, extra?: Record<string, unknown>): void;
  /** Resolves when no interactive request is running and indexing is not paused. */
  pause(): Promise<void>;
}

interface Queued {
  info: JobInfo;
  key: string;
  cancel: boolean;
  run: (ctx: JobCtx) => Promise<void>;
}

export class Jobs {
  private seq = 0;
  private all = new Map<string, Queued>();
  private queue: Queued[] = [];
  private current: Queued | null = null;
  private interactive = 0;
  private lastEmit = 0;
  paused = false;

  constructor(
    private sidecar: Sidecar,
    private emit: (e: EngineEvent) => void,
  ) {}

  enqueue(kind: JobKind, key: string, run: (ctx: JobCtx) => Promise<void>): string {
    const queued = this.queue.find((j) => j.key === key && !j.cancel);
    if (queued) return queued.info.jobId;
    const jobId = `j_${String(++this.seq).padStart(2, "0")}`;
    const job: Queued = { info: { jobId, kind, state: "queued", done: 0, total: 0 }, key, cancel: false, run };
    this.all.set(jobId, job);
    this.queue.push(job);
    this.sidecar.saveJob(job.info);
    queueMicrotask(() => void this.pump());
    return jobId;
  }

  private async pump(): Promise<void> {
    if (this.current || this.paused) return;
    const job = this.queue.shift();
    if (!job) return;
    if (job.cancel) return void this.pump();
    this.current = job;
    job.info.state = "running";
    job.info.started = Date.now();
    this.sidecar.saveJob(job.info);
    const ctx: JobCtx = {
      info: job.info,
      cancelled: () => job.cancel,
      progress: (done, total, extra) => {
        job.info.done = done;
        job.info.total = total;
        const now = Date.now();
        if (now - this.lastEmit < 100 && done < total) return;
        this.lastEmit = now;
        this.emit({ event: "index.progress", data: { jobId: job.info.jobId, kind: job.info.kind, done, total, ...extra } });
      },
      pause: () => this.idle(job),
    };
    try {
      await job.run(ctx);
      job.info.state = job.cancel ? "cancelled" : "done";
    } catch (err) {
      job.info.state = "failed";
      job.info.error = (err as Error).message;
      this.emit({ event: "engine.state", data: { state: "error", message: job.info.error, jobId: job.info.jobId } });
    }
    job.info.finished = Date.now();
    this.sidecar.saveJob(job.info);
    this.current = null;
    // Keep only the most recent finished jobs in memory.
    const finished = [...this.all.values()].filter((j) => j.info.finished);
    for (const old of finished.slice(0, Math.max(0, finished.length - 20))) this.all.delete(old.info.jobId);
    void this.pump();
  }

  private async idle(job: Queued): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
    while ((this.interactive > 0 || this.paused) && !job.cancel) {
      if (this.paused && job.info.state === "running") job.info.state = "paused";
      await new Promise<void>((r) => setTimeout(r, 25));
    }
    if (job.info.state === "paused") job.info.state = "running";
  }

  /** Marks an interactive request as in flight, so background work yields to it. */
  async interactiveCall<T>(fn: () => Promise<T>): Promise<T> {
    this.interactive++;
    try {
      return await fn();
    } finally {
      this.interactive--;
    }
  }

  beginInteractive(): () => void {
    this.interactive++;
    let ended = false;
    return () => {
      if (!ended) {
        ended = true;
        this.interactive--;
      }
    };
  }

  cancel(jobId: string): boolean {
    const job = this.all.get(jobId);
    if (!job) return false;
    job.cancel = true;
    if (job.info.state === "queued") {
      job.info.state = "cancelled";
      job.info.finished = Date.now();
      this.sidecar.saveJob(job.info);
    }
    return true;
  }

  pause(): void {
    this.paused = true;
    this.emit({ event: "engine.state", data: { state: "paused" } });
  }

  resume(): void {
    this.paused = false;
    this.emit({ event: "engine.state", data: { state: "running" } });
    void this.pump();
  }

  get(jobId: string): JobInfo | undefined {
    return this.all.get(jobId)?.info;
  }

  /** Queued, running and paused jobs. */
  active(): JobInfo[] {
    return [...this.all.values()].map((j) => j.info).filter((j) => j.state === "queued" || j.state === "running" || j.state === "paused");
  }

  list(): JobInfo[] {
    return [...this.all.values()].map((j) => ({ ...j.info }));
  }

  /** Resolves when no job is queued or running. Used by the CLI and by tests. */
  async drain(): Promise<void> {
    while (this.current || this.queue.some((j) => !j.cancel)) await new Promise<void>((r) => setTimeout(r, 10));
  }
}
