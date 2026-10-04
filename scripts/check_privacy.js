#!/usr/bin/env node
/**
 * DalaiLLMA - Privacy & Leak Check
 *
 * Scans all tracked files for:
 *   - Personal phone numbers and account IDs
 *   - Hardcoded personal names (from local data/people.json or known sensitive terms)
 *   - API keys and tokens (sk-...)
 *   - Sensitive medical / personal narrative keywords in committed templates
 *
 * Run: npm run check:privacy
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getTrackedFiles() {
    try {
        const out = execSync('git ls-files', { encoding: 'utf8' });
        return out.trim().split('\n').filter(Boolean);
    } catch (e) {
        return [];
    }
}

// Load sensitive names from local data/people.json if available
let sensitiveNames = [];
const peopleFile = path.join(__dirname, '..', 'data', 'people.json');
if (fs.existsSync(peopleFile)) {
    try {
        sensitiveNames = JSON.parse(fs.readFileSync(peopleFile, 'utf8'));
    } catch (e) {}
}

const nameRegexes = sensitiveNames
    .filter(n => typeof n === 'string' && n.length > 2)
    .map(n => ({ name: n, regex: new RegExp(`\\b${n}\\b`, 'i') }));

const checks = [
    { label: 'German/Intl Phone Number', regex: /\+49[0-9]{8,12}/ },
    { label: 'Telegram/Twitter User ID', regex: /(?:telegramUserId|twitterAccountId)\s*:\s*['"][0-9]{5,}['"]/ },
    { label: 'API Key / Secret Token', regex: /sk-[a-zA-Z0-9]{20,}/ },
    { label: 'Personal Address/Locations', regex: /\b(Gleditsch|Rigaer)\b/i },
    { label: 'Sensitive Therapy Narrative', regex: /\b(IFS therapy correlated|termination email|Ankle fracture|Surgery recovery)\b/i }
];

const files = getTrackedFiles();
let violations = 0;

for (const file of files) {
    if (file.endsWith('.png') || file.endsWith('.ico') || file.endsWith('.lock')) continue;
    if (!fs.existsSync(file)) continue;

    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, idx) => {
        // Skip check_privacy itself when scanning pattern definitions
        if (file.includes('check_privacy.js')) return;

        for (const c of checks) {
            if (c.regex.test(line)) {
                console.error(`❌ [${c.label}] ${file}:${idx + 1}`);
                console.error(`   ${line.trim().substring(0, 100)}`);
                violations++;
            }
        }

        for (const nr of nameRegexes) {
            if (nr.regex.test(line)) {
                console.error(`❌ [Personal Name: ${nr.name}] ${file}:${idx + 1}`);
                console.error(`   ${line.trim().substring(0, 100)}`);
                violations++;
            }
        }
    });
}

if (violations > 0) {
    console.error(`\n🚨 Found ${violations} potential privacy violation(s) in tracked files!`);
    process.exit(1);
} else {
    console.log(`✅ Privacy check passed: 0 leaks found across ${files.length} tracked files.`);
}
