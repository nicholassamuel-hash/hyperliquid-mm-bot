import pino from "pino";

export function createLogger(level: string = "info") {
  return pino({
    level,
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
