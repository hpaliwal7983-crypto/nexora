import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedHistory, createSpeechController, createTranscriptCollector } from '../copilot-browser.js';

test('transcript collector combines final pieces and keeps interim text separate', () => {
  const collector = createTranscriptCollector();
  const result = collector.consume({ resultIndex: 0, results: [
    Object.assign([{ transcript: 'What should I' }], { isFinal: true }),
    Object.assign([{ transcript: 'focus on today' }], { isFinal: false })
  ] });
  assert.deepEqual(result, { final: 'What should I', interim: 'focus on today' });
});

test('speech controller reuses one recognizer and submits a final transcript exactly once', () => {
  let constructions = 0;
  class FakeRecognition { constructor() { constructions++; } start() { this.onstart(); } stop() { this.onend(); } }
  const states = [], transcripts = [];
  const controller = createSpeechController({ getRecognition: () => FakeRecognition, onState: state => states.push(state), onTranscript: text => transcripts.push(text) });
  assert.equal(controller.start('en-US'), true);
  const instance = controller.instance;
  instance.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'How am I doing?' }], { isFinal: true })] });
  instance.onend();
  assert.equal(controller.start('en-US'), true);
  assert.equal(controller.instance, instance);
  assert.equal(constructions, 1);
  assert.deepEqual(transcripts, ['How am I doing?']);
  assert.ok(states.includes('LISTENING'));
});

test('bounded history keeps only recent user and assistant messages', () => {
  const history = Array.from({ length: 24 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: String(index) }));
  assert.equal(boundedHistory(history, 10).length, 10);
  assert.equal(boundedHistory(history, 10)[0].content, '14');
});

test('recognition reports no speech on end without creating a transcript', () => {
  class FakeRecognition { start() { this.onstart(); } stop() { this.onend(); } }
  const errors = [], transcripts = [];
  const controller = createSpeechController({ getRecognition: () => FakeRecognition, onError: code => errors.push(code), onTranscript: text => transcripts.push(text) });
  controller.start(); controller.instance.onend();
  assert.deepEqual(errors, ['no-speech']);
  assert.deepEqual(transcripts, []);
});
