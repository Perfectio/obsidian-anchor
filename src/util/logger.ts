// Structured stderr logger.
//
// stdout is reserved exclusively for the MCP stdio transport (JSON-RPC). Any
// stray write to stdout corrupts the protocol stream, so every diagnostic
// message Anchor emits MUST go to stderr. This module is the only sanctioned
// way to log; `console.*` is banned in src/ via ESLint.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveThreshold(): number {
  const raw = (process.env.ANCHOR_LOG_LEVEL ?? "info").toLowerCase();
  return LEVEL_ORDER[raw as LogLevel] ?? LEVEL_ORDER.info;
}

const threshold = resolveThreshold();

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level: LogLevel, message: string, fields?: object): void {
  if (LEVEL_ORDER[level] < threshold) return;
  let line = `[anchor] ${level.toUpperCase()} ${message}`;
  if (fields && Object.keys(fields).length > 0) {
    line += ` ${safeJson(fields)}`;
  }
  process.stderr.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, fields?: object): void => write("debug", message, fields),
  info: (message: string, fields?: object): void => write("info", message, fields),
  warn: (message: string, fields?: object): void => write("warn", message, fields),
  error: (message: string, fields?: object): void => write("error", message, fields),
};
