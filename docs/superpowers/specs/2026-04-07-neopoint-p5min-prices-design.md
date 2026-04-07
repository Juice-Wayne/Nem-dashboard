# Neopoint P5MIN Price Integration

Replace NEMWeb ZIP file scraping with Neopoint JSON API for P5MIN price change detection. NEMWeb remains the source for demand, interconnectors, and sensitivities.

## Problem

AEMO's NEMWeb directory listing batches updates every 10-15 minutes. P5MIN files exist on the server but are not accessible until the listing refreshes. This creates a 10-15 minute delay in price change data that cannot be worked around.

## Solution

Use Neopoint's "Prices Hour ahead forecasts" API which provides every P5MIN run's forecasted prices in a single JSON response, updated in real-time (~200ms response time, no directory listing delay).

### API Endpoint

```
https://neopoint.com.au/Service/Json
  ?f=101 Prices\Prices Hour ahead forecasts
  &from=YYYY-MM-DD HH:00
  &period=Daily
  &instances={REGIONID}
  &section=-1
  &key={NEOPOINT_API_KEY}
```

One call per region: NSW1, QLD1, VIC1, SA1. TAS1 if needed.

### Response Format

Each row is a P5MIN run. Each column is that run's forecast for a specific future interval:

```json
[
  {"DateTime":"2026-04-07 17:05:00", "07 17:10.rrp":106, "07 17:05.rrp":110.9, "07 17:00.rrp":106, ...},
  {"DateTime":"2026-04-07 17:10:00", "07 17:10.rrp":106, "07 17:05.rrp":121, "07 17:00.rrp":112.97, ...}
]
```

- `DateTime` = P5MIN run time
- Column keys like `"07 17:10.rrp"` = forecasted price for that interval
- The last two rows = current and previous runs
- Overlapping columns between last two rows = intervals we can compare

### Data Extraction

1. Fetch JSON for each region (4 parallel requests)
2. Take the last two rows (current run, previous run)
3. For each interval column present in both rows:
   - `PREVIOUS_RRP` = value from second-to-last row
   - `CURRENT_RRP` = value from last row
   - `DELTA` = current - previous
4. Return in the same shape as `getP5MinPriceChanges()` currently returns

## Architecture

### New File: `lib/nemweb/neopoint.ts`

Single exported function: `getNeopointP5MinPriceChanges()`

Returns: `{ INTERVAL_DATETIME: string; REGIONID: string; CURRENT_RRP: number; PREVIOUS_RRP: number; DELTA: number }[]`

This is the exact same return type as `getP5MinPriceChanges()`.

### Changes to `lib/nemweb/queries.ts`

`getP5MinPriceChanges()` becomes:
1. Try `getNeopointP5MinPriceChanges()`
2. If it fails, fall back to the existing NEMWeb logic
3. Cache result with the existing `resultCache` mechanism

### Environment Variable

`NEOPOINT_API_KEY` — stored in Vercel environment variables, accessed via `process.env.NEOPOINT_API_KEY`. Falls back to empty string (which will cause the Neopoint call to fail, triggering NEMWeb fallback).

### Caching

Same `resultCache` with key `"p5price"` and same TTL. Auto-invalidation via `sourceFilesChanged` still works as a belt-and-suspenders (NEMWeb polling continues for other data types and will trigger invalidation).

Additionally, since Neopoint is fast (200ms), we can reduce the P5MIN price result cache TTL or skip it entirely — the API is cheap enough to call on every request.

## What Changes

| Component | Before | After |
|-----------|--------|-------|
| P5MIN prices source | NEMWeb ZIP files (10-15 min delay) | Neopoint JSON API (real-time) |
| P5MIN demand source | NEMWeb ZIP files | NEMWeb ZIP files (unchanged) |
| P5MIN IC source | NEMWeb ZIP files | NEMWeb ZIP files (unchanged) |
| 30PD all sources | NEMWeb ZIP files | NEMWeb ZIP files (unchanged) |
| Sensitivities | NEMWeb ZIP files | NEMWeb ZIP files (unchanged) |
| Frontend | No changes | No changes |
| API routes | No changes | No changes |

## Error Handling

- Neopoint request fails → fall back to NEMWeb `getP5MinPriceChanges()` (existing logic)
- Neopoint returns empty/malformed data → fall back to NEMWeb
- API key missing → fall back to NEMWeb
- Less than 2 runs in response → fall back to NEMWeb (can't compute deltas)

## Interval Parsing

Column keys like `"07 17:10.rrp"` need to be parsed into full ISO datetimes. The day+time format `"DD HH:MM"` combined with the `from` date parameter gives us the full datetime. Handle day rollover (e.g., columns for April 8 when querying April 7).
