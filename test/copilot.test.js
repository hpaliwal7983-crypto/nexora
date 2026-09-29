import test from 'node:test';
import assert from 'node:assert/strict';
import { answerFromContext, navigationIntent } from '../copilot-service.js';

const traineeContext = { learning: {
  enrollments: [{ course: 'Weather Analysis', progress: 40, status: 'enrolled' }],
  assessments: [{ course: 'Weather Analysis', score: 80, correct: 4, total: 5 }],
  certificates: [], upcomingQuestionnaires: []
} };

test('navigation commands resolve locally without an AI provider', () => {
  assert.deepEqual(navigationIntent('Open my courses', 'Trainee'), { type: 'NAVIGATE', route: 'My Learning' });
  assert.deepEqual(navigationIntent('Create a course', 'Trainer'), { type: 'NAVIGATE', route: 'Create Course' });
  assert.deepEqual(navigationIntent('Create a course', 'Trainee'), { type: 'DENY', message: 'Course creation is available to trainers.' });
  assert.equal(navigationIntent('Approve this trainer', 'Trainee').type, 'DENY');
});

test('factual learning questions use account context directly', () => {
  assert.equal(answerFromContext('How many courses am I enrolled in?', traineeContext), 'You have 1 enrolled course: Weather Analysis (40% complete).');
  assert.equal(answerFromContext('How did I perform in my last assessment?', traineeContext), 'Your latest assessment was Weather Analysis, scored 80% (4 of 5 correct). You have 1 recent recorded attempt.');
  assert.equal(answerFromContext('Show my certificates', traineeContext), 'There are no certificates recorded on your account yet.');
});

test('admin counts and trainer pending submissions are bounded to their role context', () => {
  const admin={platform:{pendingApprovals:2,users:[{count:7}],activeCourses:3}};
  assert.equal(answerFromContext('Show pending approvals',admin),'There are 2 account approvals pending.');
  const trainer={training:{questionnaires:[{title:'Review 1',pending:3,pendingLearners:['Ari','Sam']}],upcomingDeadlines:[]}};
  assert.equal(answerFromContext("Who hasn't submitted?",trainer),'Review 1: 3 pending (Ari, Sam)');
});
