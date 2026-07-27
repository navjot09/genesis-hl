import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // The gate protects the correctness-critical PURE logic — the modules
      // whose bugs were the review's correctness findings. Endpoint/transport
      // files are exercised by the emulator e2e harnesses instead.
      include: [
        'src/generate/markerParser.ts',
        'src/generate/editApply.ts',
        'src/generate/heuristics.ts',
        'src/generate/engine.ts',
        'src/generate/contentStore.ts',
        'src/generate/fileOps.ts',
        'src/generate/lintGenerated.ts',
        'src/proxy/allowlist.ts',
      ],
      // Current actuals are 82-100% lines / 79-100% branches; the gate holds
      // the floor so coverage cannot silently erode below it.
      thresholds: {
        lines: 80,
        statements: 80,
        branches: 75,
        functions: 95,
      },
      reporter: ['text-summary'],
    },
  },
});
