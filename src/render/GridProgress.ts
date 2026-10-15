/** Progress-only frames are optional previews of a growing complete grid. Input
 * and other visible changes bypass this policy, then advance the same watermark. */
export function gridProgressDrawDue(
  installedBatches: number,
  totalBatches: number,
  drawnBatches: number,
  sinceLastDrawMs: number,
  immediate = false,
) {
  if (immediate) {
    return true;
  }
  if (installedBatches <= drawnBatches || totalBatches <= 0) {
    return false;
  }
  if (installedBatches >= totalBatches) {
    return true;
  }
  if (sinceLastDrawMs < 250) {
    return false;
  }
  return drawnBatches === 0 || installedBatches - drawnBatches >= Math.ceil(totalBatches / 8);
}
