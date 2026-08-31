#!/usr/bin/env node

const { execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_FILE = path.join(os.homedir(), '.ai-commit-config.json');

function getSavedKey() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).apiKey || '';
    }
  } catch {}
  return '';
}

function saveKey(apiKey) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ apiKey }), 'utf8');
    console.log('✓ Pro API Key saved successfully!\n');
  } catch {}
}

const args = process.argv.slice(2);
const keyFlagIndex = args.indexOf('--key');
let apiKey = getSavedKey();

if (keyFlagIndex !== -1 && args[keyFlagIndex + 1]) {
  apiKey = args[keyFlagIndex + 1];
  saveKey(apiKey);
}

// 1. git diff --staged の取得
let diff = '';
try {
  diff = execSync('git diff --staged', { encoding: 'utf8' }).trim();
} catch (e) {
  console.error('Error: Failed to execute git diff. Ensure you are inside a Git repository.');
  process.exit(1);
}

if (!diff) {
  console.log('No staged changes found. Run "git add <files>" first.');
  process.exit(0);
}

console.log('Generating Conventional Commit & PR Summary with AI...\n');

const data = JSON.stringify({ diff, apiKey });

const options = {
  hostname: 'ai-commit-tool.ikeda-lef.workers.dev',
  port: 443,
  path: '/api/generate',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
  }
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    try {
      const result = JSON.parse(body);
      if (res.statusCode === 402) {
        console.error(`\x1b[33m${result.error}\x1b[0m`);
        console.log(`\n👉 Upgrade Link: ${result.stripeUrl}\n`);
        process.exit(1);
      }
      if (result.commit) {
        console.log('\x1b[32m=== Proposed Commit Message ===\x1b[0m');
        console.log(result.commit);
        console.log('\n\x1b[36m=== PR Summary ===\x1b[0m');
        console.log(result.pr);
        if (!result.isPro) {
          console.log('\n\x1b[90m--------------------------------------------------\x1b[0m');
          console.log('\x1b[90m[Pro Tip] Upgrade to unlimited Pro ($1/mo): https://buy.stripe.com/6oU5kDbjJeQ2aBbg1E5J601\x1b[0m');
        }
      } else {
        console.error('Generation failed:', result.error || 'Unknown error');
      }
    } catch (e) {
      console.error('Error parsing response:', body);
    }
  });
});

req.on('error', (e) => {
  console.error('Network request failed:', e.message);
});

req.write(data);
req.end();
