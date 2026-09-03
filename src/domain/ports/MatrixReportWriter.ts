import type { MatrixReport } from '../matrix/matrixReport';

/**
 * Renders the coordinate reference to a printable document.
 *
 * The last step of the only PDF this application produces that is **not** an
 * AcroForm. It carries no fields, no `zarya.meta.schemaVersion` and no
 * `operationRef`, so it cannot re-enter the ingestion path — and that is
 * enforced by ingestion's own version check rather than by a new guard, which is
 * why this port's contract can be as small as it is.
 *
 * A report is disposable output: a rendering of chain state, regenerable at any
 * time from the same block, and never a record. Nothing downstream may treat one
 * as evidence of anything.
 */
export interface RenderedReport {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
}

export interface MatrixReportWriter {
  /**
   * Takes the assembled model and nothing else.
   *
   * No reader, no clock, no chain: every fact the page states — the block it was
   * read at, which coordinates exist, what could not be read — is already in the
   * model, so a renderer cannot introduce a claim the model does not support.
   * In particular the staleness stamp comes from `report.readAt`, so there is no
   * route by which a workstation clock could reach the page.
   */
  render(report: MatrixReport): Promise<RenderedReport>;
}
