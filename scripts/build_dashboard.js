#!/usr/bin/env node
/**
 * DalaiLLMA - Dashboard Builder
 *
 * Reads processed data from output/ and injects it into the dashboard template.
 * Creates a self-contained HTML file with embedded data.
 *
 * Usage: node scripts/build_dashboard.js
 */

const fs = require('fs');
const path = require('path');

// Paths - configurable via environment variables
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';
const TEMPLATE_PATH = process.env.TEMPLATE_PATH || './templates/dashboard.html';
const DASHBOARD_OUTPUT = process.env.DASHBOARD_OUTPUT || './dashboard.html';

// Data files to load
const DATA_FILES = {
    dashboard: 'dashboard_data.json',
    categories: 'category_analysis.json',
    insights: 'llm_insights.json',
    people: 'person_insights.json'
};

function loadJSON(filePath) {
    if (fs.existsSync(filePath)) {
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            console.warn(`Warning: Could not parse ${filePath}: ${e.message}`);
            return null;
        }
    }
    console.warn(`Warning: File not found: ${filePath}`);
    return null;
}

function formatMonthLabel(monthStr) {
    // Convert "2024-08" to "Aug 24" format
    const [year, month] = monthStr.split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const shortYear = year.slice(2);
    return `${months[parseInt(month) - 1]} ${shortYear}`;
}

function formatWeekLabel(weekStr) {
    // Convert "2024-W35" to "W35 '24" format
    const match = weekStr.match(/(\d{4})-W(\d+)/);
    if (match) {
        return `W${match[2]} '${match[1].slice(2)}`;
    }
    return weekStr;
}

function convertToYYYYMM(monthStr) {
    // Convert "Aug 2024" to "2024-08"
    const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                     Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    const parts = monthStr.split(' ');
    if (parts.length === 2 && months[parts[0]]) {
        return `${parts[1]}-${months[parts[0]]}`;
    }
    return monthStr;
}

function generateMonthlyDataJS(dashboardData) {
    if (!dashboardData?.monthlyData) return '[]';

    return dashboardData.monthlyData.map(m => {
        const month = convertToYYYYMM(m.month);
        return {
            month,
            label: formatMonthLabel(month),
            messages: m.messages || 0,
            convos: m.conversations || 0,
            sentiment: m.sentiment || 0,
            agency: m.agency || 50,
            lateNight: 30, // placeholder
            wellbeing: m.wellbeing || 50
        };
    });
}

function generateWeeklyDataJS(dashboardData) {
    if (!dashboardData?.weeklyData) return '[]';

    return dashboardData.weeklyData.map(w => ({
        week: w.week,
        label: formatWeekLabel(w.week),
        messages: w.messages || 0,
        convos: 0, // not tracked at week level
        sentiment: w.sentiment || 0,
        agency: w.agency || 50,
        lateNight: 30,
        wellbeing: w.wellbeing || 50
    }));
}

function generateEventsJS(dashboardData) {
    if (!dashboardData?.events) return '[]';

    return dashboardData.events.map(e => ({
        date: e.date,
        month: e.date?.substring(0, 7) || '',
        title: e.title || 'Event',
        category: e.category || 'other'
    }));
}

function generateDramaTriangleJS(dashboardData) {
    if (!dashboardData?.dramaTriangle) return '{}';

    const result = {};
    for (const [month, data] of Object.entries(dashboardData.dramaTriangle)) {
        const monthKey = convertToYYYYMM(month);
        result[monthKey] = {
            victim: data.victim || 0,
            persecutor: data.persecutor || 0,
            rescuer: data.rescuer || 0,
            empowered: data.empowered || 0
        };
    }
    return result;
}

function generatePeopleDataJS(dashboardData) {
    if (!dashboardData?.peopleData) return '{}';

    const result = {};
    for (const [person, data] of Object.entries(dashboardData.peopleData)) {
        const byMonth = {};
        if (data.byMonth) {
            for (const [month, count] of Object.entries(data.byMonth)) {
                byMonth[convertToYYYYMM(month)] = count;
            }
        }
        result[person] = {
            name: person.charAt(0).toUpperCase() + person.slice(1),
            context: data.context || 'Unknown',
            sentiment: data.sentiment || 0,
            byMonth
        };
    }
    return result;
}

function generateWordCloudJS(dashboardData) {
    if (!dashboardData?.wordFrequencies) return '{}';

    const result = {};
    for (const [key, words] of Object.entries(dashboardData.wordFrequencies)) {
        const monthKey = key === 'all' ? 'all' : convertToYYYYMM(key);
        result[monthKey] = words.slice(0, 50);
    }
    return result;
}

function build() {
    console.log('Building dashboard...\n');

    // Check template exists
    if (!fs.existsSync(TEMPLATE_PATH)) {
        console.error(`ERROR: Template not found at ${TEMPLATE_PATH}`);
        console.error('Run from repository root or set TEMPLATE_PATH environment variable.');
        process.exit(1);
    }

    // Load all data files
    const data = {};
    let hasBasicData = false;

    for (const [key, filename] of Object.entries(DATA_FILES)) {
        const filePath = path.join(OUTPUT_DIR, filename);
        data[key] = loadJSON(filePath);
        if (key === 'dashboard' && data[key]) {
            hasBasicData = true;
        }
    }

    if (!hasBasicData) {
        console.error(`ERROR: Required file ${DATA_FILES.dashboard} not found in ${OUTPUT_DIR}/`);
        console.error('Run "npm run process" first to generate basic analysis data.');
        process.exit(1);
    }

    console.log('Loaded data files:');
    console.log(`  - dashboard_data.json: ${data.dashboard ? 'OK' : 'missing'}`);
    console.log(`  - category_analysis.json: ${data.categories ? 'OK' : 'missing (run npm run analyze)'}`);
    console.log(`  - llm_insights.json: ${data.insights ? 'OK' : 'missing (run npm run analyze)'}`);
    console.log(`  - person_insights.json: ${data.people ? 'OK' : 'missing (run npm run analyze)'}`);
    console.log('');

    // Generate JavaScript data blocks
    const monthlyData = generateMonthlyDataJS(data.dashboard);
    const weeklyData = generateWeeklyDataJS(data.dashboard);
    const events = generateEventsJS(data.dashboard);
    const dramaTriangle = generateDramaTriangleJS(data.dashboard);
    const peopleData = generatePeopleDataJS(data.dashboard);
    const wordCloud = generateWordCloudJS(data.dashboard);

    // Calculate date range for footer
    const metadata = data.dashboard?.metadata || {};
    const startDate = metadata.dateRange?.start ? new Date(metadata.dateRange.start) : new Date();
    const endDate = metadata.dateRange?.end ? new Date(metadata.dateRange.end) : new Date();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dateRangeStr = `${months[startDate.getMonth()]} ${startDate.getFullYear()} - ${months[endDate.getMonth()]} ${endDate.getFullYear()}`;

    // Read template
    let template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

    // Replace placeholders
    const replacements = {
        '/* __MONTHLY_DATA__ */': `const allMonthlyData = ${JSON.stringify(monthlyData, null, 4).replace(/\n/g, '\n        ')};`,
        '/* __WEEKLY_DATA__ */': `const allWeeklyData = ${JSON.stringify(weeklyData, null, 4).replace(/\n/g, '\n        ')};`,
        '/* __EVENTS_DATA__ */': `const allEvents = ${JSON.stringify(events, null, 4).replace(/\n/g, '\n        ')};`,
        '/* __DRAMA_TRIANGLE_DATA__ */': `const dramaTriangleData = ${JSON.stringify(dramaTriangle, null, 4).replace(/\n/g, '\n        ')};`,
        '/* __PEOPLE_DATA__ */': `const allPeopleData = ${JSON.stringify(peopleData, null, 4).replace(/\n/g, '\n        ')};`,
        '/* __WORD_CLOUD_DATA__ */': `const wordCloudByMonth = ${JSON.stringify(wordCloud, null, 4).replace(/\n/g, '\n        ')};`,
        '__DATE_RANGE__': dateRangeStr,
        '__TOTAL_CONVOS__': String(metadata.totalConversations || 0),
        '__TOTAL_MESSAGES__': String(metadata.totalMessages || 0),
        '__GENERATED_DATE__': new Date().toISOString().split('T')[0]
    };

    for (const [placeholder, replacement] of Object.entries(replacements)) {
        template = template.replace(placeholder, replacement);
    }

    // Inject LLM insights data if available
    if (data.insights) {
        template = template.replace(
            '/* __LLM_INSIGHTS_DATA__ */',
            `const llmInsightsData = ${JSON.stringify(data.insights, null, 4).replace(/\n/g, '\n        ')};`
        );
    }

    // Inject category analysis if available
    if (data.categories) {
        template = template.replace(
            '/* __CATEGORY_DATA__ */',
            `const categoryData = ${JSON.stringify(data.categories, null, 4).replace(/\n/g, '\n        ')};`
        );
    }

    // Inject person insights if available
    if (data.people) {
        template = template.replace(
            '/* __PERSON_INSIGHTS_DATA__ */',
            `const personInsightsData = ${JSON.stringify(data.people, null, 4).replace(/\n/g, '\n        ')};`
        );
    }

    // Write output
    fs.writeFileSync(DASHBOARD_OUTPUT, template);

    console.log(`Dashboard built successfully!`);
    console.log(`Output: ${DASHBOARD_OUTPUT}`);
    console.log(`\nData summary:`);
    console.log(`  - ${monthlyData.length} months`);
    console.log(`  - ${weeklyData.length} weeks`);
    console.log(`  - ${events.length} events`);
    console.log(`  - ${Object.keys(peopleData).length} people tracked`);
    console.log(`\nTo view: npm run serve`);
}

build();
