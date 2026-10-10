---
description: "The one-shot zcode CLI subagent provider for users and maintainers delegating background coding tasks to the local ZCode CLI, with follow-up rounds and a process-level concurrency cap."
kind: "package-bundle"
---

# Agent Hub

> **⚠️ Face A deprecated.** The live product path is **Face B swarm** (`swarm_*` tools, `npm run start`, board at `:3000`). Follow **[DEMO.md](./DEMO.md)**. Paths in this README about `zcode_dispatch` / provider / `ctx.zcodeJobs` are obsolete Face A docs kept for archaeology only.

**Product:** Agent Hub (`agent-hub`). Live path = Face B swarm board (`npm run start` / `npm run restart`). This README's install/provider sections below remain Face A archaeology.


English | [中文](README.zh.md)

## Summary

Install `@deepseek-ai/dsh-subagent-zcode` into a Profile when delegated work should run in a real ZCode CLI process. Each dispatch spawns the local `zcode` binary headless (`-p "<task>" --json --cwd <dir>`) in the session's workspace and records the session id, trace, and token usage on `ctx.zcodeJobs`. Dispatches default to foreground; `run_in_background` makes one a kind-`zcode` background job the model collects with `job_output`, stops with `job_kill`, and continues with `zcode_followup` (`zcode --resume`). An optional `ticket` identifier threads through records, notices, and the `zcode_roster` tool. A cwd whitelist and a concurrency cap fence every dispatch; completion notices return to the owning session.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)
- [Source and build context](#source-and-build-context)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider when a delegation should run as a genuine ZCode CLI process with its own model account and auth. The zcode CLI stores its own credentials under `~/.zcode`; this package never handles them.

### Installing the Bundle

Add the package's patch row to the Profile composition (or install it with `dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-zcode`). The row registers the `zcode` provider, the `zcodeJobs` index service, and the `zcode_dispatch` tool. Loading the package requires `@deepseek-ai/dsh-jobs` (a registry implementation such as `@deepseek-ai/dsh-jobs-local`), the subprocess seam, the tool registry, and the subagent service in the same composition.

### Configuration

Every deployment-owned choice is a validated Config field; there are no hidden defaults in the runtime.

| Field | Default | Contract |
| --- | --- | --- |
| `zcodeCliPath` | none — required | Absolute path of the zcode CLI entry script. Load rejects a missing or non-executable file. |
| `builtinProviderConfigPath` | derived from `zcodeCliPath` | Path of the CLI's builtin provider config, injected into every child environment as `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`. Omission derives the App packaging path (`<dirname(zcodeCliPath)>/../config/provider/zcode-builtin.json`) and injects it only when that file exists, so a layout the CLI's own script-relative lookup already covers forwards nothing. An explicitly configured path must be a readable file; load rejects one that is not. |
| `taskRoots` | `[process.cwd()]` | cwd whitelist: a dispatch's resolved task directory must be a root or inside one; an empty array is rejected. |
| `maxConcurrent` | `2` | Process-level cap on live zcode child processes, foreground runs and follow-up rounds included; over the cap the tool refuses with the active count instead of queueing. |
| `defaultMode` | `edit` | Passed as `--mode` on every dispatch. The CLI's `-p` default is `yolo`; this default deliberately de-escalates it. |
| `disallowedTools` | `[]` | Whole tools removed from the child, comma-joined into `--disallowed-tools`. |
| `completionDelivery` | `followup` | `followup` opens a turn on an idle owner; `quiet` leaves the notice pending. A busy owner is injected either way. |
| `maxConsecutiveWakes` | unbounded | Turns one owner may have opened by zcode completion wakes before the next notice degrades to injection; reset by user-authored input. |
| `expectedProviderIds` | `['account:bigmodel-start-plan', 'account:bigmodel-individual-coding-plan', 'new-provider']` | Accepted `provider_id` values of the newest billing row: the CLI bills the plan the account holds — the Start plan while its day pool has capacity, the individual coding plan measured 2026-10-08 — and falls back to `new-provider` once a pool drains, so the default covers every measured steady state; a row outside the set refuses dispatch (see Failure and recovery). |

### Exposing the tool

The package registers `zcode_dispatch` itself — no separate delegation-tool row is required. Give the model background collection with `@deepseek-ai/dsh-tool-jobs` (`job_output`, `job_list`, `job_kill`), which also delivers the completion notices. A tool-subagent row targeting provider `zcode` works too, for foreground-only compositions.

### What you get

- One-shot dispatch with the parsed headless facts: final response in the foreground, or `{ kind: 'background', jobId }` plus a completion notice carrying the zcode session id and usage summary.
- `zcode_followup` (`zcode_session_id`, `prompt`) starts a `--resume` round as a new kind-`zcode` job; zcode sessions persist under `~/.zcode`, so the id from a `tool/result` survives a dsh restart.
- `zcode_roster` lists every task this process started — ticket id, round, status, zcode session id, tokens, timing — the leader's one-call view of the whole task roster.
- Both dispatch and follow-up accept an optional `ticket` identifier (e.g. `T3`); it is carried into the job record, the completion notice (`zcode ticket T3 — task <jobId> …`), and roster rows.
- `ctx.zcodeJobs` — the process-local task records and the concurrency ledger, for panels and observers.
- Full stdout of a settled run is the job's one-shot `job_output` result; stderr streams into the job's output ring while the task runs.

### Failure and recovery

Load fails loud on a missing or non-executable `zcodeCliPath`, an unreadable `builtinProviderConfigPath`, an empty `taskRoots`, or out-of-range numeric fields. A dispatch outside every `taskRoot` or beyond `maxConcurrent` returns a tool error naming the offending value. A non-zero CLI exit settles the job `failed` with the exit code and stderr tail; a killed job records `killed` and still notifies. When the billing database's newest row reports a `provider_id` outside `expectedProviderIds`, dispatch refuses with probe-closure guidance (see [Source and build context](#source-and-build-context)).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Design and source map</summary>

`src/config.ts` validates the deployment contract once at load. `src/run.ts` owns one CLI lifecycle: build argv, spawn through `ctx.subprocess` with collected stdout/stderr, require a zero exit plus a strictly parsed JSON object, and publish the standard never-rejecting run handle (`settleRunResult` + `subprocessRunHandle` from the subagent seam). `src/provider.ts` exposes that lifecycle as the `zcode` SubagentProvider; `src/tools.ts` registers `zcode_dispatch`, which starts kind-`zcode` jobs and maps settled runs onto job outcomes and `ctx.zcodeJobs` records. `src/cli.ts` is the verified CLI surface: argv assembly (resume first, comma-joined tool removals so a variadic flag cannot swallow `--cwd`) and strict stdout parsing.

No runtime invariant companion is published because the owned relationships — one live child per claimed slot, one record per background job, one settlement per record — are asserted only inside this package, so no independent observation of them can diverge.

</details>

<a id="model-experience"></a>
## Model Experience

### Child request

#### What the model sees

The zcode child receives the joined `-p` text as one headless turn in a fresh CLI process. Its workspace is the resolved task directory; this provider instance fixes `--mode` and `--disallowed-tools`, while zcode's own `~/.zcode` state owns auth, model, and every other product setting. There is no continuable child.

#### Token effect

The child pays for an independent zcode context and turn. Child tokens do not enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. A `--resume` round reuses zcode's own provider prefix cache, not the harness's.

### Parent scheduling and results

#### What the model sees

A foreground `zcode_dispatch` call returns the final response together with the zcode session id, or an error carrying the stop reason and a bounded exit-code/stderr diagnostic for a non-completed run. A background call returns a Job id; the generic job controls later deliver a completion notice carrying the zcode session id and usage summary, expose the full headless stdout through `job_output`, and let `job_kill` request cancellation. Live CLI stderr and stdout stream into the job's output ring; commentary, tool activity, and protocol payloads never enter the parent Session by other paths.

#### Token effect

Foreground input grows by the final response or error. Background input also includes the start acknowledgement, the completion notice, and any `job_output` or `job_kill` results; child tokens still do not enter the parent context.

#### KV Cache effect

Append-only: foreground adds one result after the reusable parent prefix, while background appends the acknowledgement, notice, and later collection results. A notice-driven follow-up turn appends without rewriting the earlier prefix.

## Known Limitations and Deferred Work

- Tasks are text-only; `--attach` and per-dispatch authority overrides are not wired.
- Foreground dispatches hold a concurrency slot but create no job record; only background tasks are listed.

<a id="dev-note"></a>
### Dev Note

Behavior tests drive a scriptable fake CLI (`tests/fixtures/fake-zcode.cjs`); the real-CLI smoke lives in `tests/real-zcode.e2e.ts` and self-skips where the binary is absent. The completion-notice path, `zcode_followup`, the billing self-check, and the web panel are specified in implementation notes that live in the source harness worktree (see [Source and build context](#source-and-build-context)).

-----

<a id="source-and-build-context"></a>
## Source and build context

This repository publishes only the plugin package `@deepseek-ai/dsh-subagent-zcode`, extracted verbatim from a [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) working clone (branch `zcode-subagent-v1`, commit `21ab87c93e`; the commit sits on a local branch, not on a public remote). In that monorepo the package lives at `packages/subagent/subagent-zcode` and builds and tests as a pnpm workspace member — `peerDependencies`/`devDependencies` use pnpm `workspace:` protocols and `tsconfig.json` extends the monorepo's project references — so this repository is a source publication, not a standalone-installable package.

References inside the package to `ZCODE-CLI-DELEGATION.md` (the billing probe-closure procedure behind `expectedProviderIds`) and to the `.scratch/dsh-zcode-subagent-impl/` implementation notes resolve in that source repository, not here. The `zcode` profile bundle (`packages/bundle/zcode`) that mounts this provider also stays in the monorepo.
