/**
 * Reading a file the user chose, from outside the application.
 *
 * The mirror of `FileSink`, and narrow for the same reason: **choosing** which
 * file is not here. That is an open dialog, which belongs to the window and
 * therefore to the main process, and it is a driving concern — the user
 * initiates it. By the time a use case reaches this port the file is already
 * chosen, so the port has nothing to ask and nothing to refuse on the user's
 * behalf.
 *
 * What crosses this boundary is **untrusted** (hard rule 4). A form this
 * application issued is still untrusted when it comes back, so nothing here
 * promises anything about the bytes: they are a file's contents, and every
 * judgement about them belongs to the parser and the schema.
 */
export interface FileSource {
  /**
   * Reads `target` in full.
   *
   * **Throws** on failure rather than returning a result, following `FileSink`:
   * a file that cannot be read is not a third answer to "what does this form
   * say", and a caller that treated it as a soft no would report a permissions
   * problem as a malformed document.
   *
   * Implementations must not follow the file anywhere — no directory walk, no
   * link resolution beyond what the platform does to open it, and no second read
   * of a path derived from the contents.
   */
  read(target: string): Promise<Uint8Array>;
}
