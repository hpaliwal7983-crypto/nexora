import { generateCopilotResponse } from './ai-provider.js';

const MAX_MESSAGE = 1200;
const ROUTE_HINTS = [
  [/\b(home|dashboard|go home)\b/, { Trainee: 'Home', Trainer: 'Home', Admin: 'Dashboard' }],
  [/\b(my courses|courses|course catalogue|course catalog|learning)\b/, { Trainee: 'Courses', Trainer: 'My Courses', Admin: 'Courses' }],
  [/\b(progress|learning path|next best action|skill gaps|competenc(y|ies))\b/, { Trainee: 'Learning Path', Trainer: 'Performance', Admin: 'Competency Mapping' }],
  [/\b(assessment|quiz|questionnaire)s?\b/, { Trainee: 'Assessments', Trainer: 'Co-pilot', Admin: 'Analytics' }],
  [/\b(mission|lab)\b/, { Trainee: 'Mission Lab', Trainer: 'Performance', Admin: 'Analytics' }],
  [/\b(profile|settings|account)\b/, { Trainee: 'Profile & Settings', Trainer: 'Profile & Settings', Admin: 'Profile & Settings' }],
  [/\b(notification|announcement)s?\b/, { Trainee: 'Announcements', Trainer: 'Announcements', Admin: 'Announcements' }],
  [/\b(approval|approvals|pending trainer)s?\b/, { Admin: 'Approvals' }],
  [/\b(learner|learners|trainee|trainees)\b/, { Trainer: 'Trainees', Admin: 'Users' }],
  [/\b(resource|resources|library)\b/, { Trainer: 'Trainer Library', Admin: 'Trainer Library' }],
  [/\b(analytics|platform metrics|performance)\b/, { Trainer: 'Performance', Admin: 'Analytics' }],
  [/\b(trainer|trainers)\b/, { Trainee: 'Competency Mapping', Admin: 'Trainers' }],
  [/\b(passport|certificate|certificates)\b/, { Trainee: 'Capability Passport' }]
];

export function navigationIntent(message, role) {
  const text = String(message || '').toLowerCase();
  if (/\b(log ?out|sign ?out)\b/.test(text)) return { type: 'LOGOUT' };
  if (role === 'Trainee' && /\b(my courses|my learning|enrolled courses)\b/.test(text)) return { type: 'NAVIGATE', route: 'My Learning' };
  if (/\b(create|add|new)\s+(a\s+)?course\b/.test(text)) return role === 'Trainer' ? { type: 'NAVIGATE', route: 'Create Course' } : { type: 'DENY', message: 'Course creation is available to trainers.' };
  if (/\b(create|add|new)\s+(a\s+)?(questionnaire|assessment)\b/.test(text)) return role === 'Trainer' ? { type: 'NAVIGATE', route: 'Co-pilot' } : { type: 'DENY', message: 'Only trainers can create questionnaires.' };
  if (/\b(create|write|publish|post)\s+(a\s+)?announcement\b/.test(text)) return role === 'Admin' ? { type: 'NAVIGATE', route: 'Announcements' } : { type: 'DENY', message: 'Only admins can publish workspace announcements.' };
  if (/\b(approve|reject|delete|publish|submit|send)\b/.test(text)) return { type: 'DENY', message: 'I can help you open the right screen, but consequential actions must be reviewed and completed there.' };
  for (const [pattern, routes] of ROUTE_HINTS) if (pattern.test(text) && routes[role]) return { type: 'NAVIGATE', route: routes[role] };
  return null;
}

function safeCourse(course) { return { id: String(course.id || course.title || '').slice(0, 100), title: String(course.title || '').slice(0, 160), subject: String(course.subject || '').slice(0, 80), status: String(course.status || 'Published').slice(0, 40), skills: (Array.isArray(course.skills) ? course.skills : []).slice(0, 8).map(x => String(x).slice(0, 80)) }; }

export async function buildCopilotContext(pool, user, route, requestedCourse = '') {
  const shared = (await pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'")).rows[0]?.data || {};
  const allCourses = Array.isArray(shared.courses) ? shared.courses : [];
  const context = { user: { name: String(user.name).slice(0, 100), role: user.role }, screen: String(route || 'Home').slice(0, 80) };
  let authorizedCourseIds = new Set();
  if (user.role === 'Trainee') {
    const [enrollments, attempts, certificates, assignedQuestionnaires, missions] = await Promise.all([
      pool.query('SELECT course_id,status,enrolled_at FROM enrollments WHERE user_id=$1 ORDER BY enrolled_at DESC LIMIT 20', [user.id]),
      pool.query('SELECT course_id,score,correct_count,question_count,submitted_at FROM assessment_attempts WHERE user_id=$1 ORDER BY submitted_at DESC LIMIT 5', [user.id]),
      pool.query('SELECT course_id,score,issued_at FROM certificates WHERE user_id=$1 ORDER BY issued_at DESC LIMIT 10', [user.id]),
      Promise.resolve((shared.questionnaires || []).filter(q => !Array.isArray(q.assignedTraineeIds) || !q.assignedTraineeIds.length || q.assignedTraineeIds.includes(user.id)).slice(0, 10)),
      pool.query('SELECT score,submitted_at FROM mission_attempts WHERE user_id=$1 ORDER BY submitted_at DESC LIMIT 1', [user.id])
    ]);
    const modules = await pool.query('SELECT course_id,module_id FROM module_completions WHERE user_id=$1', [user.id]);
    authorizedCourseIds = new Set(enrollments.rows.map(row=>row.course_id));
    const evidence = {};
    for (const attempt of attempts.rows) {
      const course = allCourses.find(item => String(item.id || item.title) === attempt.course_id);
      const subject = String(course?.subject || course?.title || '').toLowerCase();
      const skill = subject.includes('analysis') || subject.includes('data') ? 'Data Analysis' : subject.includes('climate') ? 'Risk Awareness' : subject.includes('forecast') || subject.includes('prediction') ? 'Forecasting' : 'Radar Interpretation';
      (evidence[skill] ||= []).push(Number(attempt.score));
    }
    for (const key of Object.keys(evidence)) evidence[key] = Math.round(evidence[key].reduce((sum,value)=>sum+value,0)/evidence[key].length);
    if (missions.rows[0]) evidence['Decision Making'] = Number(missions.rows[0].score);
    context.learning = {
      enrollments: enrollments.rows.map(row => { const course = allCourses.find(item => String(item.id || item.title) === row.course_id); const count = modules.rows.filter(item => item.course_id === row.course_id).length; const total = Math.max(1, course?.skills?.length || 1); return { course: String(course?.title || row.course_id).slice(0, 160), status: count >= total ? 'completed' : row.status, progress: Math.round(Math.min(1, count / total) * 100) }; }),
      assessments: attempts.rows.map(row => ({ course: String(allCourses.find(item => String(item.id || item.title) === row.course_id)?.title || row.course_id).slice(0, 160), score: row.score, correct: row.correct_count, total: row.question_count, at: row.submitted_at })),
      certificates: certificates.rows.map(row => ({ course: String(allCourses.find(item => String(item.id || item.title) === row.course_id)?.title || row.course_id).slice(0, 160), score: row.score, issuedAt: row.issued_at })),
      competencies: evidence,
      upcomingQuestionnaires: assignedQuestionnaires.map(q => ({ title: String(q.title || '').slice(0, 140), deadline: q.deadline })).filter(q => Number.isFinite(new Date(q.deadline).getTime()) && new Date(q.deadline) > new Date()).slice(0, 5)
    };
  } else if (user.role === 'Trainer') {
    const owned = allCourses.filter(course => course.trainerId === user.id || course.ownerId === user.id);
    const ids = new Set(owned.map(course => String(course.id || course.title)));
    authorizedCourseIds = ids;
    const forms = (shared.questionnaires || []).filter(q => q.ownerId === user.id);
    const [trainees, enrollmentProgress, activeLearners] = await Promise.all([
      pool.query("SELECT DISTINCT u.id,u.name,e.course_id,e.status FROM enrollments e JOIN users u ON u.id=e.user_id WHERE e.course_id=ANY($1::text[]) AND u.status='Active' ORDER BY u.name", [[...ids]]),
      pool.query('SELECT e.user_id,e.course_id,COUNT(m.module_id)::int AS completed FROM enrollments e LEFT JOIN module_completions m ON m.user_id=e.user_id AND m.course_id=e.course_id WHERE e.course_id=ANY($1::text[]) GROUP BY e.user_id,e.course_id', [[...ids]]),
      pool.query("SELECT COUNT(DISTINCT e.user_id)::int AS count FROM enrollments e JOIN users u ON u.id=e.user_id WHERE e.course_id=ANY($1::text[]) AND u.status='Active'", [[...ids]])
    ]);
    const learnerIds = new Set(trainees.rows.map(row => row.id));
    const coursePerformance = owned.map(course => {
      const courseId=String(course.id||course.title),rows=enrollmentProgress.rows.filter(row=>row.course_id===courseId),required=Math.max(1,Array.isArray(course.skills)?course.skills.length:1);
      return { course:String(course.title||courseId).slice(0,160), learners:rows.length, averageProgress:rows.length?Math.round(rows.reduce((n,row)=>n+Math.min(100,Number(row.completed)/required*100),0)/rows.length):0, completionRate:rows.length?Math.round(rows.filter(row=>Number(row.completed)>=required).length/rows.length*100):0 };
    }).filter(item=>item.learners>0);
    const questionnaireStats = forms.slice(0,12).map(q => { const responses=(shared.questionnaireResponses||[]).filter(r=>r.questionnaireId===q.id); const assigned=Array.isArray(q.assignedTraineeIds)&&q.assignedTraineeIds.length?trainees.rows.filter(row=>q.assignedTraineeIds.includes(row.id)):trainees.rows; const missing=assigned.filter(row=>!responses.some(response=>response.userId===row.id)).map(row=>String(row.name).slice(0,100)); return { title:String(q.title||'').slice(0,140), deadline:q.deadline, responses:responses.length, pending:missing.length, pendingLearners:missing.slice(0,10) }; });
    context.training = { courses: owned.slice(0, 12).map(safeCourse), coursePerformance, activeLearnerCount:activeLearners.rows[0]?.count||0, learners: trainees.rows.slice(0,20).map(row => { const completed=enrollmentProgress.rows.find(x=>x.user_id===row.id&&x.course_id===row.course_id)?.completed||0,course=owned.find(x=>String(x.id||x.title)===row.course_id),required=Math.max(1,Array.isArray(course?.skills)?course.skills.length:1);return {name:String(row.name).slice(0,100),course:String(course?.title||row.course_id).slice(0,160),progress:Math.round(Math.min(100,completed/required*100)),status:row.status}; }), questionnaires:questionnaireStats, upcomingDeadlines:forms.map(q=>({title:String(q.title||'').slice(0,140),deadline:q.deadline})).filter(q=>Number.isFinite(new Date(q.deadline).getTime())&&new Date(q.deadline)>new Date()).slice(0,8) };
  } else {
    authorizedCourseIds = new Set(allCourses.map(course=>String(course.id||course.title)));
    const [users, enrollments, pendingProofs, pendingUsers] = await Promise.all([
      pool.query('SELECT role,status,COUNT(*)::int AS count FROM users GROUP BY role,status'),
      pool.query('SELECT COUNT(*)::int AS count,COUNT(*) FILTER (WHERE status=\'completed\')::int AS completed FROM enrollments'),
      pool.query("SELECT COUNT(*)::int AS count FROM skill_proofs WHERE status='Pending'"),
      pool.query("SELECT name,role FROM users WHERE status='Pending' ORDER BY created_at DESC LIMIT 20")
    ]);
    context.platform = { users: users.rows, pendingUsers:pendingUsers.rows.map(row=>({name:String(row.name).slice(0,100),role:row.role})), activeCourses: allCourses.filter(c => String(c.status || 'Published').toLowerCase() === 'published').length, courseCount: allCourses.length, enrollments: enrollments.rows[0], pendingSkillProofs: pendingProofs.rows[0]?.count || 0, pendingApprovals: users.rows.filter(row => row.status === 'Pending').reduce((n, row) => n + row.count, 0), courses: allCourses.slice(0, 12).map(safeCourse), competencyMapping: Array.isArray(shared.organizationCompetencies) ? shared.organizationCompetencies.slice(0, 10) : [] };
  }
  const requested=String(requestedCourse||'').slice(0,160),course=allCourses.find(item=>authorizedCourseIds.has(String(item.id||item.title))&&(String(item.id||'')===requested||String(item.title||'')===requested));
  if(course)context.currentCourse=String(course.title).slice(0,160);
  return context;
}

export function answerFromContext(message, context) {
  const q = String(message || '').toLowerCase();
  const learning = context.learning, training = context.training, platform = context.platform;
  if (learning && /\b(should|recommend|next|improve|why|explain)\b/.test(q) && /\b(courses?|learn|skills?|competenc|progress|performance)\b/.test(q)) return null;
  if (learning && /\b(courses?|enrollments?|learning)\b/.test(q) && /\b(how many|count|list|which|what|show|am i|my)\b/.test(q)) {
    const rows = learning.enrollments || [];
    return rows.length ? `You have ${rows.length} enrolled course${rows.length === 1 ? '' : 's'}: ${rows.map(x => `${x.course} (${x.progress}% complete)`).join(', ')}.` : 'You are not enrolled in a course yet. You can explore the course catalogue to get started.';
  }
  if (learning && /\b(progress|complete|completion)\b/.test(q)) { const rows=learning.enrollments||[]; if(!rows.length)return 'I do not have any course progress yet. Explore the catalogue and enroll in a course to get started.'; return `You have completed ${rows.filter(x=>x.progress>=100).length} of ${rows.length} enrolled courses. ${rows.map(x=>`${x.course}: ${x.progress}%`).join('; ')}.`; }
  if (learning && /\b(assessments?|quizzes|scores?|perform)\b/.test(q)) { const rows=learning.assessments||[]; return rows.length?`Your latest assessment was ${rows[0].course}, scored ${rows[0].score}% (${rows[0].correct} of ${rows[0].total} correct). You have ${rows.length} recent recorded attempt${rows.length===1?'':'s'}.`:'I do not have a completed assessment recorded yet.'; }
  if (learning && /\b(certificates?|credentials?)\b/.test(q)) { const rows=learning.certificates||[]; return rows.length?`You have ${rows.length} certificate${rows.length===1?'':'s'}: ${rows.map(x=>x.course).join(', ')}.`:'There are no certificates recorded on your account yet.'; }
  if (learning && /\b(deadlines?|due|questionnaires?)\b/.test(q)) { const rows=learning.upcomingQuestionnaires||[]; return rows.length?`Your upcoming questionnaire${rows.length===1?' is':'s are'}: ${rows.map(x=>`${x.title} (due ${new Date(x.deadline).toLocaleString('en', {dateStyle:'medium',timeStyle:'short'})})`).join('; ')}.`:'I could not find an upcoming questionnaire deadline for your account.'; }
  if (training && /\b(course|completion|performance)\b/.test(q) && /\b(low|lowest|completion|poor|perform)\b/.test(q)) { const rows=training.coursePerformance||[];if(!rows.length)return 'I do not have learner completion data for your courses yet.';const lowest=rows.slice().sort((a,b)=>a.averageProgress-b.averageProgress)[0];return `${lowest.course} has the lowest recorded average progress at ${lowest.averageProgress}% across ${lowest.learners} learner${lowest.learners===1?'':'s'}.`; }
  if (training && /\b(learner|trainee|active)\b/.test(q) && /\b(how many|count|number|total|active)\b/.test(q)) return `You currently have ${training.activeLearnerCount} active learner${training.activeLearnerCount===1?'':'s'} across your courses.`;
  if (training && /\b(who hasn.t submitted|haven.t submitted|pending submission|questionnaire.*pending|pending questionnaire)\b/.test(q)) { const pending=(training.questionnaires||[]).filter(x=>x.pending>0);return pending.length?pending.map(x=>`${x.title}: ${x.pending} pending${x.pendingLearners?.length?` (${x.pendingLearners.join(', ')})`:''}`).join('; '):'There are no pending questionnaire submissions in the records I can access.'; }
  if (training && /\b(questionnaires?|deadlines?|due|pending|submissions?)\b/.test(q)) { const rows=training.upcomingDeadlines||[]; return rows.length?`Upcoming questionnaires: ${rows.map(x=>`${x.title} (due ${new Date(x.deadline).toLocaleString('en',{dateStyle:'medium',timeStyle:'short'})})`).join('; ')}.`:'I could not find an upcoming questionnaire deadline for your courses.'; }
  if (platform && /\b(who|which)\b/.test(q) && /\b(approval|trainer|pending)\b/.test(q)) { const rows=platform.pendingUsers||[];return rows.length?`Pending accounts: ${rows.map(x=>`${x.name} (${x.role})`).join(', ')}.`:'There are no pending account approvals.'; }
  if (platform && /\b(approvals?|pending trainer)\b/.test(q)) return `There are ${platform.pendingApprovals} account approval${platform.pendingApprovals===1?'':'s'} pending.`;
  if (platform && /\b(users?|people|accounts?|registered)\b/.test(q)) return `The workspace has ${platform.users.reduce((n,row)=>n+row.count,0)} registered accounts.`;
  if (platform && /\b(courses?|catalogue|catalog)\b/.test(q)) return `The workspace has ${platform.activeCourses} published courses.`;
  return null;
}

export async function reasonWithAI(message, history, context) {
  const system = `You are Nexora AI, an English-only co-pilot inside Nexora. Be concise, warm, and professional. Use only the supplied authenticated user's role and compact application context. Never invent data, claim to perform actions, provide answers to an active assessment, reveal other users' private data, or output code/SQL/API instructions. If context lacks a fact, say so. Current context JSON: ${JSON.stringify(context).slice(0, 7000)}`;
  return generateCopilotResponse({ system, history, message });
}

export { MAX_MESSAGE };
