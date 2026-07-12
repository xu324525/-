const colors = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', dim: '\x1b[2m',
};

export function info(msg, ...args) {
  console.log(`${colors.green}[INFO]${colors.reset}`, msg, ...args);
}

export function warn(msg, ...args) {
  console.warn(`${colors.yellow}[WARN]${colors.reset}`, msg, ...args);
}

export function error(msg, ...args) {
  console.error(`${colors.red}[ERROR]${colors.reset}`, msg, ...args);
}

export function debug(msg, ...args) {
  console.log(`${colors.dim}[DEBUG]${colors.reset}`, msg, ...args);
}
