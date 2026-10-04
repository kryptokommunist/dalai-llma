/**
 * Pure statistical outlier detection for metric time-series.
 *
 * Used by scripts/analyze_all.js (Phase 1c) to flag spikes/dips in the many
 * numeric series the dashboard tracks (sentiment, wellbeing, messages, agency,
 * victim/empowered, the 8 nervous-system states, category counts, substances,
 * events-per-month, per-person mentions). Flagged points are then handed to the
 * LLM for a data-grounded explanation.
 *
 * NO I/O, NO LLM, NO randomness — deterministic given its inputs, so it can be
 * recomputed cheaply on every run and unit-tested in isolation.
 */

// Shared month-key normalizer. dashboard_data.json keys months as "Apr 2009";
// everything else is YYYY-MM. Mirror build_dashboard.js convertToYYYYMM so
// per-person mention series key the same way the rest of the pipeline does.
const MONTH_ABBR = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
};

function convertToYYYYMM(monthStr) {
    if (!monthStr) return monthStr;
    if (/^\d{4}-\d{2}$/.test(monthStr)) return monthStr; // already normalized
    const parts = String(monthStr).split(' ');
    if (parts.length === 2 && MONTH_ABBR[parts[0]]) {
        return `${parts[1]}-${MONTH_ABBR[parts[0]]}`;
    }
    return monthStr;
}

function mean(nums) {
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function stdev(nums, mu) {
    const m = mu === undefined ? mean(nums) : mu;
    const variance = nums.reduce((a, b) => a + (b - m) ** 2, 0) / nums.length;
    return Math.sqrt(variance);
}

/** Percentile via linear interpolation (p in [0,1]), over a pre-sorted array. */
function percentile(sorted, p) {
    if (sorted.length === 1) return sorted[0];
    const idx = p * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function round(n, d = 2) {
    const f = 10 ** d;
    return Math.round(n * f) / f;
}

/**
 * Detect outliers in a single numeric series.
 *
 * @param {Array<{key:string, value:number}>} series
 * @param {object} [opts]
 * @param {'zscore'|'iqr'|'both'} [opts.method='both'] which test(s) must trigger (OR)
 * @param {number} [opts.z=2.5]        z-score threshold
 * @param {number} [opts.iqrK=1.5]     IQR fence multiplier
 * @param {number} [opts.minPoints=6]  skip series shorter than this
 * @param {number} [opts.minValue]     for count series: only flag points at/above this
 * @param {number} [opts.cap=8]        keep at most this many flags (top by magnitude)
 * @returns {Array<{key,value,direction:'spike'|'dip',magnitude:number,method:string}>}
 */
function detectOutliers(series, opts = {}) {
    const {
        method = 'both', z = 2.5, iqrK = 1.5,
        minPoints = 6, minValue, cap = 8
    } = opts;

    const clean = (series || []).filter(p => p && typeof p.value === 'number' && !isNaN(p.value));
    if (clean.length < minPoints) return [];

    const values = clean.map(p => p.value);
    const mu = mean(values);
    const sd = stdev(values, mu);

    const sorted = [...values].sort((a, b) => a - b);
    const q1 = percentile(sorted, 0.25);
    const q3 = percentile(sorted, 0.75);
    const iqr = q3 - q1;
    const lower = q1 - iqrK * iqr;
    const upper = q3 + iqr * iqrK;

    const useZ = method === 'zscore' || method === 'both';
    const useIqr = method === 'iqr' || method === 'both';

    const flags = [];
    for (const p of clean) {
        if (minValue !== undefined && p.value < minValue) continue;

        const zHit = useZ && sd > 0 && Math.abs((p.value - mu) / sd) >= z;
        const iqrHit = useIqr && iqr > 0 && (p.value < lower || p.value > upper);
        if (!zHit && !iqrHit) continue;

        const direction = p.value >= mu ? 'spike' : 'dip';
        // Magnitude: prefer z-units when available, else IQR-units beyond the fence.
        let magnitude;
        if (zHit) {
            magnitude = round(Math.abs((p.value - mu) / sd));
        } else {
            const beyond = p.value > upper ? (p.value - upper) : (lower - p.value);
            magnitude = round(iqr > 0 ? beyond / iqr : 0);
        }
        const hitMethod = zHit && iqrHit ? 'both' : (zHit ? 'zscore' : 'iqr');
        flags.push({ key: p.key, value: round(p.value, 4), direction, magnitude, method: hitMethod });
    }

    flags.sort((a, b) => b.magnitude - a.magnitude);
    return flags.slice(0, cap);
}

/**
 * Run detectOutliers over many named series.
 * @param {Object<string, Array<{key,value}>>} seriesMap
 * @param {Object<string, object>} [optsByMetric] per-metric opts override
 * @returns {Object<string, Array>} only metrics that produced at least one flag
 */
function detectOutlierSeries(seriesMap, optsByMetric = {}) {
    const out = {};
    for (const [metric, series] of Object.entries(seriesMap || {})) {
        const flags = detectOutliers(series, optsByMetric[metric] || {});
        if (flags.length) out[metric] = flags;
    }
    return out;
}

/**
 * Re-shape {metric: [{key,...}]} into {YYYY-MM: [{metric,...}]} for the batched
 * per-month LLM explainer. `key` is assumed to be a YYYY-MM month on each flag.
 * @returns {Object<string, Array<{metric,direction,magnitude,value}>>}
 */
function groupFlagsByMonth(flagsByMetric) {
    const byMonth = {};
    for (const [metric, flags] of Object.entries(flagsByMetric || {})) {
        for (const f of flags) {
            (byMonth[f.key] = byMonth[f.key] || []).push({
                metric,
                direction: f.direction,
                magnitude: f.magnitude,
                value: f.value
            });
        }
    }
    return byMonth;
}

/** Stable signature of a flag set, for skip-caching. Sorted metric:direction pairs. */
function flagSignature(flags) {
    return (flags || [])
        .map(f => `${f.metric}:${f.direction}`)
        .sort()
        .join('|');
}

module.exports = {
    convertToYYYYMM,
    detectOutliers,
    detectOutlierSeries,
    groupFlagsByMonth,
    flagSignature
};
