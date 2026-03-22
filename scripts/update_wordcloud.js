const fs = require('fs');

// Load dashboard data
const data = JSON.parse(fs.readFileSync('dashboard_data.json', 'utf8'));

// Convert month format
const monthMap = { 'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
                   'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12' };

const wordData = {};
Object.entries(data.wordFrequencies).forEach(([key, value]) => {
    if (key === 'all') {
        wordData['all'] = value.slice(0, 30);
    } else {
        const [month, year] = key.split(' ');
        const newKey = year + '-' + monthMap[month];
        wordData[newKey] = value.slice(0, 20);
    }
});

// Read HTML file
let html = fs.readFileSync('sentiment_dashboard_personal.html', 'utf8');

// Find and replace the wordDataByMonth section
const startMarker = '// Word cloud data by month (extracted from conversations)';
const endMarker = '// Dynamic word cloud keys based on filtered range';

const startIdx = html.indexOf(startMarker);
const endIdx = html.indexOf(endMarker);

if (startIdx === -1 || endIdx === -1) {
    console.error('Could not find markers');
    process.exit(1);
}

// Generate new word data section
const sortedKeys = Object.keys(wordData).filter(k => k !== 'all').sort();
const lines = [
    '// Word cloud data by month (extracted from conversations)',
    '        const wordDataByMonth = {'
];
sortedKeys.forEach(k => {
    const compact = JSON.stringify(wordData[k]);
    lines.push(`            "${k}": ${compact},`);
});
const allCompact = JSON.stringify(wordData['all']);
lines.push(`            "all": ${allCompact}`);
lines.push('        };');
lines.push('');

const newSection = lines.join('\n');
const newHtml = html.substring(0, startIdx) + newSection + '        ' + html.substring(endIdx);

fs.writeFileSync('sentiment_dashboard_personal.html', newHtml);
console.log('Updated word cloud data in dashboard');
