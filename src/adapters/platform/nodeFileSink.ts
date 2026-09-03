import { writeFile } from 'node:fs/promises';
import type { FileSink } from '../../domain/ports/FileSink';

/**
 * `FileSink` over `node:fs`.
 *
 * Lives in `platform/` beside the id generator rather than in `forms/`, because
 * nothing about it is specific to a PDF — the matrix report and, later, a
 * regenerated receipt write through the same port.
 *
 * `writeFile` rather than a stream: these documents are hundreds of kilobytes,
 * already fully in memory by the time they arrive here, and a partial write is
 * worse than a slow one. The default flag truncates an existing file, which is
 * what the save dialog already promised the user.
 */
export class NodeFileSink implements FileSink {
  async write(target: string, bytes: Uint8Array): Promise<void> {
    // The error is left as Node wrote it. It names the path and the errno, which
    // is what a user needs — "permission denied" or "no such directory" is
    // actionable where a rewritten message would not be. It reaches the renderer
    // only through the worker's failure reply, which carries no configuration.
    await writeFile(target, bytes);
  }
}
