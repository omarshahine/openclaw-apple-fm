// Resolve "./x.js" to "./x.ts" for node --test.
//
// Source uses .js specifiers (the OpenClaw extension convention, resolved by jiti
// at runtime and by vitest in the bundled repo). Node's native type stripping does
// not remap them, so tests register this hook instead of the sources drifting.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) {
      try {
        const resolved = new URL(specifier, context.parentURL);
        const asTs = new URL(`${resolved.href.slice(0, -3)}.ts`);
        if (!existsSync(fileURLToPath(resolved)) && existsSync(fileURLToPath(asTs))) {
          return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
        }
      } catch {
        // fall through to the default resolver
      }
    }
    return nextResolve(specifier, context);
  },
});
