#!/usr/bin/env node
/**
 * DalaiLLMA - Parallel LLM Analysis Pipeline
 *
 * Runs all analysis tasks in parallel with subsequent aggregation:
 * - Category classification
 * - Victim vs empowered language analysis
 * - Monthly sentiment insights
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
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-sonnet-20240229';

// Data paths - configurable via environment variables
const DATA_DIR = process.env.DATA_DIR || './data';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';
const ANTHROPIC_DATA = path.join(DATA_DIR, 'anthropic/conversations.json');

// Find OpenAI zip dynamically
function findOpenAIZip() {
    const openaiDir = path.join(DATA_DIR, 'openai');
    if (!fs.existsSync(openaiDir)) return null;
    const files = fs.readdirSync(openaiDir);
    const zip = files.find(f => f.endsWith('.zip') && f.includes('Conversations'));
    return zip ? path.join(openaiDir, zip) : null;
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

// Parallel processing config
const PARALLEL_LIMIT = 5;
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
// Data Loading
// ============================================

function loadConversations() {
    console.log('Loading conversations...');

    let anthropicConvos = [];
    let openaiConvos = [];

    // Load Anthropic
    const anthropicFile = ANTHROPIC_DATA;
    if (fs.existsSync(anthropicFile)) {
        const anthropic = JSON.parse(fs.readFileSync(anthropicFile, 'utf8'));
        anthropicConvos = anthropic.map(c => ({
            id: c.uuid,
            title: c.name || 'Untitled',
            created: new Date(c.created_at),
            messages: (c.chat_messages || [])
                .filter(m => m.sender === 'human' && m.text)
                .map(m => ({
                    text: m.text,
                    timestamp: new Date(m.created_at || c.created_at)
                })),
            source: 'anthropic'
        })).filter(c => c.messages.length > 0);
        console.log(`  Loaded ${anthropicConvos.length} Anthropic conversations`);
    }

    // Load OpenAI
    if (OPENAI_ZIP && fs.existsSync(OPENAI_ZIP)) {
        const tempDir = '/tmp/openai_extract_dalaillma';
        execSync(`rm -rf ${tempDir} && mkdir -p ${tempDir}`);
        execSync(`unzip -q "${OPENAI_ZIP}" "conversations-*.json" -d ${tempDir} 2>/dev/null || true`);

        const files = fs.readdirSync(tempDir).filter(f => f.startsWith('conversations-'));

        for (const file of files) {
            const data = JSON.parse(fs.readFileSync(path.join(tempDir, file), 'utf8'));
            for (const conv of data) {
                const messages = [];
                if (conv.mapping) {
                    for (const node of Object.values(conv.mapping)) {
                        if (node.message?.author?.role === 'user' && node.message?.content?.parts) {
                            const text = node.message.content.parts.filter(p => typeof p === 'string').join(' ');
                            if (text) {
                                messages.push({
                                    text,
                                    timestamp: new Date(conv.create_time * 1000)
                                });
                            }
                        }
                    }
                }
                if (messages.length > 0) {
                    openaiConvos.push({
                        id: conv.id,
                        title: conv.title || 'Untitled',
                        created: new Date(conv.create_time * 1000),
                        messages,
                        source: 'openai'
                    });
                }
            }
        }
        execSync(`rm -rf ${tempDir}`);
        console.log(`  Loaded ${openaiConvos.length} OpenAI conversations`);
    }

    const all = [...anthropicConvos, ...openaiConvos].sort((a, b) => a.created - b.created);
    console.log(`  Total: ${all.length} conversations\n`);

    return all;
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
    const sample = messages
        .sort(() => Math.random() - 0.5)
        .slice(0, 10)
        .map(m => m.text.substring(0, 200));

    const prompt = `Analyze this month's conversations:

Month: ${month}
Messages: ${messages.length}
Stats: ${JSON.stringify(stats)}

Sample messages:
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

async function generateOverallInsights(allData) {
    const monthSummaries = Object.entries(allData.monthly || {})
        .slice(-6)
        .map(([m, d]) => `${m}: ${d.summary || 'N/A'}`)
        .join('\n');

    const categoryTotals = Object.entries(allData.categories?.category_totals || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([c, n]) => `${c}: ${n}`)
        .join(', ');

    const prompt = `Generate overall insights from this conversation history:

Recent months:
${monthSummaries}

Top categories: ${categoryTotals}

Provide comprehensive analysis in JSON:
{
    "patterns": [{"pattern": "desc", "impact": "positive/negative/neutral"}],
    "turning_points": [{"period": "month", "description": "what happened"}],
    "risk_factors": ["risk1", "risk2"],
    "strengths": ["strength1", "strength2"],
    "recommendations": [{"area": "area", "action": "specific action"}],
    "trajectory": "overall trajectory description"
}`;

    const response = await callClaude(prompt, 2048);
    return parseJSON(response, { trajectory: 'Unable to analyze' });
}

// ============================================
// Main Pipeline
// ============================================

async function processMonth(month, messages, existingData) {
    // Skip if already processed (unless --force)
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
        // Categorize messages in batches
        for (let i = 0; i < messages.length; i += BATCH_SIZE) {
            const batch = messages.slice(i, i + BATCH_SIZE);
            const cats = await categorizeMessages(batch);
            for (const cat of cats) {
                result.categories[cat] = (result.categories[cat] || 0) + 1;
            }
        }

        // Analyze victim language
        const sample = messages
            .sort(() => Math.random() - 0.5)
            .slice(0, 15)
            .map(m => m.text);
        result.victim = await analyzeVictimLanguage(month, sample);

        // Generate monthly insight
        result.insight = await generateMonthlyInsight(month, messages, {
            total: messages.length,
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

    // Load conversations
    const convos = loadConversations();
    if (convos.length === 0) {
        console.error('No conversations found. Check data paths.');
        process.exit(1);
    }

    // Group by month
    const messagesByMonth = {};
    for (const convo of convos) {
        for (const msg of convo.messages) {
            const monthKey = getMonthKey(msg.timestamp);
            if (!messagesByMonth[monthKey]) {
                messagesByMonth[monthKey] = [];
            }
            messagesByMonth[monthKey].push(msg);
        }
    }

    const months = Object.keys(messagesByMonth).sort();
    console.log(`Found ${months.length} months of data\n`);

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

    // ========== PHASE 2: Aggregation ==========
    console.log('Phase 2: Aggregation');
    console.log('─'.repeat(40));

    const aggregated = {
        categories: { ...existingData.categories },
        victim_analysis: { ...existingData.victim },
        monthly: {},
        category_totals: {},
        generated_at: new Date().toISOString()
    };

    for (const result of monthResults) {
        if (result.skipped) continue;
        if (result.success) {
            aggregated.categories[result.month] = result.categories;
            aggregated.victim_analysis[result.month] = result.victim;
            aggregated.monthly[result.month] = result.insight;
        }
    }

    // Calculate totals
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

    // Save category analysis
    fs.writeFileSync(OUTPUT.categories, JSON.stringify(aggregated, null, 2));
    console.log(`\n  Saved: ${OUTPUT.categories}\n`);

    // ========== PHASE 3: People Analysis (Parallel) ==========
    console.log('Phase 3: People Analysis (parallel)');
    console.log('─'.repeat(40));

    const people = {
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

    // ========== PHASE 4: Overall Insights ==========
    console.log('Phase 4: Overall Insights');
    console.log('─'.repeat(40));

    try {
        const overallInsights = await generateOverallInsights(aggregated);
        const insightsOutput = {
            insights: overallInsights,
            monthly: aggregated.monthly,
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
    console.log('\nNext: Run "node process_data.js" to update dashboard_data.json');
}

main().catch(console.error);
