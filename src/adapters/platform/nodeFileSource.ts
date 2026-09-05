import { open } from 'node:fs/promises';
import type { FileSource } from '../../domain/ports/FileSource';

/**
 * `FileSource` over `node:fs`.
 *
 * Beside `NodeFileSink` and for the same reason: nothing about it is specific to
 * a PDF, and the port it implements is about files rather than about forms.
 *
 * ## Why it opens rather than calling `readFile`
 *
 * The size has to be known **before** the bytes are in memory. `readFile` on a
 * path the user picked will happily allocate whatever is there — a multi-gigabyte
 * file chosen by mistake takes the worker down before the parser's own cap ever
 * runs, and that cap is the thing meant to be enforcing this.
 *
 * So the handle is opened, `stat` answers from the handle rather than from the
 * path — the same file, not a second lookup something could have swapped
 * underneath — and an oversized one is refused without being read.
 */
export class NodeFileSource implements FileSource {
  /**
   * Generous against the parser's own 4 MiB limit, and deliberately not equal to
   * it: this bound exists to stop an allocation, and the parser's exists to
   * refuse a document with a message about governance forms. A file between the
   * two is read and then properly rejected, which is a better answer than a
   * refusal from a layer that knows nothing about forms.
   */
  static readonly MAX_BYTES = 64 * 1024 * 1024;

  async read(target: string): Promise<Uint8Array> {
    const handle = await open(target, 'r');
    try {
      const { size } = await handle.stat();
      if (size > NodeFileSource.MAX_BYTES) {
        throw new Error(
          `${target} is ${Math.round(size / (1024 * 1024))} MB, past the ` +
            `${NodeFileSource.MAX_BYTES / (1024 * 1024)} MB this application will open`,
        );
      }
      // The error from a failed read is left as Node wrote it: it names the path
      // and the errno, which is what a user can act on.
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  }
}
