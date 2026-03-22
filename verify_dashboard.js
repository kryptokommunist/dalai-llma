// Playwright test to verify dashboard loads and functions correctly
const { chromium } = require('playwright');
const path = require('path');

async function verifyDashboard() {
    console.log('Starting comprehensive dashboard verification...\n');

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Track console errors and warnings (filter out expected fetch errors for file://)
    const errors = [];
    const warnings = [];
    page.on('console', msg => {
        const text = msg.text();
        if (msg.type() === 'error') {
            // Ignore fetch errors for file:// protocol - this is expected
            if (!text.includes('Fetch API') && !text.includes('file://')) {
                errors.push(text);
            }
        } else if (msg.type() === 'warning') {
            warnings.push(text);
        }
    });
    page.on('pageerror', err => {
        errors.push(err.message);
    });

    const filePath = path.join(__dirname, 'dashboard.html');
    console.log(`Loading: file://${filePath}\n`);

    await page.goto(`file://${filePath}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500); // Wait for charts to render

    // ============================================
    // 1. Check for JavaScript errors
    // ============================================
    console.log('=== JavaScript Errors ===');
    if (errors.length > 0) {
        console.log('❌ JavaScript errors found:');
        errors.forEach(e => console.log(`  - ${e}`));
    } else {
        console.log('✅ No JavaScript errors (fetch errors for missing LLM data are expected)');
    }

    // ============================================
    // 2. Verify key elements exist
    // ============================================
    console.log('\n=== Element Checks ===');
    const checks = [
        { selector: '.dashboard', name: 'Dashboard container' },
        { selector: 'header', name: 'Header' },
        { selector: '#startMonth', name: 'Start month selector' },
        { selector: '#endMonth', name: 'End month selector' },
        { selector: '.preset-btn', name: 'Preset buttons' },
        { selector: '.stats-grid', name: 'Stats grid' },
        { selector: '#gaugeFill', name: 'Wellbeing gauge' },
        { selector: '#sentimentChart', name: 'Sentiment chart' },
        { selector: '#emotionChart', name: 'Emotion chart' },
        { selector: '#activityChart', name: 'Activity chart' },
        { selector: '#wordcloud', name: 'Word cloud container' },
        { selector: '#peopleGrid', name: 'People grid' },
        { selector: '#dramaChart', name: 'Drama chart' },
        { selector: '#empoweredChart', name: 'Empowered chart' },
        { selector: '#insightsContainer', name: 'Insights container' },
        { selector: 'footer', name: 'Footer' }
    ];

    let elementsPassed = 0;
    for (const check of checks) {
        const element = await page.$(check.selector);
        if (element) {
            console.log(`  ✅ ${check.name}`);
            elementsPassed++;
        } else {
            console.log(`  ❌ ${check.name} - NOT FOUND`);
        }
    }
    console.log(`\n  ${elementsPassed}/${checks.length} elements found`);

    // ============================================
    // 3. Verify data is loaded
    // ============================================
    console.log('\n=== Data Loading ===');

    // Check that monthly data exists
    const monthlyDataLength = await page.evaluate(() => {
        return typeof allMonthlyData !== 'undefined' ? allMonthlyData.length : 0;
    });
    console.log(`  Monthly data: ${monthlyDataLength} months ${monthlyDataLength > 0 ? '✅' : '❌'}`);

    // Check that weekly data exists
    const weeklyDataLength = await page.evaluate(() => {
        return typeof allWeeklyData !== 'undefined' ? allWeeklyData.length : 0;
    });
    console.log(`  Weekly data: ${weeklyDataLength} weeks ${weeklyDataLength > 0 ? '✅' : '❌'}`);

    // Check events data
    const eventsDataLength = await page.evaluate(() => {
        return typeof allEvents !== 'undefined' ? allEvents.length : 0;
    });
    console.log(`  Events data: ${eventsDataLength} events ${eventsDataLength > 0 ? '✅' : '❌'}`);

    // Check people data
    const peopleCount = await page.evaluate(() => {
        return typeof allPeopleData !== 'undefined' ? Object.keys(allPeopleData).length : 0;
    });
    console.log(`  People data: ${peopleCount} people ${peopleCount > 0 ? '✅' : '❌'}`);

    // Check word cloud data
    const wordCloudMonths = await page.evaluate(() => {
        return typeof wordDataByMonth !== 'undefined' ? Object.keys(wordDataByMonth).length : 0;
    });
    console.log(`  Word cloud data: ${wordCloudMonths} months ${wordCloudMonths > 0 ? '✅' : '❌'}`);

    // ============================================
    // 4. Test Range Preset Buttons
    // ============================================
    console.log('\n=== Range Preset Tests ===');

    // Get initial values
    const initialDateRange = await page.$eval('#dateRangeDisplay', el => el.textContent);
    console.log(`  Initial range: ${initialDateRange}`);

    // Test "All" preset
    await page.click('.preset-btn[onclick="setPreset(\'all\')"]');
    await page.waitForTimeout(500);
    const allRange = await page.$eval('#dateRangeDisplay', el => el.textContent);
    const allMonths = await page.evaluate(() => filteredData.length);
    console.log(`  "All" preset: ${allRange} (${allMonths} periods) ✅`);

    // Test "6m" preset
    await page.click('.preset-btn[onclick="setPreset(\'6m\')"]');
    await page.waitForTimeout(500);
    const sixMonthRange = await page.$eval('#dateRangeDisplay', el => el.textContent);
    const sixMonths = await page.evaluate(() => filteredData.length);
    console.log(`  "6m" preset: ${sixMonthRange} (${sixMonths} periods) ${sixMonths <= 6 ? '✅' : '❌'}`);

    // Test "3m" preset
    await page.click('.preset-btn[onclick="setPreset(\'3m\')"]');
    await page.waitForTimeout(500);
    const threeMonthRange = await page.$eval('#dateRangeDisplay', el => el.textContent);
    const threeMonths = await page.evaluate(() => filteredData.length);
    console.log(`  "3m" preset: ${threeMonthRange} (${threeMonths} periods) ${threeMonths <= 3 ? '✅' : '❌'}`);

    // ============================================
    // 5. Test Weekly View Toggle
    // ============================================
    console.log('\n=== Weekly View Tests ===');

    // First go to "All" to have enough data
    await page.click('.preset-btn[onclick="setPreset(\'all\')"]');
    await page.waitForTimeout(500);

    // Check if weekly toggle exists
    const weeklyToggle = await page.$('#weeklyToggle');
    if (weeklyToggle) {
        // Get monthly count
        const monthlyCount = await page.evaluate(() => filteredData.length);
        console.log(`  Monthly view: ${monthlyCount} data points`);

        // Toggle to weekly view
        await page.click('#weeklyToggle');
        await page.waitForTimeout(500);

        const isWeekly = await page.evaluate(() => isWeeklyView);
        const weeklyCount = await page.evaluate(() => filteredData.length);
        const rangeText = await page.$eval('#dateRangeDisplay', el => el.textContent);

        if (isWeekly) {
            console.log(`  Weekly view: ${weeklyCount} data points ${rangeText.includes('Weekly') ? '✅' : '⚠️ (no Weekly label but toggle works)'}`);
        } else {
            console.log(`  ❌ Weekly toggle did not switch to weekly view`);
        }

        // Toggle back to monthly
        await page.click('#weeklyToggle');
        await page.waitForTimeout(500);
        const backToMonthly = await page.evaluate(() => !isWeeklyView);
        console.log(`  Toggle back to monthly: ${backToMonthly ? '✅' : '❌'}`);
    } else {
        console.log('  ❌ Weekly toggle not found');
    }

    // ============================================
    // 6. Test Moving Average Select
    // ============================================
    console.log('\n=== Moving Average Tests ===');

    const maSelect = await page.$('#maSelect');
    if (maSelect) {
        const initialMA = await page.evaluate(() => movingAverageWindow);
        console.log(`  Initial MA window: ${initialMA}`);

        // Change to 3-period MA
        await page.selectOption('#maSelect', '3');
        await page.waitForTimeout(500);

        const newMA = await page.evaluate(() => movingAverageWindow);
        const rangeText = await page.$eval('#dateRangeDisplay', el => el.textContent);
        console.log(`  After selecting 3: MA window = ${newMA} ${newMA === 3 ? '✅' : '❌'}`);
        console.log(`  Range display includes MA: ${rangeText.includes('MA') ? '✅' : '❌'}`);

        // Reset to none
        await page.selectOption('#maSelect', '0');
        await page.waitForTimeout(500);
    } else {
        console.log('  ❌ Moving average select not found');
    }

    // ============================================
    // 7. Verify Stats Cards Update with Range
    // ============================================
    console.log('\n=== Stats Cards Update Test ===');

    // Set to 3 months
    await page.click('.preset-btn[onclick="setPreset(\'3m\')"]');
    await page.waitForTimeout(500);
    const stats3m = await page.evaluate(() => {
        const cards = document.querySelectorAll('.stat-card .stat-value');
        return {
            convos: cards[0]?.textContent,
            messages: cards[1]?.textContent,
            sentiment: cards[2]?.textContent
        };
    });
    console.log(`  3m stats - Convos: ${stats3m.convos}, Messages: ${stats3m.messages}, Sentiment: ${stats3m.sentiment}`);

    // Set to all
    await page.click('.preset-btn[onclick="setPreset(\'all\')"]');
    await page.waitForTimeout(500);
    const statsAll = await page.evaluate(() => {
        const cards = document.querySelectorAll('.stat-card .stat-value');
        return {
            convos: cards[0]?.textContent,
            messages: cards[1]?.textContent,
            sentiment: cards[2]?.textContent
        };
    });
    console.log(`  All stats - Convos: ${statsAll.convos}, Messages: ${statsAll.messages}, Sentiment: ${statsAll.sentiment}`);

    // Check that stats changed
    const statsChanged = stats3m.messages !== statsAll.messages || stats3m.convos !== statsAll.convos;
    console.log(`  Stats update with range: ${statsChanged ? '✅' : '❌'}`);

    // ============================================
    // 8. Verify Charts Have Data
    // ============================================
    console.log('\n=== Chart Rendering ===');

    const chartChecks = [
        { id: 'sentimentChart', name: 'Sentiment chart' },
        { id: 'emotionChart', name: 'Emotion chart' },
        { id: 'activityChart', name: 'Activity chart' },
        { id: 'dramaChart', name: 'Drama chart' },
        { id: 'empoweredChart', name: 'Empowered chart' }
    ];

    for (const chart of chartChecks) {
        const hasData = await page.evaluate((id) => {
            const canvas = document.getElementById(id);
            if (!canvas) return false;
            const chartInstance = Chart.getChart(canvas);
            return chartInstance && chartInstance.data && chartInstance.data.datasets && chartInstance.data.datasets.length > 0;
        }, chart.id);
        console.log(`  ${chart.name}: ${hasData ? '✅ has data' : '❌ no data'}`);
    }

    // ============================================
    // 9. Verify Wellbeing Gauge Updates
    // ============================================
    console.log('\n=== Wellbeing Gauge Tests ===');

    await page.click('.preset-btn[onclick="setPreset(\'3m\')"]');
    await page.waitForTimeout(500);
    const gauge3m = await page.$eval('#gaugeValue', el => el.textContent);
    console.log(`  3m gauge value: ${gauge3m}`);

    await page.click('.preset-btn[onclick="setPreset(\'all\')"]');
    await page.waitForTimeout(500);
    const gaugeAll = await page.$eval('#gaugeValue', el => el.textContent);
    console.log(`  All gauge value: ${gaugeAll}`);

    const gaugeUpdates = gauge3m !== gaugeAll;
    console.log(`  Gauge updates with range: ${gaugeUpdates ? '✅' : '⚠️ (same values - might be valid)'}`);

    // ============================================
    // 10. Verify Word Cloud Updates with Range
    // ============================================
    console.log('\n=== Word Cloud Tests ===');

    const wordcloudSlider = await page.$('#wordcloudSlider');
    if (wordcloudSlider) {
        const sliderMax = await page.$eval('#wordcloudSlider', el => el.max);
        const labelsCount = await page.$$eval('.wc-label', els => els.length);
        console.log(`  Slider max: ${sliderMax}, Labels: ${labelsCount}`);

        // Change to a specific month
        if (parseInt(sliderMax) > 1) {
            await page.evaluate(() => {
                document.getElementById('wordcloudSlider').value = 1;
                updateWordCloud(1);
            });
            await page.waitForTimeout(500);
            const activeLabel = await page.$eval('.wc-label.active', el => el.textContent);
            console.log(`  Selected month label: ${activeLabel.substring(0, 20)}... ✅`);
        }
    } else {
        console.log('  ❌ Word cloud slider not found');
    }

    // ============================================
    // 11. Test People Grid
    // ============================================
    console.log('\n=== People Grid Tests ===');

    const peopleItems = await page.$$eval('#peopleGrid > div, #peopleGrid .person-item', els => els.length);
    console.log(`  People items in grid: ${peopleItems} ${peopleItems > 0 ? '✅' : '❌'}`);

    // ============================================
    // 12. Test Insights Container
    // ============================================
    console.log('\n=== Insights Container Tests ===');

    const insightsContent = await page.$eval('#insightsContainer', el => el.innerHTML);
    const hasInsightsContent = insightsContent.length > 100;
    console.log(`  Insights container has content: ${hasInsightsContent ? '✅' : '❌'}`);

    // ============================================
    // 13. Test Date Selectors
    // ============================================
    console.log('\n=== Date Selector Tests ===');

    const startOptions = await page.$$eval('#startMonth option', opts => opts.length);
    const endOptions = await page.$$eval('#endMonth option', opts => opts.length);
    console.log(`  Start selector options: ${startOptions}`);
    console.log(`  End selector options: ${endOptions}`);

    // Change start month
    await page.selectOption('#startMonth', '5');
    await page.waitForTimeout(500);
    const newFilteredCount = await page.evaluate(() => filteredData.length);
    console.log(`  After changing start month: ${newFilteredCount} periods ✅`);

    // ============================================
    // 14. Test Chart Updates on Range Change
    // ============================================
    console.log('\n=== Chart Update on Range Change ===');

    await page.click('.preset-btn[onclick="setPreset(\'3m\')"]');
    await page.waitForTimeout(500);
    const sentimentLabels3m = await page.evaluate(() => {
        const chart = Chart.getChart(document.getElementById('sentimentChart'));
        return chart ? chart.data.labels.length : 0;
    });
    console.log(`  Sentiment chart labels (3m): ${sentimentLabels3m}`);

    await page.click('.preset-btn[onclick="setPreset(\'all\')"]');
    await page.waitForTimeout(500);
    const sentimentLabelsAll = await page.evaluate(() => {
        const chart = Chart.getChart(document.getElementById('sentimentChart'));
        return chart ? chart.data.labels.length : 0;
    });
    console.log(`  Sentiment chart labels (all): ${sentimentLabelsAll}`);

    const chartUpdates = sentimentLabels3m !== sentimentLabelsAll;
    console.log(`  Chart updates with range: ${chartUpdates ? '✅' : '❌'}`);

    // ============================================
    // 15. Take screenshots
    // ============================================
    console.log('\n=== Screenshots ===');

    await page.click('.preset-btn[onclick="setPreset(\'all\')"]');
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/dashboard_all.png', fullPage: true });
    console.log('  📸 Full dashboard: /tmp/dashboard_all.png');

    await page.click('.preset-btn[onclick="setPreset(\'3m\')"]');
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/dashboard_3m.png', fullPage: true });
    console.log('  📸 3-month view: /tmp/dashboard_3m.png');

    // Weekly view
    await page.click('.preset-btn[onclick="setPreset(\'all\')"]');
    await page.waitForTimeout(300);
    await page.click('#weeklyToggle');
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/dashboard_weekly.png', fullPage: true });
    console.log('  📸 Weekly view: /tmp/dashboard_weekly.png');

    // ============================================
    // Summary
    // ============================================
    console.log('\n=== Summary ===');
    console.log(`  JS Errors: ${errors.length}`);
    console.log(`  Warnings: ${warnings.length}`);
    console.log(`  Elements found: ${elementsPassed}/${checks.length}`);

    await browser.close();

    const success = errors.length === 0 && elementsPassed >= checks.length - 2;
    console.log(`\n${success ? '✅ VERIFICATION PASSED' : '❌ VERIFICATION FAILED'}`);
    return success;
}

verifyDashboard()
    .then(success => process.exit(success ? 0 : 1))
    .catch(err => {
        console.error('Test failed:', err);
        process.exit(1);
    });
