import { vi } from "vitest";

const ORIGINAL_ARGV = process.argv.slice();
const ORIGINAL_ENV = { ...process.env };

export function resetProcess(): void {
  process.argv = ORIGINAL_ARGV.slice();
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

export function setArgv(args: string[]): void {
  process.argv = ["node", "script", ...args];
}

export function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as never);
}

export function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const warns: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  });
  return {
    logs,
    errors,
    warns,
    restore() {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

export function captureStdout() {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
    writes.push(String(chunk));
    return true;
  }) as never);
  return {
    writes,
    restore() {
      spy.mockRestore();
    },
  };
}

export function captureStderr() {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: any) => {
    writes.push(String(chunk));
    return true;
  }) as never);
  return {
    writes,
    restore() {
      spy.mockRestore();
    },
  };
}

export async function importFresh(path: string) {
  vi.resetModules();
  return import(path);
}

export function useFixedTime(iso: string): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}
