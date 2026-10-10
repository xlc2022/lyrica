// host-api's log: one JSON line per event, to stdout. Fields are IDs, counts and
// states. Never prompt text, results, tokens or who asked.
export type LogFields = Record<string, string | number | boolean | null>;

export type Logger = (event: string, fields?: LogFields) => void;

export const stdoutLog: Logger = (event, fields = {}) => {
  process.stdout.write(JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + "\n");
};
