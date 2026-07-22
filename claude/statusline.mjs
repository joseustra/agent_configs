#!/usr/bin/env node
import fs from 'fs';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(stdin);
    const transcript = data.transcript_path;
    const modelId = (data.model?.id || '').toLowerCase();
    const modelName = data.model?.display_name || data.model?.id || 'claude';

    const is1M = modelId.includes('1m') || modelId.includes('[1m]');
    const limit = is1M ? 1_000_000 : 200_000;

    let tokens = 0;
    if (transcript && fs.existsSync(transcript)) {
      const lines = fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          const usage = entry.message?.usage;
          if (usage) {
            tokens = (usage.input_tokens || 0)
                   + (usage.cache_read_input_tokens || 0)
                   + (usage.cache_creation_input_tokens || 0);
            break;
          }
        } catch {}
      }
    }

    const pct = (tokens / limit) * 100;
    const pctStr = pct.toFixed(1);
    const tokensStr = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
    const limitStr = limit >= 1_000_000 ? '1M' : '200k';

    let color = '\x1b[32m';
    if (pct > 75) color = '\x1b[31m';
    else if (pct > 50) color = '\x1b[33m';
    const dim = '\x1b[2m';
    const reset = '\x1b[0m';

    const cwd = (data.workspace?.current_dir || data.cwd || '').replace(process.env.HOME || '', '~');

    process.stdout.write(
      `${dim}${modelName}${reset} ${dim}|${reset} ${color}ctx ${tokensStr}/${limitStr} (${pctStr}%)${reset} ${dim}|${reset} ${dim}${cwd}${reset}`
    );
  } catch (e) {
    process.stdout.write(`statusline error: ${e.message}`);
  }
});
