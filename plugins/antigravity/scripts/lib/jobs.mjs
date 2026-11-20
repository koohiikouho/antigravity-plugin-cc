// Background job state for the Antigravity companion.
// One directory per job under jobsRoot():
//   meta.json + input.ndjson (prompt, fed on stdin) + output.txt (stream-json
//   NDJSON) + err.txt (stderr) + agy.log

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { jobsRoot, jobDir } from "./paths.mjs";
import { readLogSafe, interpretRun, killTree } from "./agy.mjs";

function nowIso() {
  return new Date().toISOString();
}

export function newJobId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `agy-${ts}-${rand}`;
}

export function jobPaths(id, env = process.env) {
  const dir = jobDir(id, env);
  return {
    dir,
    meta: join(dir, "meta.json"),
    input: join(dir, "input.ndjson"),
    output: join(dir, "output.txt"),
    err: join(dir, "err.txt"),
    log: join(dir, "agy.log"),
  };
}

export function createJob(meta, env = process.env) {
  const id = meta.id || newJobId();
  const paths = jobPaths(id, env);
  mkdirSync(paths.dir, { recursive: true });
  const record = {
    id,
    kind: meta.kind || "delegate",
    title: meta.title || "",
    prompt: meta.prompt || "",
    cwd: meta.cwd || process.cwd(),
    status: meta.status || "running",
    pid: meta.pid ?? null,
    conversationId: meta.conversationId ?? null,
    startedAt: meta.startedAt || nowIso(),
    finishedAt: meta.finishedAt ?? null,
    error: meta.error ?? null,
    errorKind: meta.errorKind ?? null,
    denial: meta.denial ?? null,
    deadline: meta.deadline ?? null,
    paths,
  };
  writeFileSync(paths.meta, JSON.stringify(record, null, 2));
  return record;
}

export function writeJob(job) {
  writeFileSync(job.paths.meta, JSON.stringify(job, null, 2));
  return job;
}

export function readJob(id, env = process.env) {
  const paths = jobPaths(id, env);
  if (!existsSync(paths.meta)) return null;
  try {
    const job = JSON.parse(readFileSync(paths.meta, "utf8"));
    job.paths = paths; // always recompute absolute paths
    return job;
  } catch {
    return null;
  }
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours
  }
}

/**
 * Interpret a finished job's files (stream-json stdout, stderr, agy log) and
 * persist a terminal status on the job record.
 */
export function finalizeJob(job, { timedOut = false } = {}) {
  const outcome = interpretRun({
    stdout: readLogSafe(job.paths.output),
    stderr: readLogSafe(job.paths.err),
    logText: readLogSafe(job.paths.log),
    code: null,
    timedOut,
  });
  job.finishedAt = job.finishedAt || nowIso();
  job.conversationId = outcome.conversationId || job.conversationId;
  job.status = outcome.ok ? "done" : "failed";
  job.error = outcome.error
    ? outcome.error.message + (outcome.error.resetsIn ? ` (resets in ${outcome.error.resetsIn})` : "")
    : null;
  job.errorKind = outcome.error?.kind || null;
  job.denial = outcome.denial || null;
  writeJob(job);
  return outcome;
}

/**
 * Reconcile a job's recorded status with reality. A running job past its
 * deadline (print timeout + grace) is killed and marked failed; a running job
 * whose process is gone is finalized from its output.
 */
export function reconcile(job) {
  if (!job) return job;
  if (job.status !== "running") return job;
  if (isAlive(job.pid)) {
    if (job.deadline && Date.now() > Date.parse(job.deadline)) {
      killTree(job.pid);
      finalizeJob(job, { timedOut: true });
    }
    return job;
  }
  finalizeJob(job);
  return job;
}

export function listJobs(cwd, env = process.env) {
  const root = jobsRoot(env);
  if (!existsSync(root)) return [];
  const jobs = [];
  for (const name of readdirSync(root)) {
    const job = readJob(name, env);
    if (!job) continue;
    reconcile(job);
    if (cwd && job.cwd !== cwd) continue;
    jobs.push(job);
  }
  jobs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return jobs;
}

export function latestJob(cwd, env = process.env) {
  return listJobs(cwd, env)[0] || null;
}

export function cancelJob(job) {
  if (!job) return { cancelled: false, reason: "not found" };
  if (job.status !== "running") return { cancelled: false, reason: `job is ${job.status}` };
  if (!isAlive(job.pid)) {
    job.status = "failed";
    job.finishedAt = nowIso();
    job.error = "process exited before cancel";
    writeJob(job);
    return { cancelled: false, reason: "process already exited" };
  }
  killTree(job.pid);
  job.status = "cancelled";
  job.finishedAt = nowIso();
  writeJob(job);
  return { cancelled: true };
}

export { nowIso };
