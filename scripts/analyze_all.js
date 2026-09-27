#!/usr/bin/env node
/**
 * DalaiLLMA - Parallel LLM Analysis Pipeline
 *
 * Loads ALL data sources (Claude, ChatGPT, Gemini, Google Search, sent emails, journals)
 * and runs analysis in parallel:
 * - Category classification
 * - Victim vs empowered language analysis
 * - Monthly sentiment insights
 * - Yearly narrative summaries
 * - People relationship analysis
 * - Overall patterns and recommendations
 *
 * Usage: node analyze_all.js [--force]
 *   --force: Re-analyze all months even if already processed
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// API Configuration
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'http://localhost:9988/anthropic/';
const ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'anthropic--claude-4.5-sonnet';

// Data paths - configurable via environment variables
const DATA_DIR = process.env.DATA_DIR || './data';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';

// Prefer newer/larger export in LLM Data dir
const ANTHROPIC_DATA = fs.existsSync(path.join(DATA_DIR, 'LLM Data/Anthropic/conversations.json'))
    ? path.join(DATA_DIR, 'LLM Data/Anthropic/conversations.json')
    : path.join(DATA_DIR, 'anthropic/conversations.json');

// Find OpenAI zip dynamically (check both locations)
function findOpenAIZip() {
    const searchDirs = [
        path.join(DATA_DIR, 'openai'),
        path.join(DATA_DIR, 'LLM Data/OpenAI-export')
    ];
    for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir);
        const zip = files.find(f => f.endsWith('.zip') && f.includes('Conversations'));
        if (zip) return path.join(dir, zip);
    }
    return null;
}
const OPENAI_ZIP = findOpenAIZip();

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Output files
const OUTPUT = {
    categories: path.join(OUTPUT_DIR, 'category_analysis.json'),
    insights: path.join(OUTPUT_DIR, 'llm_insights.json'),
    people: path.join(OUTPUT_DIR, 'person_insights.json'),
    dashboard: path.join(OUTPUT_DIR, 'dashboard_data.json')
};

// Parallel processing config — 10 concurrent hits the API ceiling cleanly (15+ causes 429s)
const PARALLEL_LIMIT = 10;
const BATCH_SIZE = 30;
const MAX_RETRIES = 3;

// Force re-analysis flag
const FORCE = process.argv.includes('--force');

// ============================================
// Utility Functions
// ============================================

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function callClaude(prompt, maxTokens = 2048) {
    if (!ANTHROPIC_AUTH_TOKEN) {
        throw new Error('ANTHROPIC_AUTH_TOKEN not set. Set environment variable or update script.');
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(`${ANTHROPIC_BASE_URL}v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': ANTHROPIC_AUTH_TOKEN,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: ANTHROPIC_MODEL,
                    max_tokens: maxTokens,
                    messages: [{ role: 'user', content: prompt }]
                })
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`API error ${response.status}: ${error}`);
            }

            const data = await response.json();
            return data.content[0].text;
        } catch (error) {
            if (attempt < MAX_RETRIES - 1) {
                await sleep(2000 * (attempt + 1));
            } else {
                throw error;
            }
        }
    }
}

async function runParallel(tasks, limit) {
    const results = [];
    const executing = new Set();

    for (const task of tasks) {
        const promise = task().then(result => {
            executing.delete(promise);
            return result;
        });
        results.push(promise);
        executing.add(promise);

        if (executing.size >= limit) {
            await Promise.race(executing);
        }
    }

    return Promise.all(results);
}

function getMonthKey(date) {
    return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;
}

function getYearKey(date) {
    return `${date.getFullYear()}`;
}

function parseJSON(text, fallback = null) {
    try {
        const match = text.match(/[\[{][\s\S]*[\]}]/);
        if (match) {
            return JSON.parse(match[0]);
        }
    } catch (e) {
        // ignore
    }
    return fallback;
}

// ============================================
// Data Loading — ALL Sources
// ============================================

function loadAllData() {
    console.log('Loading all data sources...');
    const allMessages = [];

    // --- Anthropic Claude ---
    const anthropicFile = ANTHROPIC_DATA;
    if (fs.existsSync(anthropicFile)) {
        const anthropic = JSON.parse(fs.readFileSync(anthropicFile, 'utf8'));
        let count = 0;
        for (const c of anthropic) {
            for (const m of (c.chat_messages || [])) {
                if (m.sender === 'human' && m.text) {
                    allMessages.push({
                        text: m.text,
                        timestamp: new Date(m.created_at || c.created_at),
                        source: 'anthropic'
                    });
                    count++;
                }
            }
        }
        console.log(`  Loaded ${count} Anthropic messages`);
    }

    // --- OpenAI ChatGPT ---
    if (OPENAI_ZIP && fs.existsSync(OPENAI_ZIP)) {
        const tempDir = '/tmp/openai_extract_dalaillma';
        execSync(`rm -rf ${tempDir} && mkdir -p ${tempDir}`);
        execSync(`unzip -q "${OPENAI_ZIP}" "conversations-*.json" -d ${tempDir} 2>/dev/null || true`);

        const files = fs.readdirSync(tempDir).filter(f => f.startsWith('conversations-'));
        let count = 0;
        for (const file of files) {
            const data = JSON.parse(fs.readFileSync(path.join(tempDir, file), 'utf8'));
            for (const conv of data) {
                const ts = new Date(conv.create_time * 1000);
                if (conv.mapping) {
                    for (const node of Object.values(conv.mapping)) {
                        if (node.message?.author?.role === 'user' && node.message?.content?.parts) {
                            const text = node.message.content.parts.filter(p => typeof p === 'string').join(' ');
                            if (text) {
                                allMessages.push({ text, timestamp: ts, source: 'openai' });
                                count++;
                            }
                        }
                    }
                }
            }
        }
        execSync(`rm -rf ${tempDir}`);
        console.log(`  Loaded ${count} OpenAI messages`);
    }

    // --- Google Gemini ---
    const geminiFile = path.join(DATA_DIR, 'gemini_prompts.json');
    if (fs.existsSync(geminiFile)) {
        const items = JSON.parse(fs.readFileSync(geminiFile, 'utf8'));
        for (const item of items) {
            if (item.text && item.timestamp) {
                allMessages.push({
                    text: item.text,
                    timestamp: new Date(item.timestamp),
                    source: 'gemini'
                });
            }
        }
        console.log(`  Loaded ${items.length} Gemini prompts`);
    }

    // --- Google Search ---
    const searchFile = path.join(DATA_DIR, 'google_searches.json');
    if (fs.existsSync(searchFile)) {
        const items = JSON.parse(fs.readFileSync(searchFile, 'utf8'));
        for (const item of items) {
            if (item.text && item.timestamp) {
                allMessages.push({
                    text: item.text,
                    timestamp: new Date(item.timestamp),
                    source: 'google_search'
                });
            }
        }
        console.log(`  Loaded ${items.length} Google searches`);
    }

    // --- Sent Emails ---
    const emailFile = path.join(DATA_DIR, 'sent_emails.json');
    if (fs.existsSync(emailFile)) {
        const items = JSON.parse(fs.readFileSync(emailFile, 'utf8'));
        for (const item of items) {
            if (item.text && item.timestamp) {
                allMessages.push({
                    text: item.text,
                    timestamp: new Date(item.timestamp),
                    source: 'email_sent'
                });
            }
        }
        console.log(`  Loaded ${items.length} sent emails`);
    }

    // --- Being Journals ---
    const beingBase = path.join(DATA_DIR, 'LLM Data/being');
    const journalDirs = ['Daily', 'livingfully', 'Therapy Sessions'];
    let journalCount = 0;
    for (const dir of journalDirs) {
        const fullDir = path.join(beingBase, dir);
        if (!fs.existsSync(fullDir)) continue;
        const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.md'));
        for (const file of files) {
            try {
                let content = fs.readFileSync(path.join(fullDir, file), 'utf8');
                // Strip YAML frontmatter
                content = content.replace(/^---[\s\S]*?---\n/, '');
                // Strip wikilinks but keep text
                content = content.replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1');
                const trimmed = content.trim();
                if (trimmed.length < 20) continue;

                // Parse date from filename (YYYY-MM-DD or similar)
                const dateMatch = file.match(/(\d{4})-(\d{2})-(\d{2})/);
                const ts = dateMatch
                    ? new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`)
                    : new Date(); // fallback to now if no date

                allMessages.push({
                    text: trimmed.substring(0, 2000),
                    timestamp: ts,
                    source: 'journal'
                });
                journalCount++;
            } catch (e) {
                // skip unreadable files
            }
        }
    }
    console.log(`  Loaded ${journalCount} journal entries`);

    // Sort by timestamp
    allMessages.sort((a, b) => a.timestamp - b.timestamp);

    // Count source breakdown
    const sourceCounts = {};
    for (const m of allMessages) {
        sourceCounts[m.source] = (sourceCounts[m.source] || 0) + 1;
    }
    console.log(`  Total: ${allMessages.length} messages across all sources`);
    console.log(`  Sources: ${Object.entries(sourceCounts).map(([k, v]) => `${k}:${v}`).join(', ')}\n`);

    return allMessages;
}

// ============================================
// Analysis Tasks
// ============================================

async function categorizeMessages(messages) {
    const truncated = messages.map(m => m.text.substring(0, 300).replace(/\n/g, ' '));

    const prompt = `Categorize these ${messages.length} messages. Categories:
- relationships, work, mental_health, practical, creative, tech, health, finance, learning, other

Messages:
${truncated.map((t, i) => `${i + 1}. "${t}"`).join('\n')}

Respond with ONLY a JSON array: ["category1", "category2", ...]`;

    const response = await callClaude(prompt, 1024);
    return parseJSON(response, messages.map(() => 'other'));
}

async function analyzeVictimLanguage(month, sample) {
    const prompt = `Analyze victim vs empowered language in these messages from ${month}:

${sample.map(m => `- "${m.substring(0, 200)}"`).join('\n')}

Respond with JSON:
{
    "victim_score": 0-100,
    "empowered_score": 0-100,
    "victim_phrases": ["phrase1", "phrase2"],
    "empowered_phrases": ["phrase1", "phrase2"],
    "dominant_pattern": "victim" | "empowered" | "mixed",
    "analysis": "Brief 2-sentence analysis"
}`;

    const response = await callClaude(prompt, 1024);
    return parseJSON(response, {
        victim_score: 50,
        empowered_score: 50,
        dominant_pattern: 'mixed',
        analysis: 'Unable to analyze'
    });
}

async function generateMonthlyInsight(month, messages, stats) {
    // Sample across sources for richer context
    const sample = messages
        .sort(() => Math.random() - 0.5)
        .slice(0, 10)
        .map(m => `[${m.source}] ${m.text.substring(0, 200)}`);

    const prompt = `Analyze this month's activity across all data sources (AI chats, searches, emails, journals):

Month: ${month}
Messages: ${messages.length}
Stats: ${JSON.stringify(stats)}

Sample entries:
${sample.map(m => `- "${m}"`).join('\n')}

Provide insights in JSON:
{
    "themes": ["theme1", "theme2", "theme3"],
    "emotional_tone": "brief description",
    "key_events": ["event1", "event2"],
    "concerns": ["concern if any"],
    "positives": ["positive if any"],
    "summary": "2-sentence summary"
}`;

    const response = await callClaude(prompt, 1024);
    return parseJSON(response, { themes: [], summary: 'Unable to analyze' });
}

async function generateYearSummary(year, yearMessages, monthlyInsights) {
    // Get months in this year that have insights
    const yearMonths = Object.entries(monthlyInsights)
        .filter(([m]) => m.startsWith(year))
        .sort(([a], [b]) => a.localeCompare(b));

    const monthLines = yearMonths
        .map(([m, d]) => `  ${m}: ${d.summary || ''} themes=[${(d.themes || []).join(', ')}]`)
        .join('\n');

    // Source breakdown for this year
    const sourceCounts = {};
    for (const m of yearMessages) {
        sourceCounts[m.source] = (sourceCounts[m.source] || 0) + 1;
    }

    // Sample diverse messages from this year
    const sampleMessages = yearMessages
        .sort(() => Math.random() - 0.5)
        .slice(0, 20)
        .map(m => `[${m.source}] ${m.text.substring(0, 150)}`);

    const prompt = `Analyze this entire year's data for a person's life. Sources include AI conversations (Claude, ChatGPT, Gemini), Google searches, sent emails, and personal journal entries.

Year: ${year}
Total entries: ${yearMessages.length}
Sources: ${Object.entries(sourceCounts).map(([k, v]) => `${k}: ${v}`).join(', ')}

Monthly summaries:
${monthLines || '  (no monthly summaries available)'}

Sample entries from ${year}:
${sampleMessages.map(m => `- "${m}"`).join('\n')}

Write a rich, honest yearly narrative summary in JSON:
{
    "narrative": "3-4 paragraph narrative of this year — major themes, life events, emotional arc, growth, struggles. Be specific and grounded in the data.",
    "major_themes": ["theme1", "theme2", "theme3", "theme4"],
    "emotional_arc": "How did the emotional tone evolve across the year?",
    "key_turning_points": ["specific event or shift with approximate month"],
    "year_in_one_sentence": "A single sentence capturing the essence of this year"
}`;

    const response = await callClaude(prompt, 2000);
    return parseJSON(response, {
        narrative: 'Summary unavailable',
        major_themes: [],
        emotional_arc: '',
        key_turning_points: [],
        year_in_one_sentence: ''
    });
}

async function extractMonthEvents(month, messages) {
    // Only use AI chat + journal + email sources — they have meaningful content
    const richMessages = messages.filter(m =>
        ['anthropic', 'openai', 'gemini', 'journal', 'email_sent'].includes(m.source)
    );
    if (richMessages.length === 0) return [];

    const sample = richMessages
        .sort(() => Math.random() - 0.5)
        .slice(0, 20)
        .map(m => `[${m.source}] ${m.text.substring(0, 200).replace(/\n/g, ' ')}`);

    const prompt = `You are reviewing a person's real digital activity from ${month}: AI conversations, journal entries, and sent emails.

Sample entries:
${sample.map(m => `- "${m}"`).join('\n')}

Identify ONLY genuinely significant life events this month (things that actually happened in the person's life — not just topics discussed). Examples: medical events, relationship changes, job events, moves, travel, ceremonies, major decisions.

Return a JSON array (empty if nothing significant):
[
  {"date": "${month}-15", "title": "Brief event title (max 60 chars)", "category": "health|relationship|work|travel|life|other"}
]

Return [] if there are no clearly significant life events. Do not invent events not supported by the data.`;

    const response = await callClaude(prompt, 512);
    return parseJSON(response, []);
}

async function generatePersonInsight(name, data) {
    const prompt = `Analyze relationship with "${name}":

Category: ${data.category || 'unknown'}
Mentions: ${data.mentions || 0}
Sentiment: ${data.sentiment || 0}
Contexts: ${(data.contexts || []).join(', ')}

Provide insights in JSON:
{
    "relationship_summary": "2-3 sentence summary",
    "strengths": ["strength1", "strength2"],
    "concerns": ["concern1"],
    "patterns": ["pattern1", "pattern2"],
    "recommendations": ["recommendation1", "recommendation2"]
}`;

    const response = await callClaude(prompt, 1024);
    return parseJSON(response, { relationship_summary: 'Unable to analyze' });
}

async function generateOverallInsights(aggregated) {
    const monthSummaries = Object.entries(aggregated.monthly || {})
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-12)
        .map(([m, d]) => {
            const themes = (d.themes || []).join(', ');
            return `${m}: themes=[${themes}] tone="${d.emotional_tone || ''}" — ${d.summary || ''}`;
        })
        .join('\n');

    const categoryTotals = Object.entries(aggregated.category_totals || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([c, n]) => `${c}: ${n}`)
        .join(', ');

    const victimSummary = Object.entries(aggregated.victim_analysis || {})
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-6)
        .map(([m, v]) => `${m}: victim=${v?.victim_score ?? '?'} empowered=${v?.empowered_score ?? '?'} pattern=${v?.dominant_pattern ?? '?'}`)
        .join('\n');

    const yearList = Object.keys(aggregated.yearly_summaries || {}).sort().join(', ');

    const prompt = `You are analyzing ${yearList ? yearList + ' — multiple years' : 'multiple years'} of a person's real digital life: AI conversations (Claude, ChatGPT, Gemini), Google searches, sent emails, and personal journals. This is their authentic inner life.

Monthly summaries (last 12 months):
${monthSummaries || 'No monthly data available'}

Top conversation categories (all time):
${categoryTotals || 'No category data'}

Victim vs empowered language scores (last 6 months, 0-100):
${victimSummary || 'No language data'}

Based on this real data, generate a deep psychological and life analysis in JSON:
{
    "patterns": [
        {"pattern": "specific recurring theme or behavior", "impact": "positive/negative/neutral", "evidence": "brief evidence from the data"}
    ],
    "turning_points": [
        {"period": "YYYY-MM", "description": "what shifted and why it matters"}
    ],
    "risk_factors": ["specific concern based on actual data"],
    "strengths": ["specific strength visible in the data"],
    "recommendations": [
        {"area": "specific life area", "action": "concrete actionable recommendation"}
    ],
    "trajectory": "2-3 sentence narrative of the overall arc and direction of this person's life/inner work"
}

Be specific, honest, and grounded in the actual data. Avoid generic platitudes.`;

    const response = await callClaude(prompt, 3000);
    return parseJSON(response, { trajectory: 'Analysis failed — check API logs' });
}

// ============================================
// People extraction from dashboard data
// ============================================

function loadPeopleFromDashboard() {
    if (!fs.existsSync(OUTPUT.dashboard)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(OUTPUT.dashboard, 'utf8'));
        return data.peopleData || null;
    } catch (e) {
        return null;
    }
}

// ============================================
// Main Pipeline
// ============================================

async function processMonth(month, messages, existingData) {
    if (!FORCE && existingData.categories?.[month] && existingData.victim?.[month]) {
        return { month, skipped: true };
    }

    const result = {
        month,
        categories: {},
        victim: null,
        insight: null,
        success: true
    };

    try {
        // Categorize messages in batches (skip pure search queries — too short/noisy)
        const substantive = messages.filter(m => m.text.length > 30 || m.source !== 'google_search');
        const toCateg = substantive.length > 0 ? substantive : messages;

        for (let i = 0; i < toCateg.length; i += BATCH_SIZE) {
            const batch = toCateg.slice(i, i + BATCH_SIZE);
            const cats = await categorizeMessages(batch);
            for (const cat of cats) {
                result.categories[cat] = (result.categories[cat] || 0) + 1;
            }
        }

        // Analyze victim language — prefer journal/AI chat entries
        const richMessages = messages.filter(m =>
            ['anthropic', 'openai', 'gemini', 'journal', 'email_sent'].includes(m.source)
        );
        const samplePool = richMessages.length > 0 ? richMessages : messages;
        const sample = samplePool
            .sort(() => Math.random() - 0.5)
            .slice(0, 15)
            .map(m => m.text);
        result.victim = await analyzeVictimLanguage(month, sample);

        // Source breakdown for this month
        const sourceCounts = {};
        for (const m of messages) {
            sourceCounts[m.source] = (sourceCounts[m.source] || 0) + 1;
        }

        result.insight = await generateMonthlyInsight(month, messages, {
            total: messages.length,
            sources: sourceCounts,
            categories: result.categories
        });

        console.log(`  ✓ ${month}`);
    } catch (error) {
        console.error(`  ✗ ${month}: ${error.message}`);
        result.success = false;
    }

    return result;
}

async function main() {
    console.log('╔════════════════════════════════════════╗');
    console.log('║   DalaiLLMA Parallel Analysis Pipeline ║');
    console.log('╚════════════════════════════════════════╝\n');

    if (!ANTHROPIC_AUTH_TOKEN) {
        console.error('ERROR: ANTHROPIC_AUTH_TOKEN not set!');
        console.error('Set it with: export ANTHROPIC_AUTH_TOKEN="your-key"');
        process.exit(1);
    }

    console.log(`Config: ${PARALLEL_LIMIT} parallel, ${BATCH_SIZE} batch size${FORCE ? ', FORCE mode' : ''}\n`);

    // Load ALL data sources
    const allMessages = loadAllData();
    if (allMessages.length === 0) {
        console.error('No data found. Check data paths.');
        process.exit(1);
    }

    // Group by month
    const messagesByMonth = {};
    for (const msg of allMessages) {
        const monthKey = getMonthKey(msg.timestamp);
        if (!messagesByMonth[monthKey]) messagesByMonth[monthKey] = [];
        messagesByMonth[monthKey].push(msg);
    }

    // Group by year
    const messagesByYear = {};
    for (const msg of allMessages) {
        const yearKey = getYearKey(msg.timestamp);
        if (!messagesByYear[yearKey]) messagesByYear[yearKey] = [];
        messagesByYear[yearKey].push(msg);
    }

    const months = Object.keys(messagesByMonth).sort();
    const years = Object.keys(messagesByYear).sort();
    console.log(`Found ${months.length} months across ${years.length} years (${years[0]}–${years[years.length - 1]})\n`);

    // Load existing data
    const existingData = {
        categories: {},
        victim: {},
        insights: {}
    };

    if (fs.existsSync(OUTPUT.categories)) {
        const data = JSON.parse(fs.readFileSync(OUTPUT.categories, 'utf8'));
        existingData.categories = data.categories || {};
        existingData.victim = data.victim_analysis || {};
    }

    // Load existing yearly summaries (don't re-run unless --force)
    let existingYearlySummaries = {};
    if (fs.existsSync(OUTPUT.insights)) {
        try {
            const d = JSON.parse(fs.readFileSync(OUTPUT.insights, 'utf8'));
            existingYearlySummaries = d.yearly_summaries || {};
        } catch (e) { /* ignore */ }
    }

    // ========== PHASE 1: Monthly Analysis (Parallel) ==========
    console.log('Phase 1: Monthly Analysis (parallel)');
    console.log('─'.repeat(40));

    const monthTasks = months.map(month => {
        return async () => processMonth(month, messagesByMonth[month], existingData);
    });

    const startTime = Date.now();
    const monthResults = await runParallel(monthTasks, PARALLEL_LIMIT);
    const elapsed1 = ((Date.now() - startTime) / 1000).toFixed(1);

    const processed = monthResults.filter(r => !r.skipped && r.success).length;
    const skipped = monthResults.filter(r => r.skipped).length;
    console.log(`\nCompleted: ${processed} processed, ${skipped} skipped (${elapsed1}s)\n`);

    // ========== PHASE 1b: Event Extraction (all months, parallel) ==========
    // Load existing events to skip months already done
    let existingEvents = [];
    if (fs.existsSync(OUTPUT.insights)) {
        try { existingEvents = JSON.parse(fs.readFileSync(OUTPUT.insights, 'utf8')).events || []; } catch(e) {}
    }
    const monthsWithEvents = new Set(existingEvents.map(e => e.date?.substring(0, 7)));
    const monthsNeedingEvents = FORCE ? months : months.filter(m => !monthsWithEvents.has(m));

    if (monthsNeedingEvents.length > 0) {
        console.log(`Phase 1b: Event Extraction (${monthsNeedingEvents.length} months, parallel)`);
        console.log('─'.repeat(40));

        const eventTasks = monthsNeedingEvents.map(month => async () => {
            try {
                const events = await extractMonthEvents(month, messagesByMonth[month]);
                if (events.length) console.log(`  ✓ ${month}: ${events.length} events`);
                return { month, events };
            } catch(e) {
                return { month, events: [] };
            }
        });

        const eventResults = await runParallel(eventTasks, PARALLEL_LIMIT);
        const newEvents = eventResults.flatMap(r => r.events);
        existingEvents = [...existingEvents.filter(e => !monthsNeedingEvents.includes(e.date?.substring(0,7))), ...newEvents];
        console.log(`\n  Total events: ${existingEvents.length}\n`);
    }

    // ========== PHASE 2: Aggregation ==========
    console.log('Phase 2: Aggregation');
    console.log('─'.repeat(40));

    const aggregated = {
        categories: { ...existingData.categories },
        victim_analysis: { ...existingData.victim },
        monthly: {},
        events: existingEvents,
        category_totals: {},
        yearly_summaries: {},
        generated_at: new Date().toISOString()
    };

    for (const result of monthResults) {
        if (result.skipped) {
            // Carry forward existing insights for skipped months
            if (existingData.categories[result.month]) {
                aggregated.categories[result.month] = existingData.categories[result.month];
            }
            if (existingData.victim[result.month]) {
                aggregated.victim_analysis[result.month] = existingData.victim[result.month];
            }
            // Load existing monthly insight for skipped months
            if (fs.existsSync(OUTPUT.insights)) {
                try {
                    const d = JSON.parse(fs.readFileSync(OUTPUT.insights, 'utf8'));
                    if (d.monthly?.[result.month]) {
                        aggregated.monthly[result.month] = d.monthly[result.month];
                    }
                } catch (e) { /* ignore */ }
            }
            continue;
        }
        if (result.success) {
            aggregated.categories[result.month] = result.categories;
            aggregated.victim_analysis[result.month] = result.victim;
            aggregated.monthly[result.month] = result.insight;
        }
    }

    // Calculate category totals
    for (const monthCats of Object.values(aggregated.categories)) {
        for (const [cat, count] of Object.entries(monthCats)) {
            aggregated.category_totals[cat] = (aggregated.category_totals[cat] || 0) + count;
        }
    }

    console.log('  Category totals:');
    const sorted = Object.entries(aggregated.category_totals).sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((s, [, c]) => s + c, 0);
    for (const [cat, count] of sorted) {
        console.log(`    ${cat}: ${count} (${(count / total * 100).toFixed(1)}%)`);
    }

    fs.writeFileSync(OUTPUT.categories, JSON.stringify(aggregated, null, 2));
    console.log(`\n  Saved: ${OUTPUT.categories}\n`);

    // ========== PHASE 3: Yearly Summaries (Parallel) ==========
    console.log('Phase 3: Yearly Summaries (parallel)');
    console.log('─'.repeat(40));

    const yearTasks = years
        .filter(year => FORCE || !existingYearlySummaries[year])
        .map(year => {
            return async () => {
                try {
                    const summary = await generateYearSummary(year, messagesByYear[year], aggregated.monthly);
                    console.log(`  ✓ ${year}`);
                    return { year, summary, success: true };
                } catch (e) {
                    console.error(`  ✗ ${year}: ${e.message}`);
                    return { year, success: false };
                }
            };
        });

    const yearResults = await runParallel(yearTasks, PARALLEL_LIMIT);

    aggregated.yearly_summaries = { ...existingYearlySummaries };
    for (const result of yearResults) {
        if (result.success) {
            aggregated.yearly_summaries[result.year] = {
                ...result.summary,
                message_count: messagesByYear[result.year]?.length || 0,
                generated_at: new Date().toISOString()
            };
        }
    }

    console.log(`\n  Generated ${Object.keys(aggregated.yearly_summaries).length} yearly summaries\n`);

    // ========== PHASE 4: People Analysis (Parallel) ==========
    console.log('Phase 4: People Analysis (parallel)');
    console.log('─'.repeat(40));

    // Load real people data from dashboard if available
    const dashboardPeople = loadPeopleFromDashboard();
    const people = dashboardPeople
        ? Object.entries(dashboardPeople).reduce((acc, [name, data]) => {
            acc[name] = {
                category: data.context || 'unknown',
                mentions: Object.values(data.byMonth || {}).reduce((s, v) => s + v, 0),
                sentiment: data.sentiment || 0,
                contexts: [data.context || 'unknown']
            };
            return acc;
        }, {})
        : {
            liliia: { category: 'ex-partner', mentions: 120, sentiment: -0.15, contexts: ['relationship', 'boundaries'] },
            sarah: { category: 'friend', mentions: 45, sentiment: 0.3, contexts: ['friendship', 'support'] },
            mother: { category: 'family', mentions: 85, sentiment: -0.2, contexts: ['family dynamics', 'childhood'] },
            father: { category: 'family', mentions: 42, sentiment: -0.1, contexts: ['family dynamics'] },
            therapist: { category: 'professional', mentions: 156, sentiment: 0.1, contexts: ['therapy', 'IFS'] }
        };

    const existingPeople = fs.existsSync(OUTPUT.people)
        ? JSON.parse(fs.readFileSync(OUTPUT.people, 'utf8'))
        : {};

    const peopleTasks = Object.entries(people)
        .filter(([name]) => FORCE || !existingPeople[name])
        .map(([name, data]) => {
            return async () => {
                try {
                    const insight = await generatePersonInsight(name, data);
                    console.log(`  ✓ ${name}`);
                    return { name, insight, success: true };
                } catch (e) {
                    console.log(`  ✗ ${name}`);
                    return { name, success: false };
                }
            };
        });

    const peopleResults = await runParallel(peopleTasks, PARALLEL_LIMIT);

    const peopleData = { ...existingPeople };
    for (const result of peopleResults) {
        if (result.success) {
            peopleData[result.name] = {
                ...result.insight,
                generated_at: new Date().toISOString()
            };
        }
    }

    fs.writeFileSync(OUTPUT.people, JSON.stringify(peopleData, null, 2));
    console.log(`\n  Saved: ${OUTPUT.people}\n`);

    // ========== PHASE 5: Overall Insights ==========
    console.log('Phase 5: Overall Insights');
    console.log('─'.repeat(40));

    try {
        const overallInsights = await generateOverallInsights(aggregated);
        const insightsOutput = {
            insights: overallInsights,
            monthly: aggregated.monthly,
            yearly_summaries: aggregated.yearly_summaries,
            events: aggregated.events.sort((a, b) => a.date?.localeCompare(b.date)),
            generated_at: new Date().toISOString()
        };
        fs.writeFileSync(OUTPUT.insights, JSON.stringify(insightsOutput, null, 2));
        console.log(`  ✓ Generated overall insights`);
        console.log(`  Saved: ${OUTPUT.insights}\n`);
    } catch (e) {
        console.error(`  ✗ Failed: ${e.message}\n`);
    }

    // ========== Summary ==========
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('═'.repeat(40));
    console.log(`Complete! Total time: ${totalTime}s`);
    console.log('═'.repeat(40));
    console.log('\nGenerated files:');
    console.log(`  ${OUTPUT.categories}`);
    console.log(`  ${OUTPUT.insights}`);
    console.log(`  ${OUTPUT.people}`);
    console.log('\nNext: Run "node scripts/process_data.js && node scripts/build_dashboard.js"');
}

main().catch(console.error);
