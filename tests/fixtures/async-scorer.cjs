/**
 * R3 (G1): controllable async scorer for the real-CLI cancellation handshake.
 * It signals `started` (R3_SCORER_STARTED), then blocks until the test creates
 * `R3_SCORER_RELEASE`; only then does it resolve the OLD choice built from the
 * request captured BEFORE the cancel.
 */
const { existsSync, writeFileSync } = require('node:fs');

module.exports.createScorer = () => {
  const started = process.env.R3_SCORER_STARTED;
  const release = process.env.R3_SCORER_RELEASE;
  if (!started || !release) {
    throw new Error('R3_SCORER_STARTED and R3_SCORER_RELEASE are required');
  }
  return {
    id: 'async-fixture/1',
    mode: 'json',
    score(request) {
      writeFileSync(started, JSON.stringify({ requestId: request.requestId,
        candidates: request.candidates.map(candidate => candidate.id), at: Date.now() }));
      // The stale choice is fixed here, before any cancel can happen.
      const target = request.candidates.find(candidate =>
        candidate.id === process.env.R3_SCORER_TARGET) ?? request.candidates[0];
      return new Promise(resolve => {
        const timer = setInterval(() => {
          if (!existsSync(release)) return;
          clearInterval(timer);
          resolve({
            requestId: request.requestId,
            candidateSetHash: request.candidateSetHash,
            scorerId: 'async-fixture/1',
            scores: request.candidates.map(candidate => ({
              candidateId: candidate.id,
              logit: candidate.id === target.id ? 1 : 0,
              probability: candidate.id === target.id ? 1 : 0,
            })),
            selectedId: target.id,
            disposition: 'accept',
            reason: 'released async fixture (stale by construction)',
          });
        }, 10);
        timer.unref?.();
      });
    },
  };
};
