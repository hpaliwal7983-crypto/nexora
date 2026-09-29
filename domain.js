export function calculateProgress(completed, required) {
  const total = Math.max(1, Number(required) || 1);
  return Math.max(0, Math.min(100, Math.round((Math.max(0, Number(completed) || 0) / total) * 100)));
}

export function scoreAssessment(answers, correctAnswers) {
  if (!Array.isArray(correctAnswers) || !correctAnswers.length || !Array.isArray(answers) || answers.length !== correctAnswers.length || answers.some(answer => answer !== null && (!Number.isInteger(answer) || answer < 0 || answer > 3))) {
    throw new TypeError('Submit one valid choice or skip for each assessment question.');
  }
  const correct = answers.reduce((sum, answer, index) => sum + (answer === correctAnswers[index] ? 1 : 0), 0);
  const skipped = answers.filter(answer => answer === null).length;
  return { correct, skipped, incorrect: answers.length - correct - skipped, total: answers.length, score: Math.round((correct / answers.length) * 100) };
}

export function scoreMissionResponse(response) {
  const text = String(response || '').trim();
  if (text.length < 20 || text.length > 6000) throw new TypeError('Add a response between 20 and 6,000 characters.');
  const checks = [
    ['radar evidence', /radar|reflectiv|precipitation|observation/i],
    ['uncertainty review', /uncertain|compare|verify|model|evidence/i],
    ['communication', /alert|communicat|notify|inform|coordinate/i],
    ['risk management', /risk|safety|monitor|warning|impact/i]
  ];
  const rubric = checks.map(([criterion, pattern]) => ({ criterion, met: pattern.test(text) }));
  return { rubric, score: Math.round((rubric.filter(item => item.met).length / rubric.length) * 100) };
}
