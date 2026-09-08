type Level = "debug" | "info" | "warn" | "error";

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function log(level: Level, scope: string, msg: string): void {
  const color = process.env.NO_COLOR ? "" : COLORS[level];
  const reset = process.env.NO_COLOR ? "" : "\x1b[0m";
  console.log(`${color}[${ts()}] [${level.toUpperCase()}] [${scope}] ${msg}${reset}`);
}

export const logger = {
  debug: (s: string, m: string) => log("debug", s, m),
  info: (s: string, m: string) => log("info", s, m),
  warn: (s: string, m: string) => log("warn", s, m),
  error: (s: string, m: string) => log("error", s, m),
};

