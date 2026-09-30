// Child-process entry point that executes one method of one venue module and
// prints the result. Usage (spawned by runVenueMethod, not by hand):
//
//   node venue-runner.ts <module-path> <method>
//   env OURO_VENUE_INPUT = JSON {args, now, dataDir}
//
// The last stdout line starting with RESULT_MARKER carries the JSON result, so
// adapters may log freely to stdout/stderr.

import { pathToFileURL } from 'node:url';

export const RESULT_MARKER = '@@OURO_RESULT@@';

async function main(): Promise<void> {
  const [modulePath, method] = process.argv.slice(2);
  const input = JSON.parse(process.env.OURO_VENUE_INPUT ?? '{}') as { args?: unknown; now?: number; dataDir?: string };
  const secretsEnv: Record<string, string | undefined> = { ...process.env };
  delete secretsEnv.OURO_VENUE_INPUT;
  try {
    const mod = await import(pathToFileURL(modulePath).href);
    const venue = mod.default ?? mod.venue;
    if (!venue) throw new Error('module has no default export or `venue` export');
    let result: unknown;
    if (method === 'describe') {
      result = { id: venue.id, description: venue.description, secrets: venue.secrets ?? [], hasFlows: typeof venue.flows === 'function' };
    } else {
      if (typeof venue[method] !== 'function') throw new Error(`venue has no ${method}()`);
      const ctx = { env: secretsEnv, now: input.now ?? Date.now(), dataDir: input.dataDir ?? process.cwd(), args: input.args };
      result = method === 'flows' ? await venue.flows(ctx, Number((input.args as { since?: number } | undefined)?.since ?? 0)) : await venue[method](ctx);
    }
    process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify({ ok: true, result })}\n`);
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify({ ok: false, error: msg })}\n`);
  }
}

// Only run when executed directly (importing RESULT_MARKER must not start work).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (e) => {
      process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify({ ok: false, error: String(e) })}\n`);
      process.exit(0);
    },
  );
}
