// A sign-in the engine server runs with no session (`provider.login`): the TUI opens its popup at once and polls it.
// Requests on one connection are answered in turn, so a login is started, read and answered by separate calls, never
// held open by one.

import { randomUUID } from "node:crypto";
import { type LoginRuntime, openAuthUrl, runLoginFlow } from "../credentials/login-flow.js";
import type { LykosModelRuntimeOptions } from "../session/model-runtime.js";

export interface LoginStatus {
  /** What the sign-in said so far: the URL it opened, its instructions, the stored credential or the failure. */
  lines: string[];
  /** The question it waits on, if any. */
  ask?: { prompt: string; secret: boolean };
  /** Set once it has finished. */
  done?: { ok: boolean };
}

interface Job {
  status: LoginStatus;
  answer?: (value: string | undefined) => void;
}

export interface LoginJobsOptions {
  dbPath: () => string;
  openBrowser?: (url: string) => void;
  createRuntime?: (opts: LykosModelRuntimeOptions) => Promise<LoginRuntime>;
}

export class LoginJobs {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly opts: LoginJobsOptions) {}

  /** Starts `provider`'s browser sign-in, or its API key question when `apiKey`; returns its id. */
  start(provider: string, apiKey: boolean): string {
    const id = randomUUID();
    const job: Job = { status: { lines: [] } };
    this.jobs.set(id, job);
    const say = (line: string): void => {
      job.status.lines.push(...line.split("\n"));
    };
    void runLoginFlow(
      provider,
      apiKey,
      {
        dbPath: this.opts.dbPath(),
        out: say,
        err: say,
        ask: (q) =>
          new Promise<string | undefined>((resolve) => {
            job.status.ask = { prompt: q.prompt, secret: q.secret };
            job.answer = (value) => {
              delete job.status.ask;
              delete job.answer;
              resolve(value);
            };
          }),
        openBrowser: this.opts.openBrowser ?? openAuthUrl,
        // The model runtime loads only when a sign-in needs it, so the server starts without it.
        createRuntime: this.opts.createRuntime ?? (async (o) => (await import("../session/model-runtime.js")).createLykosModelRuntime(o)),
      },
      { command: "/login" },
    ).then(
      (code) => {
        job.status.done = { ok: code === 0 };
      },
      (err: unknown) => {
        say(`lykos login: ${err instanceof Error ? err.message : String(err)}`);
        job.status.done = { ok: false };
      },
    );
    return id;
  }

  status(id: string): LoginStatus {
    const job = this.jobs.get(id);
    if (job === undefined) throw new Error(`no sign-in ${id}`);
    if (job.status.done !== undefined) this.jobs.delete(id);
    return job.status;
  }

  answer(id: string, value: string): void {
    const job = this.jobs.get(id);
    if (job?.answer === undefined) throw new Error(`sign-in ${id} is not asking anything`);
    job.answer(value);
  }

  /** Ends a sign-in: its open question gets no answer, so the flow stops there, and its status is forgotten. */
  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (job === undefined) return;
    this.jobs.delete(id);
    job.answer?.(undefined);
  }
}
