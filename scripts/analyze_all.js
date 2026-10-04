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
const crypto = require('crypto');
const { execSync } = require('child_process');
const chatSources = require('./lib/chat_sources');
const outliers = require('./lib/outliers');

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

// Parallel processing config. The upstream proxy rate-limits aggressively, but
// the retry/backoff below (429-aware, honors retry-after, 90s abort→retry) makes
// over-shooting self-correcting rather than fatal — so fan out more and let 429s
// throttle us back. Overridable via PARALLEL_LIMIT env var for tuning.
const PARALLEL_LIMIT = Number(process.env.PARALLEL_LIMIT) || 8;
const BATCH_SIZE = 30;
const MAX_RETRIES = 6;
// Abort any single request that hangs longer than this (ms), so a stuck
// connection becomes a retry instead of stalling the whole parallel batch.
const REQUEST_TIMEOUT_MS = 90000;

// Monthly digest (hierarchical map-reduce over ALL of a month's rich messages,
// replacing random sampling). See buildMonthlyDigest.
const DIGEST_CHUNK_CHARS = 40000; // max message-text chars packed into one map call
const DIGEST_MSG_TRUNC = 1000;    // per-message truncation inside a chunk
const DIGEST_MAX_CHARS = 6000;    // target size of the final digest handed to passes
// Rich (content-bearing) sources the digest is built from — excludes google_search noise.
const RICH_SOURCES = ['anthropic', 'openai', 'gemini', 'journal', 'email_sent',
    'whatsapp', 'telegram', 'twitter', 'twitter_dm'];

// Nervous-system / trauma-response states tracked per month (general) and per person.
// Includes 'centered' as the positive/regulated anchor state (being in one's center —
// grounded, embodied, not self-abandoning — in the Aikido / Alexander-technique / contact-improv sense).
const NERVOUS_STATES = ['fawn', 'dominate', 'fight', 'flight', 'freeze', 'avoid', 'anxious', 'centered'];

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
        // Abort a request that hangs — the proxy sometimes accepts the connection
        // under load but never responds, which would otherwise stall the whole
        // parallel batch forever. An abort throws → handled as a retry below.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                const error = await response.text();
                // On rate-limit, honor the server's requested wait (header or message)
                // before the generic backoff kicks in; surface it via the thrown error.
                if (response.status === 429 && attempt < MAX_RETRIES - 1) {
                    const headerWait = Number(response.headers.get('retry-after'));
                    const msgMatch = error.match(/retry after (\d+)/i);
                    const serverWait = (headerWait && !isNaN(headerWait))
                        ? headerWait
                        : (msgMatch ? Number(msgMatch[1]) : 0);
                    // exponential backoff + jitter, floored by the server's hint
                    const backoff = Math.max(serverWait * 1000, 1500 * 2 ** attempt);
                    await sleep(backoff + Math.floor(Math.random() * 1000));
                    continue;
                }
                throw new Error(`API error ${response.status}: ${error}`);
            }

            const data = await response.json();
            return data.content[0].text;
        } catch (error) {
            if (attempt < MAX_RETRIES - 1) {
                await sleep(1500 * 2 ** attempt + Math.floor(Math.random() * 1000));
            } else {
                throw error;
            }
        } finally {
            clearTimeout(timeout);
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
    // Use the shared parseMarkdownEntry so dating is consistent with
    // loadBeingVaultExtra: filename YYYY-MM-DD / DD.MM.YYYY, else frontmatter
    // created:/date:. Undatable notes are SKIPPED (never stamped with today's
    // date) — the old inline fallback to new Date() dumped ~683 undated
    // livingfully/therapy notes into the current year, polluting recent years
    // with content that actually belonged to 2021–2024.
    const beingBase = path.join(DATA_DIR, 'LLM Data/being');
    const journalDirs = ['Daily', 'livingfully', 'Therapy Sessions'];
    let journalCount = 0;
    let journalSkipped = 0;
    for (const dir of journalDirs) {
        const fullDir = path.join(beingBase, dir);
        if (!fs.existsSync(fullDir)) continue;
        const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.md'));
        for (const file of files) {
            const rec = chatSources.parseMarkdownEntry(path.join(fullDir, file), file);
            if (rec) {
                allMessages.push(rec);
                journalCount++;
            } else {
                journalSkipped++;
            }
        }
    }
    console.log(`  Loaded ${journalCount} journal entries${journalSkipped ? ` (${journalSkipped} skipped: too short or undatable)` : ''}`);

    // --- New chat/message sources (WhatsApp, Telegram, Twitter) + rest of Obsidian vault ---
    // These return the same flat {text, timestamp, source, [sender], [participants]} shape.
    const llmDataDir = path.join(DATA_DIR, 'LLM Data');
    allMessages.push(...chatSources.loadWhatsApp(path.join(llmDataDir, 'Whatsapp export')));
    allMessages.push(...chatSources.loadTelegram(path.join(llmDataDir, 'Telegram_Export_2026-09-28', 'result.json')));
    const twitterDir = fs.existsSync(llmDataDir)
        ? fs.readdirSync(llmDataDir).find(d => d.startsWith('twitter-'))
        : null;
    if (twitterDir) allMessages.push(...chatSources.loadTwitter(path.join(llmDataDir, twitterDir, 'data')));
    allMessages.push(...chatSources.loadBeingVaultExtra(path.join(llmDataDir, 'being')));

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

async function analyzeVictimLanguage(month, digestText) {
    const prompt = `Analyze victim vs empowered language in this digest of all of a person's entries from ${month}:

${digestText}

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

async function analyzeNervousSystem(month, digestText) {
    const prompt = `Analyze the dominant nervous-system / trauma-response states evidenced in this digest of all of a person's entries from ${month}.

Score each of these 8 states 0-100 by how strongly it shows up in the person's language and behavior this month:
- fawn: appeasing, people-pleasing, self-abandoning to keep others comfortable
- dominate: controlling, over-powering, aggressive assertion of control
- fight: anger, confrontation, defensiveness, hostility
- flight: escaping, over-busyness, fleeing situations, distraction
- freeze: shutdown, numbness, paralysis, dissociation, inability to act
- avoid: withdrawal, isolation, avoidance of people/feelings/tasks
- anxious: worry, hypervigilance, rumination, catastrophizing
- centered: grounded, embodied, present, resourced — being in one's center (Aikido / Alexander-technique / contact-improv sense); responding from choice rather than reactivity, NOT self-abandoning

Digest:
${digestText}

Respond with JSON:
{
    "scores": { ${NERVOUS_STATES.map(s => `"${s}": 0-100`).join(', ')} },
    "dominant_state": "${NERVOUS_STATES.join('" | "')}" | "unclear",
    "evidence_phrases": ["short phrase from the data supporting the dominant state"],
    "analysis": "Brief 2-sentence analysis of the nervous-system picture this month"
}`;

    const response = await callClaude(prompt, 1024);
    return parseJSON(response, {
        scores: Object.fromEntries(NERVOUS_STATES.map(s => [s, 50])),
        dominant_state: 'unclear',
        evidence_phrases: [],
        analysis: 'Unable to analyze'
    });
}

async function generateMonthlyInsight(month, digestText, stats) {
    const prompt = `Analyze this month's activity across all data sources (AI chats, searches, emails, journals), summarized in the digest below:

Month: ${month}
Stats: ${JSON.stringify(stats)}

Digest:
${digestText}

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

async function extractMonthEvents(month, digestText) {
    if (!digestText) return [];

    const prompt = `You are reviewing a digest of a person's real digital activity from ${month} (AI conversations, journal entries, sent emails, chats).

Digest:
${digestText}

Identify ONLY genuinely significant life events this month (things that actually happened in the person's life — not just topics discussed). Examples: medical events, relationship changes, job events, moves, travel, ceremonies, major decisions.

Return a JSON array (empty if nothing significant):
[
  {"date": "${month}-15", "title": "Brief event title (max 60 chars)", "category": "health|relationship|work|travel|life|other"}
]

Return [] if there are no clearly significant life events. Do not invent events not supported by the data.`;

    const response = await callClaude(prompt, 512);
    return parseJSON(response, []);
}

async function extractMonthRelationships(month, digestText) {
    if (!digestText) return { romantic: [], friendships: [], notes: '' };

    const prompt = `You are reading a digest of a person's real private data from ${month} (AI conversations, journal entries, sent emails, chats).

Digest:
${digestText}

Extract ONLY what is directly evidenced in the data about the person's actual relationships this month. Use real names when they appear.

For each person, the nervous_state.scores are 0-100 intensities for how much each trauma-response/nervous-system state showed up in the dynamic WITH THAT PERSON this month (they need not sum to 100; use 0 when a state is absent; 'centered' = grounded, embodied, not self-abandoning). dominant_state must be the highest-scoring state.

Return JSON:
{
  "romantic": [
    {
      "name": "person's name or 'unnamed'",
      "type": "casual|dating|long-term|ex|crush|unclear",
      "status": "active|ended|complicated|rekindling|mourning|unclear",
      "mood": "brief phrase about emotional tone, e.g. 'tender, uncertain' or 'grief, longing'",
      "nervous_state": {
        "dominant_state": "fawn|dominate|fight|flight|freeze|avoid|anxious|centered|unclear",
        "state_note": "one short phrase on the trauma-response/nervous-system dynamic evidenced with this person (centered = grounded, not self-abandoning), or '' if none",
        "scores": { "fawn": 0, "dominate": 0, "fight": 0, "flight": 0, "freeze": 0, "avoid": 0, "anxious": 0, "centered": 0 }
      },
      "notes": "1-2 sentences of what is evidenced — specific, not inferred beyond the data"
    }
  ],
  "friendships": [
    {
      "name": "person's name",
      "quality": "close|distant|conflicted|new|rekindling|unclear",
      "nervous_state": {
        "dominant_state": "fawn|dominate|fight|flight|freeze|avoid|anxious|centered|unclear",
        "state_note": "one short phrase on the nervous-system dynamic evidenced with this person (centered = grounded, not self-abandoning), or ''",
        "scores": { "fawn": 0, "dominate": 0, "fight": 0, "flight": 0, "freeze": 0, "avoid": 0, "anxious": 0, "centered": 0 }
      },
      "notes": "1-2 sentences"
    }
  ],
  "notes": "any other relational context worth noting (e.g. isolation, longing for connection, social contraction)"
}

Return empty arrays if nothing is clearly evidenced. Do not invent or infer beyond what is in the data.`;

    const response = await callClaude(prompt, 1024);
    return parseJSON(response, { romantic: [], friendships: [], notes: '' });
}

async function extractMonthSubstances(month, digestText) {
    if (!digestText) return { substances: [], notes: '' };

    const prompt = `You are reading a digest of a person's real private data from ${month} (AI conversations, journal entries, sent emails, chats).

Digest:
${digestText}

Extract ONLY what is directly evidenced about substance use — alcohol, cannabis, psychedelics (MDMA, psilocybin, LSD, ketamine, etc.), stimulants, medication misuse, or anything else psychoactive. Include therapeutic/ceremonial use (e.g. MDMA therapy, ayahuasca retreat) as well as recreational or self-medicating use.

Return JSON:
{
  "substances": [
    {
      "substance": "name (e.g. 'cannabis', 'MDMA', 'alcohol', 'psilocybin')",
      "context": "therapeutic|recreational|self-medicating|ceremonial|research/interest|unclear",
      "frequency": "one-off|occasional|regular|unclear",
      "tone": "brief phrase — e.g. 'exploratory, positive', 'numbing, concerning', 'intentional, processed'",
      "notes": "1-2 sentences of what is evidenced"
    }
  ],
  "notes": "any broader pattern — e.g. increase in use during stress, interest without action, abstinence noted"
}

Return empty array if nothing is evidenced. Do not invent. Research/curiosity counts as 'research/interest' context.`;

    const response = await callClaude(prompt, 1024);
    return parseJSON(response, { substances: [], notes: '' });
}

async function synthesizeRelationshipArcs(relationshipMonthly) {
    // Collect all named people across months
    const peopleMonths = {}; // name -> [{month, data}]

    for (const [month, data] of Object.entries(relationshipMonthly)) {
        for (const r of (data.romantic || [])) {
            if (!r.name || r.name === 'unnamed') continue;
            const key = r.name.toLowerCase();
            if (!peopleMonths[key]) peopleMonths[key] = { name: r.name, type: 'romantic', entries: [] };
            peopleMonths[key].entries.push({ month, ...r });
        }
        for (const f of (data.friendships || [])) {
            if (!f.name) continue;
            const key = f.name.toLowerCase();
            if (!peopleMonths[key]) peopleMonths[key] = { name: f.name, type: 'friendship', entries: [] };
            peopleMonths[key].entries.push({ month, ...f });
        }
    }

    // Only synthesize people with 2+ months of data
    const eligible = Object.values(peopleMonths).filter(p => p.entries.length >= 2);
    if (eligible.length === 0) return {};

    const arcs = {};
    const tasks = eligible.map(person => async () => {
        const entriesSorted = person.entries.sort((a, b) => a.month.localeCompare(b.month));
        const firstMonth = entriesSorted[0].month;
        const lastMonth = entriesSorted[entriesSorted.length - 1].month;
        const entryLines = entriesSorted.map(e =>
            `  ${e.month}: ${e.notes || ''} [${e.status || e.quality || ''}] ${e.mood || ''} {state: ${e.nervous_state?.dominant_state || '?'}${e.nervous_state?.state_note ? ` — ${e.nervous_state.state_note}` : ''}}`
        ).join('\n');

        const prompt = `Synthesize the arc of this relationship across ${entriesSorted.length} months (${firstMonth} to ${lastMonth}).

Person: ${person.name} (${person.type})
Monthly data:
${entryLines}

Return JSON:
{
  "name": "${person.name}",
  "type": "${person.type}",
  "period": "${firstMonth} to ${lastMonth}",
  "arc_summary": "3-4 sentences describing the arc of this relationship — what it was, how it evolved, what it meant emotionally",
  "key_phases": ["brief phase description with approximate month, e.g. 'early 2023: intense connection'"],
  "emotional_weight": "light|moderate|significant|heavy",
  "nervous_system_arc": "1-2 sentences on how the person's dominant nervous-system/trauma-response states shifted across this relationship (e.g. 'early fawning → later avoidance and freeze'); '' if not evidenced",
  "status_at_end": "brief phrase describing where this relationship stood at the last data point"
}`;

        const response = await callClaude(prompt, 800);
        const result = parseJSON(response, null);
        if (result) {
            console.log(`  ✓ arc: ${person.name}`);
            arcs[person.name.toLowerCase()] = result;
        }
        return result;
    });

    await runParallel(tasks, PARALLEL_LIMIT);
    return arcs;
}

async function synthesizeSubstanceArcs(substanceMonthly) {
    // Collect per-substance monthly entries
    const substanceMonths = {}; // substance -> [{month, data}]

    for (const [month, data] of Object.entries(substanceMonthly)) {
        for (const s of (data.substances || [])) {
            if (!s.substance) continue;
            const key = s.substance.toLowerCase();
            if (!substanceMonths[key]) substanceMonths[key] = { name: s.substance, entries: [] };
            substanceMonths[key].entries.push({ month, ...s });
        }
    }

    const eligible = Object.values(substanceMonths).filter(p => p.entries.length >= 2);
    if (eligible.length === 0) return {};

    const arcs = {};
    const tasks = eligible.map(substance => async () => {
        const entriesSorted = substance.entries.sort((a, b) => a.month.localeCompare(b.month));
        const firstMonth = entriesSorted[0].month;
        const lastMonth = entriesSorted[entriesSorted.length - 1].month;
        const entryLines = entriesSorted.map(e =>
            `  ${e.month}: ${e.notes || ''} [context: ${e.context || '?'}] [freq: ${e.frequency || '?'}] tone: ${e.tone || ''}`
        ).join('\n');

        const prompt = `Synthesize the pattern of use for this substance across ${entriesSorted.length} months (${firstMonth} to ${lastMonth}).

Substance: ${substance.name}
Monthly data:
${entryLines}

Return JSON:
{
  "substance": "${substance.name}",
  "period": "${firstMonth} to ${lastMonth}",
  "arc_summary": "2-3 sentences describing the pattern — how use evolved, what contexts it appeared in, any shift over time",
  "dominant_context": "therapeutic|recreational|self-medicating|ceremonial|research|mixed",
  "trend": "increasing|decreasing|stable|episodic|unclear",
  "concern_level": "none|low|moderate|high",
  "notes": "anything notable about the relationship with this substance across time"
}`;

        const response = await callClaude(prompt, 600);
        const result = parseJSON(response, null);
        if (result) {
            console.log(`  ✓ substance arc: ${substance.name}`);
            arcs[substance.name.toLowerCase()] = result;
        }
        return result;
    });

    await runParallel(tasks, PARALLEL_LIMIT);
    return arcs;
}

/**
 * Aggregate per-person monthly nervous-system scores from relationship_monthly.
 *
 * Each romantic/friendship entry carries a nervous_state.scores block (8 states,
 * 0-100) describing the dynamic WITH THAT PERSON that month. This rolls those
 * into {personKey: {YYYY-MM: {scores:{8}, dominant_state}}}, keyed by
 * name.toLowerCase() to match relationship_arcs / dashboard person keys. When a
 * person shows up in multiple entries in one month, scores are averaged.
 *
 * NO LLM — pure reshaping of data already produced upstream.
 */
function aggregatePersonNervousMonthly(relationshipMonthly) {
    // key -> month -> { sums:{state:total}, n }
    const acc = {};

    const ingest = (month, entry) => {
        const name = entry?.name;
        if (!name || name === 'unnamed') return;
        const scores = entry?.nervous_state?.scores;
        if (!scores || typeof scores !== 'object') return;
        // Require at least one non-zero numeric score to count as signal.
        const hasSignal = NERVOUS_STATES.some(s => typeof scores[s] === 'number' && scores[s] > 0);
        if (!hasSignal) return;

        const key = name.toLowerCase();
        if (!acc[key]) acc[key] = {};
        if (!acc[key][month]) acc[key][month] = { sums: {}, n: 0 };
        const bucket = acc[key][month];
        for (const s of NERVOUS_STATES) {
            const v = typeof scores[s] === 'number' && !isNaN(scores[s]) ? scores[s] : 0;
            bucket.sums[s] = (bucket.sums[s] || 0) + v;
        }
        bucket.n += 1;
    };

    for (const [month, data] of Object.entries(relationshipMonthly || {})) {
        for (const r of (data.romantic || [])) ingest(month, r);
        for (const f of (data.friendships || [])) ingest(month, f);
    }

    const out = {};
    for (const [key, months] of Object.entries(acc)) {
        const monthly = {};
        for (const [month, { sums, n }] of Object.entries(months)) {
            const scores = {};
            for (const s of NERVOUS_STATES) {
                scores[s] = n > 0 ? Math.round(sums[s] / n) : 0;
            }
            const dominant_state = NERVOUS_STATES
                .reduce((best, s) => (scores[s] > scores[best] ? s : best), NERVOUS_STATES[0]);
            monthly[month] = { scores, dominant_state };
        }
        // Only keep people with 2+ months of nervous-system signal (matches arc eligibility).
        if (Object.keys(monthly).length >= 2) out[key] = monthly;
    }
    return out;
}

// ============================================
// Social clusters (co-membership + co-mention → LLM-named communities)
// ============================================

// Names that are "me" — never a cluster node. From chatSources.ME config.
const SELF_NAMES = new Set((chatSources.ME?.names || ['me', 'myself', 'you']).map(s => String(s).toLowerCase()));
function isSelfName(name) {
    const n = String(name || '').trim().toLowerCase();
    return !n || SELF_NAMES.has(n) || n === 'human' || n === 'unnamed';
}

/**
 * Build social-graph signal from raw messages + relationship data, with NO LLM.
 *
 * Two edge sources:
 *   1. Co-membership — people who appear together as `participants` in the same
 *      group chat (isGroup / multi-participant), per month.
 *   2. Co-mention — people named together in the same month's relationship_monthly.
 *
 * Returns { nodes: {name: {months:Set→count}}, coMembership: {pairKey: {count, chats:Set, months:Set}},
 *           groupChats: {chatName: {members:Set, months:Set}} } reshaped to plain
 * objects/arrays, plus a compact text digest for the LLM.
 */
function buildSocialSignal(messagesByMonth, relationshipMonthly) {
    const nodeMonths = {};      // name -> Set(months)
    const pairMonths = {};      // "a|b" -> Set(months)
    const pairChats = {};       // "a|b" -> Set(chatName)
    const groupChats = {};      // chatName -> { members:Set, months:Set }

    const norm = (n) => String(n || '').trim();
    const addNode = (name, month) => {
        const k = name.toLowerCase();
        (nodeMonths[k] = nodeMonths[k] || new Set()).add(month);
    };
    const addPair = (a, b, month, chat) => {
        const ka = a.toLowerCase(), kb = b.toLowerCase();
        if (ka === kb) return;
        const key = [ka, kb].sort().join('|');
        (pairMonths[key] = pairMonths[key] || new Set()).add(month);
        if (chat) (pairChats[key] = pairChats[key] || new Set()).add(chat);
    };

    // 1. Co-membership from group-chat participants.
    for (const [month, msgs] of Object.entries(messagesByMonth || {})) {
        // chatName -> Set(participants seen this month)
        const chatMembersThisMonth = {};
        for (const m of msgs) {
            const chat = m.chatName;
            const parts = Array.isArray(m.participants) ? m.participants : null;
            if (!chat || !parts || parts.length < 3) continue; // group chats only (self + 2+ others)
            const others = parts.map(norm).filter(p => !isSelfName(p));
            if (others.length < 2) continue; // need 2+ non-self members to form a community edge
            const set = (chatMembersThisMonth[chat] = chatMembersThisMonth[chat] || new Set());
            others.forEach(p => set.add(p));
        }
        for (const [chat, members] of Object.entries(chatMembersThisMonth)) {
            const arr = [...members];
            const g = (groupChats[chat] = groupChats[chat] || { members: new Set(), months: new Set() });
            g.months.add(month);
            arr.forEach(p => { g.members.add(p); addNode(p, month); });
            for (let i = 0; i < arr.length; i++)
                for (let j = i + 1; j < arr.length; j++)
                    addPair(arr[i], arr[j], month, chat);
        }
    }

    // 2. Co-mention from relationship_monthly (people named in the same month).
    for (const [month, data] of Object.entries(relationshipMonthly || {})) {
        const named = [
            ...(data.romantic || []).map(r => r.name),
            ...(data.friendships || []).map(f => f.name)
        ].map(norm).filter(n => !isSelfName(n));
        const uniq = [...new Set(named.map(n => n.toLowerCase()))];
        uniq.forEach(n => addNode(n, month));
        for (let i = 0; i < uniq.length; i++)
            for (let j = i + 1; j < uniq.length; j++)
                addPair(uniq[i], uniq[j], month, null);
    }

    // Reshape to plain, serialisable structures.
    const nodes = {};
    for (const [name, months] of Object.entries(nodeMonths)) nodes[name] = { months: [...months].sort() };
    const pairs = Object.entries(pairMonths).map(([key, months]) => {
        const [a, b] = key.split('|');
        return { a, b, months: [...months].sort(), chats: [...(pairChats[key] || [])] };
    }).sort((x, y) => y.months.length - x.months.length);
    const groups = Object.entries(groupChats).map(([chat, g]) => ({
        chat, members: [...g.members], months: [...g.months].sort()
    })).sort((x, y) => y.members.length - x.members.length);

    return { nodes, pairs, groups };
}

/**
 * LLM pass: name & characterise social clusters from the co-membership/co-mention
 * signal. Returns { clusters: [{id,name,members,summary,months:{YYYY-MM:{strength,note}}}] }.
 * Skip-cached by the caller. No personal data is hardcoded — all text is LLM output.
 */
async function synthesizeSocialClusters(signal) {
    const { nodes, pairs, groups } = signal;
    const nodeCount = Object.keys(nodes).length;
    // Need enough signal to be meaningful.
    if (nodeCount < 4 || (pairs.length < 3 && groups.length < 1)) {
        return { clusters: [] };
    }

    const groupLines = groups.slice(0, 20).map(g =>
        `  "${g.chat}" (${g.months[0]}–${g.months[g.months.length - 1]}): ${g.members.slice(0, 12).join(', ')}`
    ).join('\n');
    const pairLines = pairs.slice(0, 60).map(p =>
        `  ${p.a} + ${p.b}  [${p.months.length} mo${p.chats.length ? `, chats: ${p.chats.slice(0,2).join('/')}` : ''}]`
    ).join('\n');

    const prompt = `You are detecting social communities/clusters from co-occurrence data in a person's private chats and relationships. "Co-membership" = people who appear together in the same group chat. "Co-mention" = people referenced in the same month.

Group chats (name: members):
${groupLines || '  (none)'}

Strongest co-occurrence pairs (person + person [months together]):
${pairLines || '  (none)'}

Identify 2–8 distinct social clusters (friend groups, communities, scenes, family, work circles, etc.). Group people who co-occur. A person may belong to more than one cluster. Give each a short human-readable name describing the community (e.g. "Berlin climbing crew", "university friends", "family"). Base membership ONLY on the co-occurrence data — do not invent people.

Return JSON:
{
  "clusters": [
    {
      "id": "short-slug",
      "name": "human-readable cluster name",
      "members": ["name", "name", ...],
      "summary": "1-2 sentences on what connects this group and its character",
      "months": { "YYYY-MM": { "strength": 0-100, "note": "brief if notable, else ''" } }
    }
  ]
}

For months, include only the months where the cluster shows meaningful co-activity (strength = rough 0-100 intensity). Keep it grounded in the data. Return {"clusters": []} if no clear communities emerge.`;

    const response = await callClaude(prompt, 2048);
    const result = parseJSON(response, { clusters: [] });
    if (!result || !Array.isArray(result.clusters)) return { clusters: [] };
    // Defensive: strip any self that slipped in; drop empty clusters.
    result.clusters = result.clusters
        .map(c => ({
            id: c.id || (c.name || 'cluster').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
            name: c.name || 'Unnamed cluster',
            members: [...new Set((c.members || []).filter(m => !isSelfName(m)))],
            summary: c.summary || '',
            months: c.months && typeof c.months === 'object' ? c.months : {}
        }))
        .filter(c => c.members.length >= 2);
    return result;
}

async function synthesizeNervousSystemArc(nervousMonthly) {
    const monthLines = Object.entries(nervousMonthly || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([m, d]) => {
            const scores = d?.scores || {};
            const top = NERVOUS_STATES
                .map(s => [s, scores[s] ?? 0])
                .sort((a, b) => b[1] - a[1])
                .slice(0, 2)
                .map(([s, v]) => `${s}=${v}`)
                .join(', ');
            return `  ${m}: dominant=${d?.dominant_state || '?'} [${top}]`;
        })
        .join('\n');

    if (!monthLines) return null;

    const prompt = `Synthesize the overall arc of this person's nervous-system / trauma-response patterns across time, based on monthly dominant-state readings (states: ${NERVOUS_STATES.join(', ')}).

Monthly data:
${monthLines}

Return JSON:
{
  "arc_summary": "3-4 sentences on how the dominant nervous-system states evolved across the whole period — which responses dominated when, and the overall trajectory",
  "dominant_overall": "the single most prevalent state across the whole period",
  "shifts": ["notable shift with approximate time, e.g. '2015-2018: chronic freeze/avoid', '2022+: more fight and anxious, less fawn'"],
  "current_tendency": "brief phrase on the most recent tendency",
  "regulation_trend": "improving|worsening|stable|mixed|unclear (improving = more 'centered', less dysregulation over time)"
}`;

    const response = await callClaude(prompt, 1024);
    return parseJSON(response, null);
}

// Aggregate per-person nervous system monthly scores from relationship_monthly
function aggregatePersonNervousMonthly(relationshipMonthly) {
    const out = {}; // lowercased name -> { YYYY-MM: { scores, dominant_state, state_note } }
    for (const [month, data] of Object.entries(relationshipMonthly || {})) {
        const entries = [
            ...(data?.romantic || []),
            ...(data?.friendships || [])
        ];
        for (const entry of entries) {
            const rawName = entry?.name;
            if (!rawName || rawName === 'unnamed') continue;
            const key = rawName.toLowerCase().trim();
            const ns = entry.nervous_state;
            if (!ns) continue;
            if (!out[key]) out[key] = {};
            out[key][month] = {
                dominant_state: ns.dominant_state || 'unclear',
                state_note: ns.state_note || '',
                scores: ns.scores || {}
            };
        }
    }
    return out;
}

// Deterministic (no-LLM) join: assemble the concrete, dated material we already
// have for one person so generatePersonInsight can anchor its prose to real events
// instead of describing a numerical arc in the abstract. Mirrors how
// aggregatePersonNervousMonthly walks relationship_monthly. `key` is a lowercased
// person name; `byMonth` is that person's mention timeline from dashboard_data.
const MONTH_ABBR = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// dashboard byMonth keys are "MMM YYYY" (e.g. "Apr 2026"); relationship_monthly
// and events use "YYYY-MM". Normalize to YYYY-MM so all three join.
function normalizeMonthKey(k) {
    const s = String(k || '').trim();
    if (/^\d{4}-\d{2}$/.test(s)) return s;
    const m = s.match(/^([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
    if (m) {
        const mo = MONTH_ABBR[m[1].toLowerCase()];
        if (mo) return `${m[2]}-${String(mo).padStart(2, '0')}`;
    }
    return null;
}

// Generic role labels the dashboard uses for anonymized/aggregate people. These
// must match relationship_monthly names by EXACT key only — never fuzzily — or a
// label like "friend" would vacuum up every entry whose name contains "friend".
const GENERIC_PERSON_LABELS = new Set([
    'friend', 'partner', 'mother', 'father', 'brother', 'sister',
    'therapist', 'family', 'colleague', 'boss', 'ex', 'roommate'
]);

function buildPersonContext(key, byMonth, aggregated) {
    const name = String(key || '').toLowerCase().trim();
    const isGeneric = GENERIC_PERSON_LABELS.has(name);

    // 1. Monthly observations: every romantic/friendship entry whose name matches,
    //    chronological. notes carry the concrete quotes/observations. Real names
    //    match fuzzily (whole-word token / shared prefix ≥4 chars) so a first name
    //    joins its "First Last" form (and vice-versa); generic role labels
    //    match exactly only and otherwise fall back to events+peaks.
    const matchesName = (recorded) => {
        const r = String(recorded || '').toLowerCase().trim();
        if (!r || !name) return false;
        if (r === name) return true;
        if (isGeneric || name.length < 4) return false;
        const tokens = r.split(/[^a-zà-ÿ]+/).filter(Boolean);
        if (tokens.includes(name)) return true;
        return tokens.some(t => t.length >= 4 && (t.startsWith(name) || name.startsWith(t)));
    };
    const obs = [];
    const rm = aggregated.relationship_monthly || {};
    for (const month of Object.keys(rm).sort()) {
        const buckets = rm[month] || {};
        for (const bucket of ['romantic', 'friendships']) {
            for (const r of (buckets[bucket] || [])) {
                if (!matchesName(r.name)) continue;
                const ns = r.nervous_state || {};
                const tag = [r.quality, ns.dominant_state].filter(Boolean).join(', ');
                const note = (r.notes || ns.state_note || '').trim();
                if (note) obs.push({ month, line: `${month} [${tag}]: ${note}` });
            }
        }
    }
    // Cap to ~24 lines: keep earliest 8 + latest 16 so both the origin and the
    // recent arc survive without blowing the prompt budget.
    let obsLines = obs.map(o => o.line);
    if (obsLines.length > 24) {
        obsLines = [...obsLines.slice(0, 8), '…', ...obsLines.slice(-16)];
    }

    // 2. Mention peaks: top ~5 months by mention count (anchors for the arc).
    //    byMonth keys are "MMM YYYY" → normalize to YYYY-MM.
    const normByMonth = {};
    for (const [k, n] of Object.entries(byMonth || {})) {
        const nk = normalizeMonthKey(k);
        if (nk && n > 0) normByMonth[nk] = (normByMonth[nk] || 0) + n;
    }
    const peakMonths = Object.entries(normByMonth)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([m]) => m);
    const peakLines = peakMonths
        .slice()
        .sort((a, b) => a.localeCompare(b))
        .map(m => `${m} (${normByMonth[m]} mentions)`);

    // 3. Nearby dated events: events whose YYYY-MM is within ±1 month of any
    //    observation or peak month — the "link the arc to key events" ask.
    const anchorMonths = new Set();
    for (const o of obs) anchorMonths.add(o.month);
    for (const m of peakMonths) anchorMonths.add(m);
    const windowed = new Set();
    for (const m of anchorMonths) {
        const [y, mo] = m.split('-').map(Number);
        for (let d = -1; d <= 1; d++) {
            const dt = new Date(y, mo - 1 + d, 1);
            windowed.add(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`);
        }
    }
    const eventLines = (aggregated.events || [])
        .filter(e => e.date && windowed.has(String(e.date).slice(0, 7)))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .slice(0, 20)
        .map(e => `${String(e.date).slice(0, 7)}: ${e.title} [${e.category || 'other'}]`);

    return {
        hasMaterial: obsLines.length > 0 || eventLines.length > 0,
        observations: obsLines.join('\n') || '(no dated per-month observations recorded)',
        peaks: peakLines.join(', ') || '(no mention peaks)',
        events: eventLines.join('\n') || '(no nearby dated events)'
    };
}

async function generatePersonInsight(name, data, aggregated = {}) {
    const ctx = buildPersonContext(name, data.byMonth, aggregated);

    const prompt = `You are analyzing the subject's real relationship with "${name}", drawn from their journals, messages, and AI conversations. Below is CONCRETE, DATED material about this relationship. Ground every statement in it.

Overview:
  Category: ${data.category || 'unknown'}
  Total mentions: ${data.mentions || 0}
  Avg sentiment: ${data.sentiment || 0}
  Highest-mention months: ${ctx.peaks}

Dated monthly observations (notes/quotes from the subject's own records):
${ctx.observations}

Nearby dated life events (for anchoring the arc):
${ctx.events}

RULES:
- Every item in "patterns" and "concerns" MUST begin with a specific month (YYYY-MM) and paraphrase or quote a concrete observation or event above.
- Do NOT describe mention counts or sentiment in the abstract (no "mentions rose in 2023"). Tie each point to what actually happened.
- If the material is thin, say so plainly rather than inventing detail.

Return JSON exactly in this shape:
{
    "relationship_type": "short label, e.g. 'Close friend', 'Family (mother)', 'Romantic partner', 'Collaborator'",
    "dynamics": "2-3 sentences describing the relationship's character, anchored to specific moments",
    "sentiment_interpretation": "mostly positive | mostly negative | mixed — one clause of why, naming a month",
    "patterns": ["YYYY-MM: concrete recurring pattern tied to an observation", "..."],
    "strengths": ["YYYY-MM: anchored strength of this relationship", "..."],
    "concerns": ["YYYY-MM: anchored concern or friction point", "..."],
    "recommendations": ["concrete, actionable suggestion", "..."]
}`;

    const response = await callClaude(prompt, 1500);
    return parseJSON(response, {
        relationship_type: 'Unknown',
        dynamics: 'Unable to analyze — insufficient recorded material.',
        sentiment_interpretation: 'N/A',
        patterns: [],
        strengths: [],
        concerns: [],
        recommendations: []
    });
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

    const nervousSummary = Object.entries(aggregated.nervous_system || {})
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-6)
        .map(([m, n]) => {
            const scores = n?.scores || {};
            const top = NERVOUS_STATES
                .map(s => [s, scores[s] ?? 0])
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([s, v]) => `${s}=${v}`)
                .join(', ');
            return `${m}: dominant=${n?.dominant_state ?? '?'} [${top}]`;
        })
        .join('\n');

    const yearList = Object.keys(aggregated.yearly_summaries || {}).sort().join(', ');

    const prompt = `You are analyzing ${yearList ? yearList + ' — multiple years' : 'multiple years'} of a person's real digital life: AI conversations (Claude, ChatGPT, Gemini), Google searches, sent emails, and personal journals. This is their authentic inner life.

Monthly summaries (last 12 months):
${monthSummaries || 'No monthly data available'}

Top conversation categories (all time):
${categoryTotals || 'No category data'}

Victim vs empowered language scores (last 6 months, 0-100):
${victimSummary || 'No language data'}

Nervous-system / trauma-response states (last 6 months, dominant + top scores 0-100):
${nervousSummary || 'No nervous-system data'}

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

// Treat the user's RELATIONSHIP TO THEMSELVES as a first-class tracked entity,
// synthesized from journals + the nervous-system data (esp. centered vs. fawn/
// self-abandonment) and victim/empowered language. One synthesis call total.
async function generateSelfInsight(aggregated) {
    const nervousSummary = Object.entries(aggregated.nervous_system || {})
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([m, n]) => {
            const scores = n?.scores || {};
            const centered = scores.centered ?? '?';
            const fawn = scores.fawn ?? '?';
            return `${m}: dominant=${n?.dominant_state ?? '?'} centered=${centered} fawn=${fawn}`;
        })
        .filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / 24)) === 0) // thin to ~24 points
        .join('\n');

    const victimSummary = Object.entries(aggregated.victim_analysis || {})
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-12)
        .map(([m, v]) => `${m}: victim=${v?.victim_score ?? '?'} empowered=${v?.empowered_score ?? '?'}`)
        .join('\n');

    const prompt = `You are analyzing a person's RELATIONSHIP WITH THEMSELVES over time — how they treat, speak to, and hold themselves — as a tracked entity, parallel to how we track their relationships with other people. Base this on their real journals, nervous-system/trauma-response states, and self-talk language.

Nervous-system states over time (centered = being in one's own center, grounded, NOT self-abandoning; fawn = self-abandoning to appease others):
${nervousSummary || 'No nervous-system data'}

Victim vs. empowered self-language (last 12 months, 0-100):
${victimSummary || 'No language data'}

Return JSON describing the relationship-to-self as an entity:
{
    "self_summary": "2-3 sentences on how this person relates to themselves overall",
    "arc_summary": "how the relationship-to-self shifted across the years (e.g. 'early chronic self-abandonment/fawn → growing capacity to stay centered')",
    "current_tendency": "brief phrase on the most recent tendency toward or away from self-abandonment",
    "self_abandonment_trend": "improving|worsening|stable|mixed|unclear (improving = more centered, less fawn/self-abandonment)",
    "strengths": ["specific self-relational strength visible in the data"],
    "concerns": ["specific self-relational concern"],
    "recommendations": ["concrete, specific recommendation for a healthier relationship to self"]
}

Be specific and grounded in the data. Avoid platitudes.`;

    const response = await callClaude(prompt, 2000);
    return parseJSON(response, { self_summary: 'Unable to analyze', recommendations: [] });
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

// Load the full dashboard_data.json (process_data.js output). Phase 1c needs
// monthlyData (sentiment/wellbeing/messages/agency) + peopleData (per-person
// mentions) for outlier detection, since those series live in the OTHER pipeline.
// Returns null if the file is absent (e.g. analyze run before process).
function loadDashboardData() {
    if (!fs.existsSync(OUTPUT.dashboard)) return null;
    try {
        return JSON.parse(fs.readFileSync(OUTPUT.dashboard, 'utf8'));
    } catch (e) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Monthly digest — hierarchical map-reduce over ALL of a month's rich messages.
//
// Replaces random 10–25-message sampling: every message contributes, the read is
// deterministic (timestamp order, fixed chunk packing), and the result is cached
// on disk keyed by a content hash so unchanged months are skipped and only
// changed data is re-ingested.
// ---------------------------------------------------------------------------

/** Rich messages of a month, deterministically ordered (timestamp, source, text). */
function richMonthMessages(messages) {
    return (messages || [])
        .filter(m => RICH_SOURCES.includes(m.source))
        .sort((a, b) => {
            const ta = a.timestamp ? +a.timestamp : 0;
            const tb = b.timestamp ? +b.timestamp : 0;
            if (ta !== tb) return ta - tb;
            if (a.source !== b.source) return String(a.source).localeCompare(String(b.source));
            // Final tiebreak on text so identical (timestamp, source) pairs order
            // the same regardless of load order — keeps the source hash stable.
            return String(a.text).localeCompare(String(b.text));
        });
}

/** SHA-256 over the ordered rich-message content — the cache key for a month. */
function monthSourceHash(richMsgs) {
    const h = crypto.createHash('sha256');
    for (const m of richMsgs) {
        const ts = m.timestamp ? +m.timestamp : 0;
        h.update(`${m.source}|${ts}|${m.text}\n`);
    }
    return h.digest('hex');
}

/** Pack ordered messages into chunks of ≤ DIGEST_CHUNK_CHARS of prefixed text. */
function packChunks(richMsgs) {
    const chunks = [];
    let cur = [];
    let curLen = 0;
    for (const m of richMsgs) {
        const line = `[${m.source}] ${m.text.substring(0, DIGEST_MSG_TRUNC).replace(/\n/g, ' ')}`;
        if (curLen + line.length > DIGEST_CHUNK_CHARS && cur.length) {
            chunks.push(cur);
            cur = [];
            curLen = 0;
        }
        cur.push(line);
        curLen += line.length + 1;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
}

const DIGEST_FIELDS = `- people: real names + the relational/nervous-system dynamic with each (who, tone, any conflict/closeness)
- events: concrete things that actually happened (medical, work, moves, travel, decisions, ceremonies)
- emotional & nervous-system tone: regulated vs. fight/flight/freeze/fawn/avoid/anxious/dominate; victim vs. empowered language
- substances: any alcohol/cannabis/psychedelic/stimulant/medication use or interest, with context
- themes: recurring preoccupations, projects, questions
- telling phrases: a few short near-verbatim quotes that capture the month`;

/** Map step: summarize one chunk of messages into a structured digest fragment. */
async function summarizeChunk(month, lines, part, total) {
    const prompt = `You are compressing a person's real private data from ${month} (part ${part} of ${total}) into a dense factual digest. Preserve signal; drop filler. Keep REAL NAMES and specifics.

Entries:
${lines.join('\n')}

Write a compact digest covering, ONLY where evidenced in these entries:
${DIGEST_FIELDS}

Be concrete and grounded in the entries — do not invent. Prose or terse bullets, no preamble.`;
    return await callClaude(prompt, 1500);
}

/** Reduce step: fold several digest fragments into one. Used recursively. */
async function reduceDigests(month, fragments) {
    const prompt = `Combine these ${fragments.length} partial digests of a person's real data from ${month} into ONE coherent digest with no loss of distinct facts. Merge duplicates, keep all real names, events, substances, and relational/nervous-system detail.

Partial digests:
${fragments.map((f, i) => `--- part ${i + 1} ---\n${f}`).join('\n\n')}

Return a single consolidated digest covering:
${DIGEST_FIELDS}

Be concrete; do not invent beyond the parts. No preamble.`;
    return await callClaude(prompt, 2000);
}

/**
 * Build a month's digest from ALL its rich messages via map-reduce.
 * @returns {Promise<{digestText, chunkCount, messageCount, sourceHash}>}
 */
async function buildMonthlyDigest(month, messages) {
    const rich = richMonthMessages(messages);
    const sourceHash = monthSourceHash(rich);
    if (rich.length === 0) {
        return { digestText: '', chunkCount: 0, messageCount: 0, sourceHash };
    }

    const chunks = packChunks(rich);

    // Map: summarize each chunk (parallel, bounded).
    const fragments = await runParallel(
        chunks.map((lines, i) => () => summarizeChunk(month, lines, i + 1, chunks.length)),
        PARALLEL_LIMIT
    );

    // Reduce: fold fragments down to one, recursively if they still overflow.
    let level = fragments.filter(f => f && f.trim());
    while (level.length > 1) {
        const groups = [];
        let cur = [];
        let curLen = 0;
        for (const frag of level) {
            if (curLen + frag.length > DIGEST_CHUNK_CHARS && cur.length) {
                groups.push(cur);
                cur = [];
                curLen = 0;
            }
            cur.push(frag);
            curLen += frag.length;
        }
        if (cur.length) groups.push(cur);
        level = await runParallel(
            groups.map(g => () => (g.length === 1 ? Promise.resolve(g[0]) : reduceDigests(month, g))),
            PARALLEL_LIMIT
        );
    }

    let digestText = (level[0] || '').trim();
    if (digestText.length > DIGEST_MAX_CHARS) digestText = digestText.substring(0, DIGEST_MAX_CHARS);
    return { digestText, chunkCount: chunks.length, messageCount: rich.length, sourceHash };
}

// Phase 1c — explain a month's flagged outliers in one batched LLM call.
// flagged: [{ metric, direction, magnitude, value }]  (this month's flags)
// `digestText` is the month's hierarchical digest (same input the passes see).
// Returns { metric: explanation } grounded ONLY in that digest.
async function explainMonthOutliers(monthKey, digestText, flagged) {
    const fallback = Object.fromEntries(flagged.map(f => [f.metric, '']));
    if (!flagged.length || !digestText || !digestText.trim()) return fallback;

    const prompt = `You are explaining statistical outliers in one month (${monthKey}) of a person's real digital life (AI chats, journals, emails, messages).

CODE has already flagged these metrics as unusual this month (a spike or dip vs the person's own baseline). For EACH flagged metric, give a short, concrete, data-grounded likely explanation — ONE sentence, max ~20 words. Base it ONLY on the month digest below. If the digest doesn't explain it, use exactly "No clear signal in sampled data." Do not invent events.

Flagged metrics:
${flagged.map(f => `- ${f.metric}: ${f.direction} (magnitude ${f.magnitude})`).join('\n')}

Month digest for ${monthKey}:
${digestText}

Respond with ONLY a JSON object mapping each flagged metric to its explanation string:
{ ${flagged.map(f => `"${f.metric}": "..."`).join(', ')} }`;

    const response = await callClaude(prompt, 700);
    const parsed = parseJSON(response, fallback);
    // Ensure every flagged metric has a key (LLM may omit some).
    for (const f of flagged) if (!(f.metric in parsed)) parsed[f.metric] = '';
    return parsed;
}

// Events that count toward the events-per-month outlier series — low-signal
// categories (e.g. google_search) are excluded so spikes reflect real life events.
const SIGNIFICANT_EVENT_CATEGORIES = new Set([
    'health', 'relationship', 'relationships', 'work', 'career',
    'travel', 'life', 'milestone', 'loss', 'move', 'family'
]);

// Build every numeric {key: YYYY-MM, value} series, detect outliers, explain the
// flagged ones (batched per month, skip-cached), and attach to aggregated.monthly[m].outliers
// as { _flagSig, items: { metric: {direction,magnitude,value,method,explanation} } }.
// Per-person mention outliers go to a returned structure consumed by the people phase.
async function runOutlierPhase(aggregated, messagesByMonth, existingData, digestsByMonth = {}) {
    console.log('Phase 1c: Outlier Detection + Explanations');
    console.log('─'.repeat(40));

    const dash = loadDashboardData();
    const seriesMap = {};
    const optsByMetric = {};

    // --- process_data.js series (sentiment/wellbeing/messages/agency) ---
    if (dash?.monthlyData) {
        const sMap = {}, wMap = {}, mMap = {}, aMap = {};
        for (const row of dash.monthlyData) {
            const k = outliers.convertToYYYYMM(row.month);
            if (typeof row.sentiment === 'number') sMap[k] = row.sentiment;
            if (typeof row.wellbeing === 'number') wMap[k] = row.wellbeing;
            if (typeof row.messages === 'number') mMap[k] = row.messages;
            if (typeof row.agency === 'number') aMap[k] = row.agency;
        }
        const toSeries = (obj) => Object.entries(obj).map(([key, value]) => ({ key, value }));
        seriesMap.sentiment = toSeries(sMap);
        seriesMap.wellbeing = toSeries(wMap);
        seriesMap.messages = toSeries(mMap); optsByMetric.messages = { minValue: 10 };
        seriesMap.agency = toSeries(aMap);
    } else {
        console.log('  (dashboard_data.json absent — skipping sentiment/wellbeing/messages/agency/person series)');
    }

    // --- victim / empowered ---
    const vMonths = Object.keys(aggregated.victim_analysis);
    seriesMap.victim_score = vMonths.map(k => ({ key: k, value: aggregated.victim_analysis[k]?.victim_score })).filter(p => typeof p.value === 'number');
    seriesMap.empowered_score = vMonths.map(k => ({ key: k, value: aggregated.victim_analysis[k]?.empowered_score })).filter(p => typeof p.value === 'number');

    // --- 8 nervous-system states ---
    const nMonths = Object.keys(aggregated.nervous_system);
    for (const state of NERVOUS_STATES) {
        seriesMap[`nervous_${state}`] = nMonths
            .map(k => ({ key: k, value: aggregated.nervous_system[k]?.scores?.[state] }))
            .filter(p => typeof p.value === 'number');
    }

    // --- category counts (10) ---
    const catNames = new Set();
    for (const m of Object.keys(aggregated.categories)) {
        for (const c of Object.keys(aggregated.categories[m])) if (c !== 'outliers') catNames.add(c);
    }
    for (const cat of catNames) {
        seriesMap[`cat_${cat}`] = Object.keys(aggregated.categories)
            .map(k => ({ key: k, value: aggregated.categories[k]?.[cat] || 0 }));
        optsByMetric[`cat_${cat}`] = { minValue: 3 };
    }

    // --- substance count per month ---
    seriesMap.substance_count = Object.keys(aggregated.substance_monthly)
        .map(k => ({ key: k, value: (aggregated.substance_monthly[k]?.substances || []).length }));
    optsByMetric.substance_count = { minValue: 1 };

    // --- events per month (filtered to significant categories) ---
    const eventsByMonth = {};
    for (const e of aggregated.events || []) {
        const cat = String(e.category || '').toLowerCase();
        if (!SIGNIFICANT_EVENT_CATEGORIES.has(cat)) continue;
        const k = e.date?.substring(0, 7);
        if (!k) continue;
        eventsByMonth[k] = (eventsByMonth[k] || 0) + 1;
    }
    seriesMap.events = Object.entries(eventsByMonth).map(([key, value]) => ({ key, value }));
    optsByMetric.events = { minValue: 2 };

    // --- per-person mentions (from dashboard peopleData) ---
    const personSeries = {}; // metric -> {name}
    if (dash?.peopleData) {
        for (const [name, pdata] of Object.entries(dash.peopleData)) {
            const byMonth = pdata.byMonth || {};
            const series = Object.entries(byMonth).map(([mk, count]) => ({ key: outliers.convertToYYYYMM(mk), value: count }));
            const metric = `person_${name}_mentions`;
            seriesMap[metric] = series;
            optsByMetric[metric] = { minValue: 3 };
            personSeries[metric] = name;
        }
    }

    // Detect across all series, group by month.
    const flagsByMetric = outliers.detectOutlierSeries(seriesMap, optsByMetric);
    const flagsByMonth = outliers.groupFlagsByMonth(flagsByMetric);

    // Explain ALL flags per month in one batched call (person-mention metrics
    // ride along since they share the month's sample), then split person flags
    // back out into person_insights afterward.
    const monthsWithFlags = Object.keys(flagsByMonth);
    const monthsToExplain = [];
    const cachedExplanations = {}; // month -> items (from cache)
    for (const month of monthsWithFlags) {
        const flags = flagsByMonth[month];
        const sig = outliers.flagSignature(flags);
        const prior = existingData.monthlyMeta?.[month]?.outliers;
        if (!FORCE && prior && prior._flagSig === sig) {
            cachedExplanations[month] = prior.items || {};
        } else {
            monthsToExplain.push({ month, flags, sig });
        }
    }

    // Build the per-month items map (explanation + numeric flag), from cache or new calls.
    const itemsByMonth = { ...cachedExplanations }; // month -> { metric: {...} }
    const sigByMonth = {};
    for (const month of monthsWithFlags) {
        if (existingData.monthlyMeta?.[month]?.outliers?._flagSig) {
            sigByMonth[month] = existingData.monthlyMeta[month].outliers._flagSig;
        }
    }

    let explained = 0;
    if (monthsToExplain.length) {
        const tasks = monthsToExplain.map(({ month, flags, sig }) => async () => {
            const digestText = digestsByMonth[month]?.digestText
                || existingData.digests?.[month]?.digestText || '';
            const explanations = await explainMonthOutliers(month, digestText, flags);
            const items = {};
            for (const f of flags) {
                items[f.metric] = {
                    direction: f.direction, magnitude: f.magnitude, value: f.value,
                    method: f.method, explanation: explanations[f.metric] || ''
                };
            }
            return { month, items, sig };
        });
        const results = await runParallel(tasks, PARALLEL_LIMIT);
        for (const r of results) { itemsByMonth[r.month] = r.items; sigByMonth[r.month] = r.sig; explained++; }
    }

    // Attach non-person flags to aggregated.monthly[m].outliers; collect person flags.
    const personFlags = {}; // name -> { YYYY-MM: {direction,magnitude,value,explanation} }
    for (const month of monthsWithFlags) {
        const items = itemsByMonth[month] || {};
        const monthItems = {};
        for (const [metric, item] of Object.entries(items)) {
            if (personSeries[metric]) {
                const name = personSeries[metric];
                (personFlags[name] = personFlags[name] || {})[month] = {
                    direction: item.direction, magnitude: item.magnitude,
                    value: item.value, explanation: item.explanation || ''
                };
            } else {
                monthItems[metric] = item;
            }
        }
        if (Object.keys(monthItems).length) {
            if (!aggregated.monthly[month]) aggregated.monthly[month] = {};
            aggregated.monthly[month].outliers = { _flagSig: sigByMonth[month], items: monthItems };
        }
    }

    console.log(`  Flagged ${monthsWithFlags.length} months, ${Object.keys(personFlags).length} people; explained ${explained} new, reused ${monthsWithFlags.length - monthsToExplain.length}\n`);
    return { personFlags };
}

// ============================================
// Main Pipeline
// ============================================

async function processMonth(month, messages, existingData, digestsByMonth) {
    // Current content hash for this month's rich messages (cheap, no LLM).
    const rich = richMonthMessages(messages);
    const currentHash = monthSourceHash(rich);
    const priorDigest = existingData.digests?.[month];
    const hashClean = priorDigest && priorDigest.sourceHash === currentHash;

    // Skip only when every field is present AND the source data is unchanged.
    if (!FORCE && hashClean && existingData.categories?.[month] && existingData.victim?.[month] &&
        existingData.relationships?.[month] && existingData.substances?.[month] &&
        existingData.nervous?.[month]) {
        // Carry the cached digest forward so later phases (outliers) can reuse it.
        if (digestsByMonth) digestsByMonth[month] = priorDigest;
        return { month, skipped: true };
    }

    const result = {
        month,
        categories: {},
        victim: null,
        insight: null,
        relationships: null,
        substances: null,
        nervous_system: null,
        digest: null,
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

        // Build (or reuse) this month's digest — the systematic, full-coverage
        // replacement for random sampling. Reused across all five passes below.
        let digest;
        if (!FORCE && hashClean && priorDigest.digestText !== undefined) {
            digest = priorDigest;
        } else {
            digest = await buildMonthlyDigest(month, messages);
        }
        result.digest = {
            digestText: digest.digestText,
            messageCount: digest.messageCount,
            chunkCount: digest.chunkCount,
            sourceHash: digest.sourceHash
        };
        if (digestsByMonth) digestsByMonth[month] = result.digest;
        const digestText = digest.digestText;

        // Source breakdown for this month
        const sourceCounts = {};
        for (const m of messages) {
            sourceCounts[m.source] = (sourceCounts[m.source] || 0) + 1;
        }

        // Run victim + nervous-system + insight + relationship + substance extraction in parallel
        [result.victim, result.nervous_system, result.insight, result.relationships, result.substances] = await Promise.all([
            analyzeVictimLanguage(month, digestText),
            analyzeNervousSystem(month, digestText),
            generateMonthlyInsight(month, digestText, {
                total: messages.length,
                sources: sourceCounts,
                categories: result.categories
            }),
            extractMonthRelationships(month, digestText),
            extractMonthSubstances(month, digestText)
        ]);

        console.log(`  ✓ ${month}${digest.chunkCount > 1 ? ` (${digest.chunkCount} chunks, ${digest.messageCount} msgs)` : ''}`);
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
        nervous: {},
        insights: {},
        relationships: {},
        substances: {},
        monthlyMeta: {},
        digests: {}
    };

    if (fs.existsSync(OUTPUT.categories)) {
        const data = JSON.parse(fs.readFileSync(OUTPUT.categories, 'utf8'));
        existingData.categories = data.categories || {};
        existingData.victim = data.victim_analysis || {};
        existingData.nervous = data.nervous_system || {};
        existingData.monthlyMeta = data.monthly || {}; // carries prior .outliers for skip-cache
        existingData.socialClusters = data.social_clusters || null; // skip-cache for cluster pass
        // Prior per-month digests (hash-keyed cache) — reuse when source unchanged.
        for (const [m, mo] of Object.entries(data.monthly || {})) {
            if (mo && mo.digest) existingData.digests[m] = mo.digest;
        }
    }

    // Load existing yearly summaries (don't re-run unless --force)
    let existingYearlySummaries = {};
    let existingRelationshipArcs = {};
    let existingSubstanceArcs = {};
    let existingNervousArc = null;
    if (fs.existsSync(OUTPUT.insights)) {
        try {
            const d = JSON.parse(fs.readFileSync(OUTPUT.insights, 'utf8'));
            existingYearlySummaries = d.yearly_summaries || {};
            existingRelationshipArcs = d.relationship_arcs || {};
            existingSubstanceArcs = d.substance_arcs || {};
            existingNervousArc = d.nervous_system_arc || null;
            existingData.relationships = d.relationship_monthly || {};
            existingData.substances = d.substance_monthly || {};
        } catch (e) { /* ignore */ }
    }

    // ========== PHASE 1: Monthly Analysis (Parallel) ==========
    console.log('Phase 1: Monthly Analysis (parallel)');
    console.log('─'.repeat(40));

    // In-memory digest cache, shared by the five passes, event extraction, and
    // outlier explanations. Populated by processMonth (built or reused-from-disk).
    const digestsByMonth = {};

    const monthTasks = months.map(month => {
        return async () => processMonth(month, messagesByMonth[month], existingData, digestsByMonth);
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
                const events = await extractMonthEvents(month, digestsByMonth[month]?.digestText || '');
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
        nervous_system: { ...existingData.nervous },
        monthly: {},
        relationship_monthly: { ...existingData.relationships },
        substance_monthly: { ...existingData.substances },
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
            if (existingData.nervous[result.month]) {
                aggregated.nervous_system[result.month] = existingData.nervous[result.month];
            }
            // relationship/substance already merged above from existingData
            if (fs.existsSync(OUTPUT.insights)) {
                try {
                    const d = JSON.parse(fs.readFileSync(OUTPUT.insights, 'utf8'));
                    if (d.monthly?.[result.month]) {
                        aggregated.monthly[result.month] = d.monthly[result.month];
                    }
                } catch (e) { /* ignore */ }
            }
            // Carry forward the hash-keyed digest cache for skipped months.
            if (existingData.digests[result.month]) {
                aggregated.monthly[result.month] = aggregated.monthly[result.month] || {};
                aggregated.monthly[result.month].digest = existingData.digests[result.month];
            }
            continue;
        }
        if (result.success) {
            aggregated.categories[result.month] = result.categories;
            aggregated.victim_analysis[result.month] = result.victim;
            if (result.nervous_system) aggregated.nervous_system[result.month] = result.nervous_system;
            aggregated.monthly[result.month] = result.insight;
            if (result.relationships) aggregated.relationship_monthly[result.month] = result.relationships;
            if (result.substances) aggregated.substance_monthly[result.month] = result.substances;
            // Persist the month's digest ({digestText, messageCount, chunkCount, sourceHash})
            // so unchanged months are skipped on the next run (hash-keyed cache).
            if (result.digest) {
                aggregated.monthly[result.month] = aggregated.monthly[result.month] || {};
                aggregated.monthly[result.month].digest = result.digest;
            }
        }
    }

    // Calculate category totals
    for (const monthCats of Object.values(aggregated.categories)) {
        for (const [cat, count] of Object.entries(monthCats)) {
            if (cat === 'outliers') continue; // guard: outliers is not a category count
            aggregated.category_totals[cat] = (aggregated.category_totals[cat] || 0) + count;
        }
    }

    // ========== PHASE 1c: Outlier Detection + Explanations ==========
    // Code detects spikes/dips numerically across all series; the LLM explains
    // only the flagged month/metrics, batched one call per month-with-flags,
    // reusing that month's sample. Skip-cached by flag signature.
    const { personFlags } = await runOutlierPhase(aggregated, messagesByMonth, existingData, digestsByMonth);

    // ========== PHASE 1d: Social Clusters ==========
    // Build co-membership (group-chat participants) + co-mention signal — NO LLM —
    // then have the LLM name/characterise communities. Skip-cached unless months
    // changed or --force. Attached to aggregated.social_clusters (rides into
    // category_analysis.json). Participant data stays in-memory; never written raw.
    console.log('Phase 1d: Social Clusters');
    console.log('─'.repeat(40));
    const clustersChanged = FORCE || processed > 0 || !existingData.socialClusters;
    if (clustersChanged) {
        const signal = buildSocialSignal(messagesByMonth, aggregated.relationship_monthly);
        console.log(`  Signal: ${Object.keys(signal.nodes).length} people, ${signal.pairs.length} co-occurrence pairs, ${signal.groups.length} group chats`);
        aggregated.social_clusters = await synthesizeSocialClusters(signal);
        console.log(`  Clusters: ${aggregated.social_clusters.clusters.length}\n`);
    } else {
        aggregated.social_clusters = existingData.socialClusters;
        console.log('  (unchanged — reused cached clusters)\n');
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

    // Regenerate a year when it's missing OR when the stored summary is a prior
    // fallback (narrative === 'Summary unavailable' / no real narrative), so a
    // failed earlier pass self-heals on the next run without needing --force.
    const yearNeedsSummary = (year) => {
        if (FORCE) return true;
        const s = existingYearlySummaries[year];
        if (!s) return true;
        const n = (s.narrative || '').trim();
        return !n || n === 'Summary unavailable';
    };

    const yearTasks = years
        .filter(yearNeedsSummary)
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

    // ========== PHASE 3b: Relationship, Substance & Nervous-System Arcs ==========
    console.log('Phase 3b: Relationship, Substance & Nervous-System Arc Synthesis');
    console.log('─'.repeat(40));

    // Only (re)synthesize the overall nervous-system arc if months changed or forced
    const nervousArcChanged = FORCE || processed > 0 || !existingNervousArc;

    const [relationshipArcs, substanceArcs, nervousArc] = await Promise.all([
        synthesizeRelationshipArcs(aggregated.relationship_monthly),
        synthesizeSubstanceArcs(aggregated.substance_monthly),
        nervousArcChanged ? synthesizeNervousSystemArc(aggregated.nervous_system) : Promise.resolve(existingNervousArc)
    ]);

    // Merge with existing arcs (new synthesis wins)
    aggregated.relationship_arcs = { ...existingRelationshipArcs, ...relationshipArcs };
    aggregated.substance_arcs = { ...existingSubstanceArcs, ...substanceArcs };
    aggregated.nervous_system_arc = nervousArc || existingNervousArc;
    console.log(`\n  Relationship arcs: ${Object.keys(aggregated.relationship_arcs).length}, Substance arcs: ${Object.keys(aggregated.substance_arcs).length}, Nervous-system arc: ${aggregated.nervous_system_arc ? 'yes' : 'no'}\n`);

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
                contexts: [data.context || 'unknown'],
                byMonth: data.byMonth || {}
            };
            return acc;
        }, {})
        : {
            partner: { category: 'partner', mentions: 120, sentiment: -0.15, contexts: ['relationship', 'boundaries'] },
            friend: { category: 'friend', mentions: 45, sentiment: 0.3, contexts: ['friendship', 'support'] },
            mother: { category: 'family', mentions: 85, sentiment: -0.2, contexts: ['family dynamics', 'childhood'] },
            father: { category: 'family', mentions: 42, sentiment: -0.1, contexts: ['family dynamics'] },
            therapist: { category: 'professional', mentions: 156, sentiment: 0.1, contexts: ['therapy'] }
        };

    const existingPeople = fs.existsSync(OUTPUT.people)
        ? JSON.parse(fs.readFileSync(OUTPUT.people, 'utf8'))
        : {};

    const peopleTasks = Object.entries(people)
        .filter(([name]) => FORCE || !existingPeople[name])
        .map(([name, data]) => {
            return async () => {
                try {
                    const insight = await generatePersonInsight(name, data, aggregated);
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

    // Attach per-person mention outliers (detected + explained in Phase 1c) to
    // every person we have an entry for — independent of the LLM skip-cache above.
    for (const [name, mentions] of Object.entries(personFlags || {})) {
        if (!peopleData[name]) peopleData[name] = {};
        peopleData[name].outliers = { mentions };
    }
    // Clear stale outliers for people no longer flagged this run.
    for (const name of Object.keys(peopleData)) {
        if (peopleData[name]?.outliers && !personFlags[name]) {
            delete peopleData[name].outliers;
        }
    }

    // Attach per-person monthly nervous-system scores, aggregated from the
    // per-relationship scores produced in extractMonthRelationships. Keyed by
    // lowercased name to match the dashboard person keys.
    const nervousMonthlyByPerson = aggregatePersonNervousMonthly(aggregated.relationship_monthly);
    for (const [key, nervMonthly] of Object.entries(nervousMonthlyByPerson)) {
        if (!peopleData[key]) peopleData[key] = {};
        peopleData[key].nervous_monthly = nervMonthly;
    }
    for (const name of Object.keys(peopleData)) {
        if (peopleData[name]?.nervous_monthly && !nervousMonthlyByPerson[name]) {
            delete peopleData[name].nervous_monthly;
        }
    }

    fs.writeFileSync(OUTPUT.people, JSON.stringify(peopleData, null, 2));
    console.log(`\n  Saved: ${OUTPUT.people}\n`);

    // ========== PHASE 5: Overall Insights ==========
    console.log('Phase 5: Overall Insights');
    console.log('─'.repeat(40));

    try {
        const [overallInsights, selfInsight] = await Promise.all([
            generateOverallInsights(aggregated),
            generateSelfInsight(aggregated)
        ]);
        const insightsOutput = {
            insights: overallInsights,
            self_insight: selfInsight,
            monthly: aggregated.monthly,
            yearly_summaries: aggregated.yearly_summaries,
            relationship_monthly: aggregated.relationship_monthly,
            relationship_arcs: aggregated.relationship_arcs,
            substance_monthly: aggregated.substance_monthly,
            substance_arcs: aggregated.substance_arcs,
            nervous_system_monthly: aggregated.nervous_system,
            nervous_system_arc: aggregated.nervous_system_arc,
            events: aggregated.events.sort((a, b) => a.date?.localeCompare(b.date)),
            generated_at: new Date().toISOString()
        };
        fs.writeFileSync(OUTPUT.insights, JSON.stringify(insightsOutput, null, 2));
        console.log(`  ✓ Generated overall insights + self-entity insight`);
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

// Run the pipeline only when invoked directly (allows importing for tests).
if (require.main === module) {
    main().catch(console.error);
}

module.exports = {
    buildMonthlyDigest,
    buildPersonContext,
    richMonthMessages,
    monthSourceHash,
    packChunks,
    loadAllData,
    getMonthKey
};
