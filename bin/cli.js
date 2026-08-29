#!/usr/bin/env node

import { execSync } from 'child_process';
import readline from 'readline';

async function main() {
  let diff = '';
  try {
    diff = execSync('git diff --staged', { encoding: 'utf-8' });
    if (!diff) {
      diff = execSync('git diff', { encoding: 'utf-8' });
    }
  } catch (e) {
    console.error('Gitリポジトリ内で実行してください。');
    process.exit(1);
  }

  if (!diff.trim()) {
    console.log('変更差分がありません。ファイルをステージングするか、変更を加えてから実行してください。');
    process.exit(0);
  }

  console.log('AIがコミット文を生成中...');

  try {
    const res = await fetch('https://ai-commit-tool.ikeda-lef.workers.dev/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ diff })
    });

    const data = await res.json();
    const commitMsg = data.commit || data.commitMessage || data.message || data.result;

    if (!commitMsg) {
      console.error('コミット文の生成に失敗しました。');
      process.exit(1);
    }

    console.log('\n--- 生成されたコミット文 ---');
    console.log(commitMsg);
    console.log('----------------------------\n');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('この内容でコミットしますか？ (y/N): ', (answer) => {
      if (answer.trim().toLowerCase() === 'y') {
        try {
          execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
          console.log('コミットが完了しました！');
        } catch (err) {
          console.error('コミット実行中にエラーが発生しました。');
        }
      } else {
        console.log('コミットをキャンセルしました。');
      }
      rl.close();
    });

  } catch (err) {
    console.error('通信エラーが発生しました:', err.message);
    process.exit(1);
  }
}

main();
