/**
 * Default entry — informs user to run paper mode explicitly.
 * Live trading entry will be added in Phase 2.
 */
// eslint-disable-next-line no-console
console.log(`
Hyperliquid MM Bot — Phase 1 (paper trading)

Usage:
  npm run paper          # Run paper trader against live Hyperliquid orderbook
  npm test               # Run unit tests
  npm run typecheck      # Verify TypeScript

Phase 2 (live trading) is intentionally not yet wired up.
See docs/MORNING_BRIEFING.md for the activation checklist.
`);
