# Plan: Outlier explanations + per-person NS drill-down + social clusters

## Context

Three features, folded into one plan at the user's request. All share the same pipeline
(`scripts/analyze_all.js` → `output/*.json` → `scripts/build_dashboard.js` → `dashboard.html`)
and the same whole-object JSON injection, so they compose cleanly.

1. **Outlier explanations on hover** — *"For all stats in the UI and processing stage have the
   LLM collect likely explanations for the outliers and show them in the UI upon hovering."*
   Many numeric series (sentiment, wellbeing, messages, agency, victim/empowered, 8 nervous
   states, category counts, substances, events, per-person mentions) have visible but unexplained
   spikes/dips. Code detects outliers numerically; the LLM explains only flagged points, grounded
   in that month's sampled data; explanations surface as hover tooltips.

2. **Per-person nervous-system drill-down** — the per-person detail modal already renders a
   dominant-state chip strip + prose arc (dashboard L2854-2880) but shows nothing today (stale
   output). Add a full per-person 8-state view, produced inside the existing LLM passes (no new pass).

3. **Social clusters/communities** — auto-detect social groupings and track them over time as
   entities (deferred follow-up now being picked up). Participant/group-chat membership is currently
   discarded before any output JSON; it must be re-plumbed from the loader. LLM-driven clustering.

### CRITICAL PREREQUISITE — stale output
`output/category_analysis.json` has **no `nervous_system` key**; `output/llm_insights.json` has no
`self_insight` / `nervous_system_arc` / `nervous_system_monthly`; `relationship_monthly` entries carry
no `nervous_state`. The code produces all of these, but the on-disk JSON predates it. **The global NS
chart and the per-person NS section render nothing until `npm run analyze:force` is re-run.** This
re-run is step 0 of implementation and a hard dependency for features 2 and the NS parts of feature 1.

### Decisions (confirmed with the user)
- **Outliers:** all 3 stat families; code detects (z-score/IQR), LLM explains flagged points only;
  one batched LLM call per month-with-flags, reusing that month's sample; incremental + skip-cached.
  **Events-per-month filters out low-signal `google_search`** noise (count only health/relationship/
  work/travel/life). **Person outliers = mention-count only** in v1 (per-month person sentiment doesn't
  exist; sentiment-swing deferred).
- **Per-person NS:** produced **inside existing LLM passes** — extend `extractMonthRelationships`'s
  schema to add an 8-score block per person, no extra call.
- **Clusters:** **re-plumb `participants[]`/`chatName`/`isGroup` from `scripts/lib/chat_sources.js`**
  into a new aggregation; **LLM names/characterizes clusters** from co-membership + co-mentions.
- **NO Neo4j, no external DB, no graph library.** Dashboard stays a standalone static HTML file.
  Clusters render as **HTML cluster cards + a Chart.js bubble view**, drill-down via the existing
  `#infoModal`. (An in-browser node-link lib can be swapped in later if desired.)

---

## Feature 1 — Outlier explanations

### 1a. Detection helper — `scripts/lib/outliers.js` (NEW, pure, no LLM)
CommonJS, matching `chat_sources.js`. Exports:
- `detectOutliers(series, opts)` — `series: [{key, value}]`; z-score (`|z|>=2.5`) OR IQR (1.5·IQR fence);
  returns `[{key, value, direction:'spike'|'dip', magnitude, method}]`. Guards: `minPoints=6`,
  skip z when `stdev===0`, optional `minValue` for count series. Cap top ~8 per metric by magnitude.
- `detectOutlierSeries(seriesMap, optsByMetric)` → `{metric: [flagged]}` (only metrics with flags).
- `groupFlagsByMonth(flagsByMetric)` → `{YYYY-MM: [{metric, direction, magnitude, value}]}`.
- Export a shared `convertToYYYYMM` (or import the one logic) so person-mention keys normalize to match.

**Series run:** sentiment, wellbeing, messages, agency (from `dashboard_data.json`); victim_score,
empowered_score; `nervous_<state>`×8; `cat_<category>`×10 (minValue); substance_count (minValue);
events_per_month (**filtered to significant categories**, minValue); `person_<name>_mentions` (minValue).
Person sentiment = single scalar, **skipped** in v1.

### 1b. Batched LLM explainer — `scripts/analyze_all.js` (new `explainMonthOutliers`)
`async explainMonthOutliers(monthKey, sample, flagged)` → `{metric: explanation}`. Reuses the per-month
`sample` array (factor `processMonth`'s sampling at L965-968 into a shared `sampleMonth(messages)` helper).
Prompt: lists flagged metrics + directions, gives month's sample, asks for ≤20-word data-grounded
explanation per metric, "No clear signal in sampled data." when absent. `maxTokens≈700`.
Fallback: `parseJSON(resp, Object.fromEntries(flagged.map(f=>[f.metric,''])))`.

### 1c. Wiring — new Phase 1c after aggregation (~L1165, before writing category_analysis L1181)
Baselines need all months, so run post-aggregation (not inside `processMonth`). Steps: load
`output/dashboard_data.json` (generalize existing `loadPeopleFromDashboard` L914 to also return
`monthlyData`/`peopleData`; skip those series gracefully if the file is absent) → build series →
`detectOutlierSeries` + `groupFlagsByMonth` → re-derive each month's `sample` via `sampleMonth` →
`runParallel` `explainMonthOutliers` over months-with-flags only.

### 1d. Persist (inside `aggregated` → `category_analysis.json`)
Attach `outliers` sub-objects onto existing per-month objects, each item `{direction, magnitude,
value, method, explanation}`, plus `_flagSig` (sorted `metric:direction` join) for skip-caching:
- `monthly[m].outliers.items` — sentiment, wellbeing, messages, agency, events (process_data + cross-family home)
- `victim_analysis[m].outliers` — victim_score, empowered_score
- `nervous_system[m].outliers` — 8 states
- `categories[m].outliers` — per-category (⚠ R4 below)
- `substance_monthly[m].outliers` — substance_count
- `person_insights[name].outliers.mentions` — `{YYYY-MM: {direction, magnitude, value, explanation}}`

### 1e. Skip-cache / `--force`
Reuse `FORCE` (L77). Detection always recomputes (cheap); LLM call runs only if
`FORCE || !existing.outliers || existing.outliers._flagSig !== newFlagSig`. Carry forward existing
`.outliers` for skipped months during aggregation carry-forward (L1134-1156); load prior outliers into
`existingData` (L1039-1053) like victim/nervous.

### 1f. UI (`templates/dashboard.html` — all text from injected JSON, never hardcoded)
`categoryData` and `personInsightsData` are injected whole, so no `build_dashboard.js` change needed.
Add Chart.js `plugins.tooltip.callbacks.afterBody` (pattern: existing `categoryChart` callback L3960):
- mainChart L3171 → read `categoryData.monthly[filteredData[i].month].outliers.items`
- victimLlmChart L3983 → `categoryData.victim_analysis[months[idx]].outliers`
- nervousSystemChart L4051 → `categoryData.nervous_system[nsMonths[idx]].outliers.items[state]`
- categoryTimeChart L4119 → `categoryData.categories[catMonths[idx]].outliers`
Month cards (L1747) + person cards (L1731): native `title=` attr (reuse escaping at L2861). Month-detail
modal (L1791-1861): add "Notable this month" section. Person modal: add "Mention spikes/dips" chips.

---

## Feature 2 — Per-person nervous-system drill-down (via existing passes)

- **Producer:** extend `extractMonthRelationships` schema (`scripts/analyze_all.js` ~L541-568) so each
  romantic/friendship entry adds `scores:{fawn,dominate,fight,flight,freeze,avoid,anxious,centered}`
  (0-100) **alongside** the existing `nervous_state.dominant_state`. Same call, no new pass.
- **Aggregate into** `person_insights[name].nervous_monthly = {YYYY-MM: {scores:{8}, dominant_state}}`
  during the people phase (reuse `synthesizeNervousSystemArc` inputs). Rides `personInsightsData` injection.
- **Render:** per-person 8-state line chart in the person modal, **reusing the global `nervousSystemChart`
  dataset-mapping code** (NS_STATES/NS_COLORS at L4037-4047) pointed at `personInsightsData[name].nervous_monthly`.
  Keep the existing dominant-state chip strip + prose arc (L2854-2880) above it.

---

## Feature 3 — Social clusters (no external DB, no graph lib)

- **Re-plumb membership:** `process_data.js adaptChatRecords` already carries `metadata.{sender,participants,chat}`
  (L492) but it's dropped. Add an aggregation that emits co-membership edges (per group-chat, per month) and
  co-mention edges (from `relationship_monthly`) into a new structure.
- **LLM clustering:** new pass in `analyze_all.js` that takes co-membership + co-mention signal and the
  per-month/roll-up summaries, and emits named clusters: `category_analysis.social_clusters = {clusters:[{id,
  name, members:[], summary, months:{YYYY-MM:{strength, note}}}]}`. Rides `categoryData` injection.
- **Render (dashboard):** new `.chart-card` block (mirror NS card L1380-1388) with HTML **cluster cards** +
  a **Chart.js bubble** (member count × activity over time); `showInfo('clusters')` entry; per-cluster
  drill-down via the shared `#infoModal` (pattern L2934-2936). Wire a `renderClusters()` call into the
  `loadCategoryAnalysis()`/`renderCategoryCharts()` init path (L3900 / L4176).

---

## Risks / guards
- **R4 — `categories[m]` is a flat count map.** Adding `outliers` as a sibling means every
  `Object.keys/entries(categories[m])` read (analyze_all `category_totals` L1168-1172; template L4106,
  L4113-4116, donut) must `.filter(k => k !== 'outliers')`. Grep all `categories[` reads before shipping.
- **R-stale — re-run required.** `npm run analyze:force` is step 0; without it NS features render blank.
- **R-events** — filter events to significant categories before counting (excludes `google_search`).
- **R-persons** — person sentiment-swing outliers deferred (no per-month person sentiment exists).
- **R-clusters** — participant data must survive a NEW aggregation path; verify it lands in output JSON
  (currently 0 occurrences of `participants`/`chatName` in any `output/*.json`).
- Tooltip index→month mapping relies on label arrays built by `.map` over the same month arrays (holds today).

## Files
- `scripts/lib/outliers.js` (NEW — detector)
- `scripts/analyze_all.js` (explainMonthOutliers + Phase 1c; extend relationship schema for per-person NS;
  new cluster pass; load dashboard_data; attach outliers; skip-cache; category-key guards)
- `scripts/process_data.js` (surface co-membership edges from `metadata.participants` for clustering)
- `templates/dashboard.html` (tooltip afterBody callbacks; month/person card `title=`; modal sections;
  per-person NS chart; cluster card block; category-key guards)
- `scripts/build_dashboard.js` (likely unchanged — whole-object injection; touch only if cluster edges
  need a dedicated placeholder)
- `scripts/build_analysis.js` (optional — mirror per-person NS / clusters into the static analysis page)

## Verification
1. `node --check` on every edited `.js`; unit-sanity the detector on `[10,11,9,10,50,10]` → index 4 = spike.
2. **`npm run full`** (process → analyze → build) so `dashboard_data.json` exists before analyze and NS/
   self data populates. Then `npm run analyze:force` once to backfill all months (bounded: 1 call/flagged-month).
3. Inspect output locally (no commits): confirm `_flagSig` + per-metric `explanation` on `monthly`/
   `victim_analysis`/`nervous_system`/`person_insights`; confirm `nervous_system` key now present;
   confirm `social_clusters` populated and participant data survived aggregation.
4. `npm run serve` → hover each chart shows explanations for flagged months only; open a person modal to see
   the 8-state chart + chips; open the clusters section + a cluster drill-down.
5. Privacy: `git status` shows only `scripts/**` + `templates/dashboard.html` (output/data/dashboard.html/.env
   gitignored); no explanation strings or personal data in the template or any commit; no raw sample text logged.
