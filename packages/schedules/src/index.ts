// @muxeon/schedules — deferred self-chains (§21). An agent hands the coordinator
// a plan for itself; the coordinator keeps it on disk and fires each item at its
// hour through paths that already exist (router/queue, control-lane, lifecycle).
// It owns TIME, never authority: every gate is evaluated at firing time (§10.33).

export {
  type Chain,
  type ChainInput,
  type ChainItem,
  type ChainItemInput,
  type ItemKind,
  type ItemState,
  type ScheduleErrorCode,
  type ScheduleLimits,
  DEFAULT_LIMITS,
  ScheduleError,
  isLive,
  parseDelay,
  planChain,
  validateChainId,
} from "./chain";
export { type ScheduleStore, createFsScheduleStore } from "./store";
export {
  type ScheduleExecutors,
  type SchedulerHandle,
  type SchedulerOptions,
  dueItems,
  startSchedules,
} from "./scheduler";
