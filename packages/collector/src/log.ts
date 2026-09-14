import pino from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "arc-rail-collector" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
export type Logger = typeof log;
