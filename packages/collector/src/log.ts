import pino from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "cra-agent-collector" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
export type Logger = typeof log;
