#!/usr/bin/env node
/**
 * Builds a standalone analysis HTML page from llm_insights.json
 * Covers full trajectory 2013-today with action recommendations
 */

const fs = require('fs');

const OUTPUT = process.env.OUTPUT || './analysis_2013_2026.html';
const insightsPath = 'output/llm_insights.json';

if (!fs.existsSync(insightsPath)) {
    console.error('ERROR: output/llm_insights.json not found. Run npm run analyze first.');
    process.exit(1);
}

const insights = JSON.parse(fs.readFileSync(insightsPath, 'utf8'));
const yearlySummaries = insights.yearly_summaries || {};
const overall = insights.insights || {};
const events = insights.events || [];

const yearKeys = Object.keys(yearlySummaries).sort();

// Build phase labels for timeline
function phaseLabel(year) {
    const y = parseInt(year);
    if (y <= 2015) return 'phase-early';
    if (y <= 2019) return 'phase-building';
    if (y <= 2022) return 'phase-deepening';
    if (y <= 2024) return 'phase-excavation';
    return 'phase-reckoning';
}

function phaseTitle(year) {
    const y = parseInt(year);
    if (y <= 2015) return 'Early Formation';
    if (y <= 2019) return 'Building & Mastery';
    if (y <= 2022) return 'Deepening';
    if (y <= 2024) return 'Excavation';
    return 'Reckoning';
}

function themeColor(theme) {
    const t = theme.toLowerCase();
    if (t.includes('tech') || t.includes('build') || t.includes('code') || t.includes('software')) return '#4f8ef7';
    if (t.includes('mental') || t.includes('psych') || t.includes('therapy') || t.includes('trauma') || t.includes('grief')) return '#e06c75';
    if (t.includes('spiritual') || t.includes('contempla') || t.includes('somat') || t.includes('buddh')) return '#c678dd';
    if (t.includes('relation') || t.includes('social') || t.includes('romantic') || t.includes('friend')) return '#e5c07b';
    if (t.includes('work') || t.includes('career') || t.includes('freelan') || t.includes('profess')) return '#56b6c2';
    if (t.includes('identity') || t.includes('self') || t.includes('inner') || t.includes('growth')) return '#98c379';
    if (t.includes('travel') || t.includes('berlin') || t.includes('geo') || t.includes('move')) return '#d19a66';
    return '#abb2bf';
}

function sentimentEmoji(year) {
    const y = parseInt(year);
    if (y <= 2016) return '🌱';
    if (y <= 2019) return '🔨';
    if (y <= 2021) return '📚';
    if (y <= 2023) return '🔍';
    if (y <= 2024) return '💡';
    return '🌊';
}

function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Build year cards HTML
const yearCardsHtml = yearKeys.map(year => {
    const s = yearlySummaries[year];
    const themes = (s.major_themes || []).slice(0, 4);
    const turning = (s.key_turning_points || []).slice(0, 2);
    const phase = phaseTitle(year);
    const phaseClass = phaseLabel(year);

    return `
    <div class="year-card ${phaseClass}" id="year-${year}" onclick="toggleYear('${year}')">
        <div class="year-header">
            <div class="year-title">
                <span class="year-emoji">${sentimentEmoji(year)}</span>
                <span class="year-num">${year}</span>
                <span class="year-phase-badge ${phaseClass}">${phase}</span>
                ${s.message_count ? `<span class="data-badge">${s.message_count.toLocaleString()} data points</span>` : ''}
            </div>
            <div class="year-sentence">${escHtml(s.year_in_one_sentence || '')}</div>
            <div class="year-themes">
                ${themes.map(t => `<span class="theme-chip" style="border-color:${themeColor(t)};color:${themeColor(t)}">${escHtml(t.split('—')[0].split('(')[0].trim().slice(0,45))}</span>`).join('')}
            </div>
        </div>
        <div class="year-body" id="body-${year}">
            <div class="year-narrative">${escHtml(s.narrative || '').replace(/\n\n/g, '</p><p>')}</div>
            ${s.emotional_arc ? `<div class="year-section-label">Emotional Arc</div><div class="year-arc">${escHtml(s.emotional_arc)}</div>` : ''}
            ${turning.length ? `<div class="year-section-label">Turning Points</div><ul class="turning-list">${turning.map(t=>`<li>${escHtml(t)}</li>`).join('')}</ul>` : ''}
        </div>
    </div>`;
}).join('\n');

// Build recommendations HTML
const recsHtml = (overall.recommendations || []).map((r, i) => `
    <div class="rec-card" style="animation-delay:${i*0.1}s">
        <div class="rec-area">${escHtml(r.area)}</div>
        <div class="rec-action">${escHtml(r.action)}</div>
    </div>`).join('\n');

// Build turning points HTML
const turningHtml = (overall.turning_points || []).map(tp => `
    <div class="turning-card">
        <div class="turning-period">${escHtml(tp.period)}</div>
        <div class="turning-desc">${escHtml(tp.description)}</div>
    </div>`).join('\n');

// Build strengths HTML
const strengthsHtml = (overall.strengths || []).map(s => `
    <div class="strength-item">${escHtml(s)}</div>`).join('\n');

// Build risk factors HTML
const risksHtml = (overall.risk_factors || []).map(r => `
    <div class="risk-item">${escHtml(r)}</div>`).join('\n');

// Build patterns HTML
const patternsHtml = (overall.patterns || []).map(p => `
    <div class="pattern-card ${p.impact || 'neutral'}">
        <div class="pattern-impact">${p.impact === 'positive' ? '↑' : p.impact === 'negative' ? '↓' : '↔'} ${escHtml(p.impact || 'neutral')}</div>
        <div class="pattern-text">${escHtml(p.pattern || '')}</div>
        ${p.evidence ? `<div class="pattern-evidence">${escHtml(p.evidence.slice(0,250))}</div>` : ''}
    </div>`).join('\n');

// Trajectory phases for visual arc
const phases = [
    { years: '2013–2015', label: 'Formation', desc: 'Moving to Berlin, starting CS, building identity through curiosity and language' },
    { years: '2016–2019', label: 'Mastery', desc: 'Deep technical building, HPI/HU, freelance identity, first therapy signals' },
    { years: '2020–2022', label: 'Deepening', desc: 'Pandemic sublimation, psychological awakening, IFS, MDMA therapy research' },
    { years: '2023–2024', label: 'Excavation', desc: 'Courageous inner work, family break, somatic/contemplative depth, identity reconstruction' },
    { years: '2025–2026', label: 'Reckoning', desc: 'PTSD surfacing, grief, workplace trauma, embodied integration, seeking authentic life' },
];

const phaseArcHtml = phases.map((p, i) => `
    <div class="arc-phase arc-phase-${i}">
        <div class="arc-years">${p.years}</div>
        <div class="arc-label">${p.label}</div>
        <div class="arc-desc">${p.desc}</div>
    </div>`).join('<div class="arc-arrow">→</div>');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Life Analysis 2013–2026 — DalaiLLMA</title>
<style>
:root {
    --bg: #1a1b26;
    --surface: #24283b;
    --surface2: #2f3349;
    --border: #3b4261;
    --text: #c0caf5;
    --text-dim: #7982a9;
    --text-bright: #e0e0ff;
    --accent: #7aa2f7;
    --accent2: #bb9af7;
    --green: #9ece6a;
    --red: #f7768e;
    --orange: #ff9e64;
    --yellow: #e0af68;
    --cyan: #7dcfff;
    --phase-early: #3d5a80;
    --phase-building: #2d6a4f;
    --phase-deepening: #5c4a7a;
    --phase-excavation: #7a4a2d;
    --phase-reckoning: #6b2d2d;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    line-height: 1.6;
    min-height: 100vh;
}
.page-header {
    background: linear-gradient(135deg, #1a1b26 0%, #2d1b69 50%, #1a1b26 100%);
    border-bottom: 1px solid var(--border);
    padding: 48px 24px 36px;
    text-align: center;
    position: relative;
    overflow: hidden;
}
.page-header::before {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse at 50% 0%, rgba(122,162,247,0.15) 0%, transparent 70%);
    pointer-events: none;
}
.page-title {
    font-size: 2.4rem;
    font-weight: 700;
    color: var(--text-bright);
    letter-spacing: -0.02em;
    margin-bottom: 8px;
}
.page-subtitle {
    font-size: 1.1rem;
    color: var(--text-dim);
    max-width: 600px;
    margin: 0 auto 16px;
}
.page-meta {
    font-size: 0.8rem;
    color: var(--text-dim);
    opacity: 0.7;
}
nav {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    display: flex;
    gap: 4px;
    padding: 0 24px;
    position: sticky;
    top: 0;
    z-index: 100;
    overflow-x: auto;
}
.nav-btn {
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 0.85rem;
    padding: 14px 16px;
    white-space: nowrap;
    border-bottom: 2px solid transparent;
    transition: color 0.2s, border-color 0.2s;
}
.nav-btn:hover, .nav-btn.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
}
.section {
    display: none;
    max-width: 1100px;
    margin: 0 auto;
    padding: 32px 20px;
}
.section.active { display: block; }
.section-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text-bright);
    margin-bottom: 8px;
}
.section-desc {
    color: var(--text-dim);
    margin-bottom: 28px;
    font-size: 0.95rem;
}

/* Trajectory arc */
.arc-container {
    display: flex;
    align-items: stretch;
    gap: 0;
    overflow-x: auto;
    padding: 8px 0 16px;
    margin-bottom: 32px;
}
.arc-phase {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    flex: 1;
    min-width: 140px;
    padding: 16px;
    text-align: center;
    position: relative;
}
.arc-phase-0 { border-top: 3px solid var(--phase-early); }
.arc-phase-1 { border-top: 3px solid var(--phase-building); }
.arc-phase-2 { border-top: 3px solid var(--phase-deepening); }
.arc-phase-3 { border-top: 3px solid var(--phase-excavation); }
.arc-phase-4 { border-top: 3px solid var(--phase-reckoning); }
.arc-years { font-size: 0.75rem; color: var(--text-dim); margin-bottom: 4px; }
.arc-label { font-size: 1rem; font-weight: 700; color: var(--text-bright); margin-bottom: 8px; }
.arc-desc { font-size: 0.78rem; color: var(--text-dim); line-height: 1.4; }
.arc-arrow { display: flex; align-items: center; padding: 0 4px; color: var(--text-dim); font-size: 1.2rem; flex-shrink: 0; }

/* Trajectory text */
.trajectory-box {
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 4px solid var(--accent2);
    border-radius: 8px;
    padding: 24px;
    font-size: 0.95rem;
    line-height: 1.75;
    color: var(--text);
    margin-bottom: 32px;
}

/* Year cards */
.years-grid { display: flex; flex-direction: column; gap: 12px; }
.year-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    cursor: pointer;
    transition: border-color 0.2s;
}
.year-card:hover { border-color: var(--accent); }
.year-card.phase-early { border-left: 4px solid var(--phase-early); }
.year-card.phase-building { border-left: 4px solid var(--phase-building); }
.year-card.phase-deepening { border-left: 4px solid var(--phase-deepening); }
.year-card.phase-excavation { border-left: 4px solid var(--phase-excavation); }
.year-card.phase-reckoning { border-left: 4px solid var(--phase-reckoning); }
.year-header { padding: 16px 20px; }
.year-title {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
    flex-wrap: wrap;
}
.year-emoji { font-size: 1.3rem; }
.year-num { font-size: 1.4rem; font-weight: 700; color: var(--text-bright); }
.year-phase-badge {
    font-size: 0.7rem;
    padding: 2px 8px;
    border-radius: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}
.year-phase-badge.phase-early { background: rgba(61,90,128,0.3); color: #a8c8ff; }
.year-phase-badge.phase-building { background: rgba(45,106,79,0.3); color: #a8f0c8; }
.year-phase-badge.phase-deepening { background: rgba(92,74,122,0.3); color: #d4a8ff; }
.year-phase-badge.phase-excavation { background: rgba(122,74,45,0.3); color: #ffd4a8; }
.year-phase-badge.phase-reckoning { background: rgba(107,45,45,0.3); color: #ffa8a8; }
.data-badge {
    font-size: 0.7rem;
    background: rgba(122,162,247,0.1);
    color: var(--accent);
    padding: 2px 8px;
    border-radius: 12px;
    margin-left: auto;
}
.year-sentence {
    font-size: 0.95rem;
    color: var(--text-bright);
    font-style: italic;
    margin-bottom: 10px;
    line-height: 1.5;
}
.year-themes { display: flex; flex-wrap: wrap; gap: 6px; }
.theme-chip {
    font-size: 0.72rem;
    padding: 2px 10px;
    border-radius: 12px;
    border: 1px solid;
    background: rgba(255,255,255,0.04);
}
.year-body {
    display: none;
    padding: 0 20px 20px;
    border-top: 1px solid var(--border);
}
.year-card.expanded .year-body { display: block; }
.year-section-label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    margin: 16px 0 6px;
    font-weight: 600;
}
.year-narrative {
    font-size: 0.9rem;
    line-height: 1.75;
    color: var(--text);
    margin-top: 12px;
}
.year-narrative p { margin-bottom: 12px; }
.year-arc {
    font-size: 0.9rem;
    line-height: 1.7;
    color: var(--text-dim);
    background: var(--surface2);
    border-radius: 6px;
    padding: 12px 14px;
    font-style: italic;
}
.turning-list { padding-left: 20px; }
.turning-list li {
    font-size: 0.9rem;
    color: var(--text);
    margin-bottom: 6px;
    line-height: 1.5;
}

/* Patterns */
.patterns-grid { display: grid; gap: 12px; grid-template-columns: 1fr; }
.pattern-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 18px;
}
.pattern-card.positive { border-left: 4px solid var(--green); }
.pattern-card.negative { border-left: 4px solid var(--red); }
.pattern-card.mixed { border-left: 4px solid var(--yellow); }
.pattern-impact {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
    margin-bottom: 6px;
}
.pattern-card.positive .pattern-impact { color: var(--green); }
.pattern-card.negative .pattern-impact { color: var(--red); }
.pattern-card.mixed .pattern-impact { color: var(--yellow); }
.pattern-text { font-size: 0.92rem; color: var(--text-bright); font-weight: 500; margin-bottom: 6px; }
.pattern-evidence { font-size: 0.82rem; color: var(--text-dim); line-height: 1.5; }

/* Recommendations */
.recs-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
.rec-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px;
    border-top: 3px solid var(--accent);
    animation: fadeUp 0.4s ease both;
    transition: border-color 0.2s;
}
.rec-card:hover { border-top-color: var(--accent2); }
@keyframes fadeUp {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
}
.rec-area {
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent);
    font-weight: 700;
    margin-bottom: 10px;
}
.rec-action { font-size: 0.9rem; line-height: 1.7; color: var(--text); }

/* Strengths + risks */
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
@media (max-width: 700px) { .two-col { grid-template-columns: 1fr; } }
.strength-item, .risk-item {
    background: var(--surface);
    border-radius: 8px;
    padding: 14px 16px;
    font-size: 0.88rem;
    line-height: 1.65;
    margin-bottom: 10px;
    border-left: 3px solid transparent;
}
.strength-item { border-left-color: var(--green); }
.risk-item { border-left-color: var(--red); }
.col-label {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
    margin-bottom: 14px;
    padding: 8px 12px;
    border-radius: 6px;
}
.col-label.green { background: rgba(158,206,106,0.1); color: var(--green); }
.col-label.red { background: rgba(247,118,142,0.1); color: var(--red); }

/* Turning points */
.turning-grid { display: flex; flex-direction: column; gap: 12px; }
.turning-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 20px;
    display: flex;
    gap: 20px;
    align-items: flex-start;
}
.turning-period {
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--orange);
    white-space: nowrap;
    background: rgba(255,158,100,0.1);
    border: 1px solid rgba(255,158,100,0.2);
    border-radius: 6px;
    padding: 4px 10px;
    min-width: 72px;
    text-align: center;
}
.turning-desc { font-size: 0.9rem; line-height: 1.7; color: var(--text); }

/* Footer */
footer {
    border-top: 1px solid var(--border);
    padding: 24px;
    text-align: center;
    font-size: 0.8rem;
    color: var(--text-dim);
    margin-top: 40px;
}
</style>
</head>
<body>
<header class="page-header">
    <div class="page-title">Life Trajectory Analysis</div>
    <div class="page-subtitle">2013 – 2026 · Based on ${insights.metadata?.total_messages?.toLocaleString() || '80,000+'} data points across AI conversations, journals, emails, and search history</div>
    <div class="page-meta">Generated ${new Date().toISOString().split('T')[0]} by DalaiLLMA · Private</div>
</header>

<nav>
    <button class="nav-btn active" onclick="showSection('trajectory')">Overall Trajectory</button>
    <button class="nav-btn" onclick="showSection('years')">Year by Year</button>
    <button class="nav-btn" onclick="showSection('patterns')">Patterns</button>
    <button class="nav-btn" onclick="showSection('turning')">Turning Points</button>
    <button class="nav-btn" onclick="showSection('strengths')">Strengths & Risks</button>
    <button class="nav-btn" onclick="showSection('recommendations')">Recommendations</button>
</nav>

<main>

<section class="section active" id="sec-trajectory">
    <div class="section-title">Overall Trajectory</div>
    <div class="section-desc">The arc of your life from 2013 to today, synthesized from all available data.</div>

    <div class="arc-container">
        ${phaseArcHtml}
    </div>

    <div class="trajectory-box">
        ${escHtml(overall.trajectory || 'No trajectory data available.').replace(/\n\n/g, '</div><div class="trajectory-box" style="margin-top:12px">')}
    </div>
</section>

<section class="section" id="sec-years">
    <div class="section-title">Year by Year</div>
    <div class="section-desc">Click any year to expand the full narrative. Each analysis is LLM-generated from that year's actual data.</div>
    <div class="years-grid">
        ${yearCardsHtml}
    </div>
</section>

<section class="section" id="sec-patterns">
    <div class="section-title">Life Patterns</div>
    <div class="section-desc">Recurring behavioral and emotional patterns identified across the full dataset.</div>
    <div class="patterns-grid">
        ${patternsHtml}
    </div>
</section>

<section class="section" id="sec-turning">
    <div class="section-title">Key Turning Points</div>
    <div class="section-desc">The moments that most significantly changed trajectory.</div>
    <div class="turning-grid">
        ${turningHtml}
    </div>
</section>

<section class="section" id="sec-strengths">
    <div class="section-title">Strengths & Risk Factors</div>
    <div class="section-desc">What the data shows about your capacities and the things that warrant attention.</div>
    <div class="two-col">
        <div>
            <div class="col-label green">✦ Strengths</div>
            ${strengthsHtml}
        </div>
        <div>
            <div class="col-label red">⚠ Risk Factors</div>
            ${risksHtml}
        </div>
    </div>
</section>

<section class="section" id="sec-recommendations">
    <div class="section-title">Action Recommendations</div>
    <div class="section-desc">Concrete, specific actions based on pattern analysis — not generic advice.</div>
    <div class="recs-grid">
        ${recsHtml}
    </div>
</section>

</main>

<footer>
    DalaiLLMA · Private analysis · ${yearKeys.length} years · ${(insights.metadata?.total_messages || 0).toLocaleString()} data points
</footer>

<script>
function showSection(id) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('sec-' + id).classList.add('active');
    event.target.classList.add('active');
}
function toggleYear(year) {
    const card = document.getElementById('year-' + year);
    card.classList.toggle('expanded');
}
</script>
</body>
</html>`;

fs.writeFileSync(OUTPUT, html);
console.log(`Written: ${OUTPUT} (${Math.round(html.length/1024)}KB)`);
