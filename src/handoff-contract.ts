export const HANDOFF_TEXT_MIN = 1;
export const HANDOFF_TEXT_MAX = 2_000;
export const HANDOFF_ARRAY_MAX = 20;
export const HANDOFF_NEXT_STEPS_MAX = 10;
export const HANDOFF_EVIDENCE_PATH_MAX = 500;
export const HANDOFF_MAX_BYTES = 32_000;
export const HANDOFF_STATUSES = ["completed", "partial", "blocked"] as const;
export const VERIFICATION_RESULTS = ["passed", "failed", "not_run"] as const;

export const TERMINAL_PHASES = [...HANDOFF_STATUSES, "failed", "cancelled"] as const;
export const PHASES = ["queued", "starting", "running", "summarizing", ...TERMINAL_PHASES] as const;
export type Phase = (typeof PHASES)[number];
export const isTerminal = (phase: Phase): boolean => (TERMINAL_PHASES as readonly Phase[]).includes(phase);

type SettledRuntimeState = {
  settled: boolean;
  compacting: boolean;
  retry?: unknown;
  queue: { steering: number; followUp: number };
};

// 两个进程分别校验；缺少运行态时不能交付结果。
export function isSettled(runtime: SettledRuntimeState | undefined | null): boolean {
  return !!runtime && runtime.settled && !runtime.compacting && !runtime.retry
    && !runtime.queue.steering && !runtime.queue.followUp;
}
