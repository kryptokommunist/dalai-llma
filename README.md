# DalaiLLMA - LLM Conversation Sentiment Dashboard

<p align="center">
  <img src="dalaillma-logo.png" alt="DalaiLLMA Logo" width="100%">
</p>

A personal analytics dashboard that visualizes sentiment, wellbeing, and patterns from your Claude and ChatGPT conversation history.

## Features

- **Sentiment Tracking**: Monitor emotional tone over time (hopeful vs despair language)
- **Wellbeing Score**: Composite metric combining sentiment, agency, and other indicators
- **Word Clouds**: Visual representation of frequent topics per month
- **People Analysis**: Track who you discuss and associated sentiment
- **Category Breakdown**: See what topics dominate your conversations (work, relationships, mental health, etc.)
- **Events Timeline**: Significant life events extracted from conversations
- **Drama Triangle**: Karpman triangle analysis (victim/persecutor/rescuer patterns)
- **Victim vs Empowered Language**: Track agency in your communication patterns
- **LLM Insights**: AI-generated deeper analysis using Claude API (optional, parallel processing)

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/kryptokommunist/dalaillma
cd dalaillma
npm install
npm run setup   # Creates data/ and output/ directories
```

### 2. Export Your Conversation Data

**Claude.ai:**
- Go to Settings → Export data
- Download and extract the zip
- Copy `conversations.json` to `data/anthropic/`

**ChatGPT:**
- Go to Settings → Data controls → Export data
- Wait for email, download the zip
- Copy the `Conversations__*.zip` file to `data/openai/` (no need to extract)

### 3. Process Data (Basic Analysis - No API Required)

```bash
npm run process    # Analyzes conversations
npm run build      # Generates dashboard HTML
```

Or run both in one command:
```bash
npm run all
```

This generates:
- `output/dashboard_data.json` - Basic sentiment, word frequencies, events
- `dashboard.html` - Your personalized dashboard

### 4. View Your Dashboard

```bash
npm run serve
# Open http://localhost:3000/dashboard.html
```

Or just open `dashboard.html` directly in your browser (works with `file://` protocol).

### 5. LLM Analysis (Optional - Requires Anthropic API)

For deeper AI-generated insights:

```bash
# Set your Anthropic API credentials
export ANTHROPIC_BASE_URL="https://api.anthropic.com/"
export ANTHROPIC_AUTH_TOKEN="your-api-key"
export ANTHROPIC_MODEL="claude-3-sonnet-20240229"

# Run full analysis (processes in parallel)
npm run full
```

This generates additional files:
- `output/category_analysis.json` - LLM-categorized messages per month
- `output/llm_insights.json` - Overall patterns and recommendations
- `output/person_insights.json` - Relationship analysis

**Processing time**: ~5 minutes for 30 months with parallel processing

## Directory Structure

```
dalaillma/
├── data/                    # Your exports (gitignored)
│   ├── anthropic/
│   │   └── conversations.json
│   └── openai/
│       └── Conversations__*.zip
├── output/                  # Generated data (gitignored)
│   ├── dashboard_data.json
│   ├── category_analysis.json    # (optional, from LLM analysis)
│   ├── llm_insights.json         # (optional, from LLM analysis)
│   └── person_insights.json      # (optional, from LLM analysis)
├── scripts/
│   ├── process_data.js      # Basic analysis (no API)
│   ├── analyze_all.js       # Parallel LLM analysis
│   └── build_dashboard.js   # Generate HTML from data
├── templates/
│   └── dashboard.html       # Dashboard template
├── dashboard.html           # Generated output (gitignored)
├── dalaillma-logo.png
├── README.md
└── package.json
```

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run setup` | Create data directories |
| `npm run process` | Basic sentiment analysis (no API) |
| `npm run analyze` | LLM analysis (requires API) |
| `npm run analyze:force` | Re-analyze all months |
| `npm run build` | Generate dashboard HTML |
| `npm run all` | Process + build (no API) |
| `npm run full` | Process + analyze + build (with API) |
| `npm run serve` | Start local server |

## Environment Variables

```bash
# Optional: Custom data/output paths
export DATA_DIR="./data"
export OUTPUT_DIR="./output"

# Required for LLM analysis only
export ANTHROPIC_BASE_URL="https://api.anthropic.com/"
export ANTHROPIC_AUTH_TOKEN="your-api-key"
export ANTHROPIC_MODEL="claude-3-sonnet-20240229"
```

## How It Works

### Basic Analysis (process_data.js)
- Parses Claude and ChatGPT conversation exports
- Calculates sentiment using keyword matching (hopeful vs despair words)
- Tracks agency via phrase patterns ("I can" vs "I have to")
- Extracts significant events from conversation titles
- Counts people mentions and associated sentiment
- Generates word frequency data

### LLM Analysis (analyze_all.js)
- Uses Claude API to categorize messages (relationships, work, mental health, etc.)
- Analyzes victim vs empowered language patterns
- Generates monthly insights and themes
- Creates relationship summaries for mentioned people
- Produces overall patterns and recommendations

### Dashboard Builder (build_dashboard.js)
- Reads processed data from `output/`
- Injects data into the HTML template
- Creates a self-contained `dashboard.html` file
- Works with `file://` protocol (no server required)

## Data Privacy

- **All processing happens locally** - no data sent anywhere except Anthropic API (if using LLM analysis)
- Your data stays in `data/` which is gitignored
- Generated outputs in `output/` are gitignored
- The generated `dashboard.html` is gitignored
- Never commit API keys, conversation exports, or personal insights

## Testing

Verify dashboard loads correctly with Playwright:

```bash
npm install playwright
npm test
```

## License

MIT
