import { type ChildProcess, spawn, spawnSync } from 'node:child_process';

/**
 * Starts a local anvil forking Sepolia, for tests only.
 *
 * A fork gives the real deployed contract — real bytecode, real linked
 * libraries, real state — without any of it being compiled here, and without a
 * single transaction reaching the live network. Everything the tests do happens
 * against the local fork.
 *
 * It needs the network at fork time, so every test using it is opt-in and
 * guarded by `ZARYA_FORK_RPC_URL`, exactly as `zarya-testing` requires of
 * anything that depends on Sepolia.
 */

export interface AnvilOptions {
  /** Upstream RPC to fork from. Secret: never logged. */
  forkUrl: string;
  /** Override the forked chain id — the only way to test the wrong-network path. */
  chainId?: number;
  /** Pin the fork block so a run is reproducible. */
  forkBlockNumber?: bigint;
  startupTimeoutMs?: number;
}

export interface AnvilHandle {
  readonly url: string;
  /** Kills the node. Used both for cleanup and to simulate an outage. */
  stop(): Promise<void>;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 200;

/** Ephemeral range, avoiding anvil's default 8545 so a local node is untouched. */
const randomPort = (): number => 9000 + Math.floor(Math.random() * 2000);

const rpcResponds = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { result?: unknown };
    return typeof body.result === 'string';
  } catch {
    return false;
  }
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function startAnvil({
  forkUrl,
  chainId,
  forkBlockNumber,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
}: AnvilOptions): Promise<AnvilHandle> {
  const port = randomPort();
  const url = `http://127.0.0.1:${port}`;

  const args = ['--fork-url', forkUrl, '--port', String(port), '--silent'];
  if (chainId !== undefined) args.push('--chain-id', String(chainId));
  if (forkBlockNumber !== undefined) args.push('--fork-block-number', String(forkBlockNumber));

  // No `shell: true`. On Windows that wraps anvil in a cmd.exe, and killing the
  // wrapper leaves the node running — which silently turns an "outage" test into
  // a test against a live node. Node resolves anvil.exe from PATH without it.
  const child: ChildProcess = spawn('anvil', args, {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  // stderr is captured rather than inherited: anvil echoes the fork URL, which
  // may carry an API key, and it must not reach the test log.
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const stop = async (): Promise<void> => {
    if (!exited) {
      if (process.platform === 'win32' && child.pid !== undefined) {
        // Kill the whole tree: anvil can outlive a plain kill on Windows.
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    }
    // Waiting on the process exiting is not enough — the test's premise is that
    // the endpoint stops answering, so wait for exactly that.
    for (let waited = 0; waited < 10_000; waited += POLL_INTERVAL_MS) {
      if (!(await rpcResponds(url))) return;
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error('anvil kept answering after being killed');
  };

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      // Redact defensively: the message is about to be thrown into a report.
      throw new Error(
        `anvil exited during startup: ${stderr.replaceAll(forkUrl, '<fork-url>').slice(0, 500)}`,
      );
    }
    if (await rpcResponds(url)) return { url, stop };
    await delay(POLL_INTERVAL_MS);
  }

  await stop();
  throw new Error(`anvil did not become ready within ${startupTimeoutMs}ms`);
}

/** The fork URL, or `undefined` when fork tests should skip. */
export const forkRpcUrl = (): string | undefined => {
  const url = process.env.ZARYA_FORK_RPC_URL?.trim();
  return url === undefined || url.length === 0 ? undefined : url;
};

/** Optional pinned block for reproducibility across runs. */
export const forkBlockNumber = (): bigint | undefined => {
  const raw = process.env.ZARYA_FORK_BLOCK?.trim();
  return raw === undefined || raw.length === 0 ? undefined : BigInt(raw);
};
