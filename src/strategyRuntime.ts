import type { StrategyContext } from './strategy';

type WorkerResponse = { id: number; ok: true; result: unknown; durationMs: number } | { id: number; ok: false; error: string; durationMs: number };

export class PythonStrategyRunner {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: WorkerResponse) => void; reject: (reason: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL('./strategyWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      pending.resolve(event.data);
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'Python strategy worker failed.');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
  }

  run(code: string, context: StrategyContext): Promise<WorkerResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error('Strategy exceeded the 15 second execution limit.'));
      }, 15_000);
      this.pending.set(id, {
        resolve: (value) => { window.clearTimeout(timeout); resolve(value); },
        reject: (error) => { window.clearTimeout(timeout); reject(error); },
      });
      this.worker.postMessage({ type: 'run', id, code, context });
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error('Strategy runner was stopped.'));
    this.pending.clear();
  }
}
