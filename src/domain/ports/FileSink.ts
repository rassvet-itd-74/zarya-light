/**
 * Writing a produced document to a location outside the application.
 *
 * Narrower than it first looks, and the narrowness is the point: **choosing**
 * where a file goes is not here. That is a save dialog, which belongs to the
 * window and therefore to the main process, and it is a driving concern — the
 * user initiates it. By the time a use case reaches this port the destination is
 * already decided, so the port has nothing to ask and nothing to refuse on the
 * user's behalf.
 *
 * Splitting it that way keeps the thing that matters testable. "Did issuance
 * record the operation before the file was handed over" is a question about
 * ordering, and a fake sink answers it; a port that also owned a dialog would
 * drag Electron into the test that asks.
 */
export interface FileSink {
  /**
   * Writes `bytes` to `target`, replacing whatever is there.
   *
   * **Throws** on failure rather than returning a result, following
   * `OperationStore` rather than the chain readers: a disk that will not accept a
   * write is not a third answer to "was the file written", and a caller that
   * treated a failure as a soft no would advance an operation to `EMITTED` with
   * no file behind it.
   *
   * Replacing rather than refusing an existing path is deliberate. The user
   * picked the path in a dialog that already asked them about overwriting; a
   * second refusal here would be the application overruling an answer it just
   * received.
   */
  write(target: string, bytes: Uint8Array): Promise<void>;
}
