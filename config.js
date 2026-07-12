import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  try {
    const env = readFileSync(resolve(__dirname, '.env'), 'utf-8');
    for (const line of env.split('\n')) {
      if (/^\s*#/.test(line) || line.trim() === '') continue;
      const [k, ...v] = line.split('=');
      if (k && v.length) process.env[k.trim()] = v.join('=').trim();
    }
  } catch {}
}
loadEnv();

export default {
  DEEPSEEK_KEY: process.env.DEEPSEEK_API_KEY || '',
  DEEPSEEK_URL: 'https://api.deepseek.com/v1/chat/completions',
  DEEPSEEK_MODEL: 'deepseek-chat',

  PORT: process.env.PORT || 7749,
  HOST: '127.0.0.1',

  USER_DIR: resolve(__dirname, 'user'),
  PROMPTS_DIR: resolve(__dirname, 'prompts'),
  STATE_PATH: resolve(__dirname, 'state', 'db.json'),
};
