import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateProgress, scoreAssessment, scoreMissionResponse } from '../domain.js';

test('course progress is derived from completed modules and bounded', () => {
  assert.equal(calculateProgress(0, 3), 0);
  assert.equal(calculateProgress(1, 3), 33);
  assert.equal(calculateProgress(3, 3), 100);
  assert.equal(calculateProgress(5, 3), 100);
});

test('assessment scoring uses submitted choices and counts skips', () => {
  const key=[2,1,0];
  assert.deepEqual(scoreAssessment([2, 1, 0],key), { correct: 3, skipped: 0, incorrect: 0, total: 3, score: 100 });
  assert.deepEqual(scoreAssessment([2, null, 2],key), { correct: 1, skipped: 1, incorrect: 1, total: 3, score: 33 });
  assert.throws(() => scoreAssessment([99],key), /one valid choice/);
});

test('mission rubric is deterministic and tied to the response text', () => {
  const strong = scoreMissionResponse('Radar observations show precipitation. Compare the model and verify uncertainty. Inform the team with an alert, monitor risk and safety impacts.');
  assert.equal(strong.score, 100);
  assert.equal(strong.rubric.length, 4);
  assert.equal(scoreMissionResponse('I would wait and review it carefully before deciding what is needed.').score, 0);
  assert.throws(() => scoreMissionResponse('short'), /between 20/);
});
