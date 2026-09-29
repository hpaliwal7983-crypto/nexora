import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { scoreAssessment, scoreMissionResponse } from './domain.js';
import { answerFromContext, buildCopilotContext, MAX_MESSAGE, reasonWithAI } from './copilot-service.js';

const { Pool } = pg;
const scrypt = promisify(scryptCallback);
const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 10 }) : null;
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const sessionCookie = 'nexora_session';
const publicUser = ({ id, name, email, role, status, profile, created_at }) => ({ id, name, email, role, status, profile, createdAt: created_at });
const copilotWindows = new Map();
const copilotAiWindows = new Map();
function copilotRateLimit(userId, now = Date.now()) {
  const key = String(userId), entries = (copilotWindows.get(key) || []).filter(time => now - time < 60_000);
  if (entries.length >= 24) { copilotWindows.set(key, entries); return false; }
  entries.push(now); copilotWindows.set(key, entries);
  if (copilotWindows.size > 5000) for (const [id, times] of copilotWindows) if (!times.some(time => now - time < 60_000)) copilotWindows.delete(id);
  return true;
}
function copilotAiRateLimit(userId, now = Date.now()) {
  const key=String(userId),entries=(copilotAiWindows.get(key)||[]).filter(time=>now-time<5*60_000);
  if(entries.length>=8){copilotAiWindows.set(key,entries);return false;}
  entries.push(now);copilotAiWindows.set(key,entries);
  if(copilotAiWindows.size>5000)for(const [id,times] of copilotAiWindows)if(!times.some(time=>now-time<5*60_000))copilotAiWindows.delete(id);
  return true;
}
function assessmentKeyFor(course){
  const subject=String(course?.subject||course?.title||'').toLowerCase();
  if(subject.includes('analysis')||subject.includes('data'))return [1,1,0];
  if(subject.includes('climate'))return [1,1,0];
  if(subject.includes('forecast')||subject.includes('prediction'))return [1,1,1];
  return [2,1,0];
}
const systemCourses = [
  { id:'system-radar-basics', title:'Radar Meteorology Basics', subject:'Radar', level:'Beginner', modules:3, teacher:'Nexora Learning Team', rating:'New', duration:'6h 30m', image:'radar', description:'Learn radar fundamentals and interpret real-world data for better forecasting decisions.', skills:['Understand radar principles','Interpret reflectivity patterns','Apply in real-world scenarios'], publisher:'Nexora', status:'Published' },
  { id:'system-weather-analysis', title:'Data Analysis for Weather', subject:'Analysis', level:'Intermediate', modules:3, teacher:'Nexora Learning Team', rating:'New', duration:'4h 20m', image:'data', description:'Turn atmospheric observations into clear, evidence-based insights.', skills:['Read weather datasets','Identify meaningful patterns','Communicate findings'], publisher:'Nexora', status:'Published' },
  { id:'system-nwp', title:'Numerical Weather Prediction', subject:'Forecasting', level:'Advanced', modules:3, teacher:'Nexora Learning Team', rating:'New', duration:'5h 10m', image:'forecast', description:'Understand model outputs, uncertainty, and forecast verification.', skills:['Interpret model guidance','Compare forecast ensembles','Assess uncertainty'], publisher:'Nexora', status:'Published' },
  { id:'system-climate', title:'Climate Science Fundamentals', subject:'Climate', level:'Intermediate', modules:3, teacher:'Nexora Learning Team', rating:'New', duration:'3h 45m', image:'climate', description:'Build a strong foundation in climate systems and long-term observations.', skills:['Explain climate drivers','Read climate indicators','Evaluate trends'], publisher:'Nexora', status:'Published' }
];

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}
function fail(res, status, error) { send(res, status, { error }); }
async function readJson(req, maxBytes = 1_000_000) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}
function cookieValue(req, key) {
  const entry = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${key}=`));
  return entry ? decodeURIComponent(entry.slice(key.length + 1)) : '';
}
function hashToken(token) { return createHash('sha256').update(token).digest('hex'); }
function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${Buffer.from(derived).toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, 'hex'), 64));
  return safeEqual(actual, Buffer.from(hashHex, 'hex'));
}
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      email text NOT NULL UNIQUE,
      employee_id text UNIQUE,
      password_hash text NOT NULL,
      role text NOT NULL CHECK (role IN ('Admin','Trainer','Trainee')),
      status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Active','Rejected','Suspended')),
      profile jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS workspace_state (
      workspace_id text PRIMARY KEY,
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS user_state (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS enrollments (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id text NOT NULL,
      enrolled_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled','completed')),
      PRIMARY KEY(user_id, course_id)
    );
    CREATE TABLE IF NOT EXISTS module_completions (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id text NOT NULL,
      module_id text NOT NULL,
      completed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(user_id, course_id, module_id)
    );
    CREATE TABLE IF NOT EXISTS assessment_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id text NOT NULL,
      answers jsonb NOT NULL,
      correct_count integer NOT NULL,
      question_count integer NOT NULL,
      score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
      submitted_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS assessment_attempts_user_idx ON assessment_attempts(user_id, submitted_at DESC);
    CREATE TABLE IF NOT EXISTS certificates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id text NOT NULL,
      assessment_id uuid NOT NULL REFERENCES assessment_attempts(id) ON DELETE CASCADE,
      score integer NOT NULL CHECK (score BETWEEN 70 AND 100),
      issued_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(user_id,course_id)
    );
    CREATE TABLE IF NOT EXISTS mission_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mission_id text NOT NULL, response text NOT NULL, score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
      rubric jsonb NOT NULL, submitted_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS mission_attempts_user_idx ON mission_attempts(user_id, submitted_at DESC);
    CREATE TABLE IF NOT EXISTS skill_proofs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id text NOT NULL, skill text NOT NULL, title text NOT NULL, details text NOT NULL,
      status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Validated','Rejected')),
      reviewer_id uuid REFERENCES users(id) ON DELETE SET NULL, review_note text NOT NULL DEFAULT '',
      submitted_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS skill_proofs_status_idx ON skill_proofs(status, submitted_at);
    CREATE TABLE IF NOT EXISTS course_resources (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), course_id text NOT NULL,
      trainer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title text NOT NULL, description text NOT NULL DEFAULT '', filename text NOT NULL,
      mime_type text NOT NULL, content bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS course_resources_course_idx ON course_resources(course_id, created_at);
    INSERT INTO workspace_state(workspace_id, data) VALUES ('default', '{}') ON CONFLICT DO NOTHING;
  `);
  await pool.query(`UPDATE workspace_state SET data=jsonb_set(data,'{courses}',$1::jsonb,true),updated_at=now()
    WHERE workspace_id='default' AND (NOT (data ? 'courses') OR jsonb_array_length(COALESCE(data->'courses','[]'::jsonb))=0)`, [JSON.stringify(systemCourses)]);
  await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword && adminPassword.length >= 12) {
    const exists = await pool.query('SELECT id FROM users WHERE lower(email) = $1', [adminEmail]);
    if (!exists.rowCount) {
      const hash = await hashPassword(adminPassword);
      await pool.query("INSERT INTO users(name,email,password_hash,role,status,profile) VALUES ($1,$2,$3,'Admin','Active',$4)", [process.env.ADMIN_NAME || 'Nexora Administrator', adminEmail, hash, { department: 'Administration', designation: 'Administrator' }]);
      console.log('Initial Nexora administrator created from configured environment values.');
    }
  }
  const oldDemoEmail=process.env.DEMO_EMAIL?.trim().toLowerCase();
  if(oldDemoEmail){const oldDemo=await pool.query("SELECT id FROM users WHERE lower(email)=$1 AND lower(name)=lower($2) AND role='Trainee'",[oldDemoEmail,process.env.DEMO_NAME||'Harsh']);if(oldDemo.rowCount){const oldDemoId=oldDemo.rows[0].id,client=await pool.connect();try{await client.query('BEGIN');const ws=(await client.query("SELECT data FROM workspace_state WHERE workspace_id='default' FOR UPDATE")).rows[0]?.data||{};for(const key of ['feedbacks','questionnaireResponses'])ws[key]=(ws[key]||[]).filter(item=>item.userId!==oldDemoId);await client.query("UPDATE workspace_state SET data=$1,updated_at=now() WHERE workspace_id='default'",[JSON.stringify(ws)]);await client.query('DELETE FROM users WHERE id=$1',[oldDemoId]);await client.query('COMMIT');console.log('Removed the retired Harsh demo account and its personal learning records.');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}}

}
async function authenticate(req) {
  const raw = cookieValue(req, sessionCookie);
  if (!raw || !pool) return null;
  const result = await pool.query(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`, [hashToken(raw)]);
  return result.rows[0] || null;
}
function requireActive(user, res) {
  if (!user) { fail(res, 401, 'Sign in to continue.'); return false; }
  if (user.status !== 'Active') { fail(res, 403, 'Your account is awaiting administrator approval.'); return false; }
  return true;
}
function requireRole(user, roles, res) {
  if (!requireActive(user, res)) return false;
  if (!roles.includes(user.role)) { fail(res, 403, 'Your account does not have permission for this action.'); return false; }
  return true;
}
async function createSession(user, res) {
  const token = randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval \'14 days\')', [hashToken(token), user.id]);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': `${sessionCookie}=${encodeURIComponent(token)}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=1209600` });
}
const personalKeys = new Set(['missionResponse','proofSkill','reminders','questionnaireSubmissions','assessmentAnswers','selectedCourse','courseSearch','userRoleFilter','onboardingComplete']);
const adminSharedKeys = new Set(['courses','announcements','feedbacks','questionnaires','competencyMapping','organizationCompetencies']);
const trainerSharedKeys = new Set(['courses','questionnaires']);
async function stateGet(user, res) {
  const [shared, personal] = await Promise.all([
    pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'"),
    pool.query('SELECT data FROM user_state WHERE user_id=$1', [user.id])
  ]);
  const userData = personal.rows[0]?.data || {};
  const workspace=shared.rows[0]?.data||{};
  if(Array.isArray(workspace.courses))workspace.courses=workspace.courses.map(course=>!course.trainerId&&!course.ownerId&&/^Dr\./.test(course.teacher||'')?{...course,teacher:'Nexora Learning Team',rating:'New'}:course);
  if(user.role==='Trainee'){
    if(Array.isArray(workspace.questionnaires))workspace.questionnaires=workspace.questionnaires.filter(q=>!Array.isArray(q.assignedTraineeIds)||!q.assignedTraineeIds.length||q.assignedTraineeIds.includes(user.id)).map(({correct,...q})=>q);
    delete workspace.questionnaireResponses;
  } else if(user.role==='Trainer') {
    const owned=new Set((workspace.questionnaires||[]).filter(q=>q.ownerId===user.id).map(q=>q.id));
    workspace.questionnaireResponses=(workspace.questionnaireResponses||[]).filter(response=>owned.has(response.questionnaireId));
  }
  const [enrollments, modules, attempts, missions, proofRows, certificateRows] = await Promise.all([
    pool.query('SELECT course_id,enrolled_at,status FROM enrollments WHERE user_id=$1 ORDER BY enrolled_at DESC', [user.id]),
    pool.query('SELECT course_id,module_id,completed_at FROM module_completions WHERE user_id=$1 ORDER BY completed_at', [user.id]),
    pool.query('SELECT course_id,answers,correct_count,question_count,score,submitted_at FROM assessment_attempts WHERE user_id=$1 ORDER BY submitted_at DESC', [user.id]),
    pool.query('SELECT mission_id,response,score,rubric,submitted_at FROM mission_attempts WHERE user_id=$1 ORDER BY submitted_at DESC LIMIT 1', [user.id]),
    pool.query('SELECT p.id,p.user_id,p.course_id,p.skill,p.title,p.details,p.status,p.review_note,p.submitted_at,p.reviewed_at,u.name AS user_name FROM skill_proofs p JOIN users u ON u.id=p.user_id WHERE ($1::text=\'Admin\' OR p.user_id=$2 OR $1::text=\'Trainer\') ORDER BY p.submitted_at DESC', [user.role,user.id]),
    pool.query('SELECT id,course_id,score,issued_at FROM certificates WHERE user_id=$1 ORDER BY issued_at DESC',[user.id])
  ]);
  const enrollmentRows=enrollments.rows.map(row=>{const course=(workspace.courses||[]).find(item=>String(item.id||item.title)===row.course_id);const required=Math.max(1,Array.isArray(course?.skills)?course.skills.length:1);const count=modules.rows.filter(item=>item.course_id===row.course_id).length;return {courseId:row.course_id,title:course?.title||row.course_id,enrolledAt:row.enrolled_at,status:count>=required?'completed':row.status,completedModules:count,requiredModules:required,progress:Math.round(count/required*100)};});
  const resourceRows=(await pool.query('SELECT id,course_id,trainer_id,title,description,filename,mime_type,created_at FROM course_resources ORDER BY created_at DESC')).rows;
  const visibleCourseIds=user.role==='Trainee'?new Set(enrollmentRows.map(item=>item.courseId)):user.role==='Trainer'?new Set((workspace.courses||[]).filter(course=>course.trainerId===user.id||course.ownerId===user.id).map(course=>String(course.id||course.title))):null;
  workspace.resources=resourceRows.filter(item=>!visibleCourseIds||visibleCourseIds.has(item.course_id)).map(item=>({id:item.id,courseId:item.course_id,trainerId:item.trainer_id,title:item.title,description:item.description,filename:item.filename,type:item.mime_type,createdAt:item.created_at,url:`/api/resources/${item.id}/content`}));
  if(user.role==='Trainee')workspace.feedbacks=(workspace.feedbacks||[]).filter(item=>item.userId===user.id);
  else if(user.role==='Trainer'){const ownedTitles=new Set((workspace.courses||[]).filter(course=>course.trainerId===user.id||course.ownerId===user.id).map(course=>course.title));workspace.feedbacks=(workspace.feedbacks||[]).filter(item=>ownedTitles.has(item.course));}
  const latest=attempts.rows[0];
  const realEvents=[...modules.rows.map(item=>({date:item.completed_at,label:'Module completed',detail:item.course_id,change:''})),...attempts.rows.map(item=>({date:item.submitted_at,label:'Assessment completed',detail:item.course_id,change:`${item.score}%` })),...missions.rows.map(item=>({date:item.submitted_at,label:'Mission submitted',detail:item.mission_id,change:`${item.score}%`}))].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,20);
  const evidenceScores={};
  for(const item of attempts.rows){const course=(workspace.courses||[]).find(value=>String(value.id||value.title)===item.course_id),subject=String(course?.subject||course?.title||'').toLowerCase(),skill=subject.includes('analysis')||subject.includes('data')?'Data Analysis':subject.includes('climate')?'Risk Awareness':subject.includes('forecast')||subject.includes('prediction')?'Forecasting':'Radar Interpretation';(evidenceScores[skill]??=[]).push(item.score);}
  const evidence=Object.fromEntries(Object.entries(evidenceScores).map(([key,scores])=>[key,Math.round(scores.reduce((sum,value)=>sum+value,0)/scores.length)]));
  const latestMission=missions.rows[0];
  const userProofs=proofRows.rows.filter(item=>item.user_id===user.id);
  for(const proof of userProofs.filter(item=>item.status==='Validated'))evidence[proof.skill]=Math.max(Number(evidence[proof.skill]||0),100);
  if(latestMission)evidence['Decision Making']=latestMission.score;
  const visibleProofs=user.role==='Admin'?proofRows.rows:user.role==='Trainer'?proofRows.rows.filter(item=>(workspace.courses||[]).some(course=>String(course.id||course.title)===item.course_id&&(course.trainerId===user.id||course.ownerId===user.id))):userProofs;
  const certificates=certificateRows.rows.map(item=>({id:item.id,courseId:item.course_id,title:(workspace.courses||[]).find(course=>String(course.id||course.title)===item.course_id)?.title||item.course_id,score:item.score,issuedAt:item.issued_at}));
  const safeUserData={...userData};
  for(const key of ['competencies','completedModules','missionComplete','assessmentDone','assessmentCorrect','assessmentSkipped','assessmentIncorrect','assessmentScore','missionScore','courseProgress','enrolled','events','proofSubmitted'])delete safeUserData[key];
  send(res, 200, { shared: workspace, personal: { ...safeUserData, enrolled:enrollmentRows.map(item=>item.title), enrollments:enrollmentRows, courseProgress:Object.fromEntries(enrollmentRows.flatMap(item=>[[item.title,item.progress],[item.courseId,item.progress]])), completedModules:modules.rowCount, assessmentDone:Boolean(latest), assessmentScore:latest?.score??null, assessmentCorrect:latest?.correct_count??0, assessmentIncorrect:latest?latest.question_count-latest.correct_count:0, assessmentSkipped:latest?Array.from(latest.answers||[]).filter(value=>value===null).length:0, assessmentAttempts:attempts.rows, certificates, missionComplete:Boolean(latestMission),missionScore:latestMission?.score??null,missionResponse:latestMission?.response||'',proofSubmitted:userProofs.length>0,proofs:userProofs,skillProofs:visibleProofs,competencies:evidence,events:realEvents,profile:user.profile }, user: publicUser(user) });
}
async function statePut(user, req, res) {
  const body = await readJson(req);
  const incomingShared = body.shared && typeof body.shared === 'object' ? body.shared : {};
  const incomingPersonal = body.personal && typeof body.personal === 'object' ? body.personal : {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (user.role === 'Admin' || user.role === 'Trainer') {
      const existing = (await client.query("SELECT data FROM workspace_state WHERE workspace_id='default' FOR UPDATE")).rows[0]?.data || {};
      const allowed = user.role === 'Admin' ? adminSharedKeys : trainerSharedKeys;
      const updates = Object.fromEntries(Object.entries(incomingShared).filter(([key]) => allowed.has(key)));
      if (user.role === 'Trainer') {
        for (const key of ['courses','questionnaires','resources']) if (Array.isArray(updates[key])) {
          const ownedField = key === 'courses' ? 'trainerId' : 'ownerId';
          const owned = updates[key].filter(item => item?.[ownedField] === user.id);
          updates[key] = [...(existing[key] || []).filter(item => item?.[ownedField] !== user.id), ...owned];
        }
      }
      await client.query("UPDATE workspace_state SET data=$1, updated_at=now() WHERE workspace_id='default'", [JSON.stringify({ ...existing, ...updates })]);
    }
    const existingPersonal = (await client.query('SELECT data FROM user_state WHERE user_id=$1 FOR UPDATE', [user.id])).rows[0]?.data || {};
    const updatesPersonal = Object.fromEntries(Object.entries(incomingPersonal).filter(([key]) => personalKeys.has(key) && key !== 'profile'));
    await client.query(`INSERT INTO user_state(user_id,data) VALUES ($1,$2)
      ON CONFLICT(user_id) DO UPDATE SET data=user_state.data || EXCLUDED.data, updated_at=now()`, [user.id, JSON.stringify({ ...existingPersonal, ...updatesPersonal })]);
    await client.query('COMMIT');
    send(res, 200, { saved: true });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function handleApi(req, res, url) {
  if (!pool) return fail(res, 503, 'Backend is not configured. Set DATABASE_URL before starting Nexora.');
  const path = url.pathname;
  if (req.method !== 'GET' && req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return fail(res,403,'Cross-site request rejected.'); }
    catch { return fail(res,403,'Invalid request origin.'); }
  }
  if (req.method === 'GET' && path === '/api/health') {
    try { await pool.query('SELECT 1'); return send(res, 200, { status: 'ok', database: 'connected' }); }
    catch { return fail(res, 503, 'Database unavailable.'); }
  }
  if(req.method==='DELETE'&&path==='/api/workspace-state'){
    const user=await authenticate(req);if(!requireActive(user,res))return;
    const client=await pool.connect();
    try{await client.query('BEGIN');await client.query('DELETE FROM certificates WHERE user_id=$1',[user.id]);await client.query('DELETE FROM assessment_attempts WHERE user_id=$1',[user.id]);await client.query('DELETE FROM mission_attempts WHERE user_id=$1',[user.id]);await client.query('DELETE FROM skill_proofs WHERE user_id=$1',[user.id]);await client.query('DELETE FROM module_completions WHERE user_id=$1',[user.id]);await client.query('DELETE FROM enrollments WHERE user_id=$1',[user.id]);await client.query('DELETE FROM user_state WHERE user_id=$1',[user.id]);const workspace=(await client.query("SELECT data FROM workspace_state WHERE workspace_id='default' FOR UPDATE")).rows[0]?.data||{};workspace.feedbacks=(workspace.feedbacks||[]).filter(item=>item.userId!==user.id);workspace.questionnaireResponses=(workspace.questionnaireResponses||[]).filter(item=>item.userId!==user.id);await client.query("UPDATE workspace_state SET data=$1,updated_at=now() WHERE workspace_id='default'",[JSON.stringify(workspace)]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    return send(res,200,{cleared:true});
  }
  if (req.method === 'POST' && path === '/api/auth/register') {
    const body = await readJson(req);
    const name = String(body.name || '').trim(); const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || ''); const role = String(body.role || 'Trainee');
    const employeeId=String(body.employeeId||'').trim();
    if (name.length < 2 || name.length > 100 || !/^\S+@\S+\.\S+$/.test(email) || employeeId.length < 2 || employeeId.length > 40 || password.length < 12 || !['Admin','Trainer','Trainee'].includes(role)) return fail(res, 400, 'Enter a valid name, email and Employee ID, choose a role, and use a password with at least 12 characters.');
    const profile = { employeeId };
    const duplicate=await pool.query('SELECT 1 FROM users WHERE lower(email)=$1 OR lower(employee_id)=$2 LIMIT 1',[email,employeeId.toLowerCase()]);
    if(duplicate.rowCount)return fail(res,409,'That email or Employee ID is already registered.');
    const hash = await hashPassword(password);
    try {
      const status=role==='Trainee'?'Active':'Pending';
      const result = await pool.query("INSERT INTO users(name,email,employee_id,password_hash,role,status,profile) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *", [name,email,profile.employeeId,hash,role,status,profile]);
      const message=status==='Pending'?`${role} account created. An administrator must approve it before you can sign in.`:'Account created. You can sign in now with your email or Employee ID.';
      return send(res, 201, { user: publicUser(result.rows[0]), message });
    } catch (error) { if (error.code === '23505') return fail(res, 409, 'That email or employee ID is already registered.'); throw error; }
  }
  if (req.method === 'POST' && path === '/api/auth/login') {
    const body = await readJson(req); const identity = String(body.identity || '').trim().toLowerCase();
    const result = await pool.query('SELECT * FROM users WHERE lower(email)=$1 OR lower(employee_id)=$1 LIMIT 1', [identity]);
    const user = result.rows[0];
    if (!user || !(await verifyPassword(String(body.password || ''), user.password_hash))) return fail(res, 401, 'Email or password is incorrect.');
    if (user.status !== 'Active') return fail(res, 403, user.status === 'Pending' ? 'Your account is awaiting administrator approval.' : 'This account cannot sign in. Contact your administrator.');
    return createSession(user,res);
  }
  if (req.method === 'POST' && path === '/api/auth/logout') {
    const raw = cookieValue(req,sessionCookie); if (raw) await pool.query('DELETE FROM sessions WHERE token_hash=$1',[hashToken(raw)]);
    return send(res,204,{}, {'Set-Cookie':`${sessionCookie}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`});
  }
  const user = await authenticate(req);
  if (req.method === 'POST' && path === '/api/ai/copilot') {
    if (!requireActive(user,res)) return;
    if (!copilotRateLimit(user.id)) return fail(res,429,'You have sent too many Nexora AI requests. Wait a moment and try again.');
    const requestId = randomBytes(8).toString('hex'), startedAt = Date.now();
    if(Number(req.headers['content-length']||0)>16_000)return fail(res,413,'Nexora AI requests must be 16 KB or smaller.');
    const body = await readJson(req,16_000), message = String(body.message || '').trim();
    if (!message || message.length > MAX_MESSAGE) return fail(res,400,`Enter a message of ${MAX_MESSAGE} characters or fewer.`);
    const history = Array.isArray(body.history) ? body.history.slice(-6).filter(item => ['user','assistant'].includes(item?.role) && typeof item?.content === 'string').map(item => ({ role:item.role, content:item.content.slice(0,500) })) : [];
    const context = await buildCopilotContext(pool,user,body.route,body.currentCourse);
    if (context.screen.toLowerCase().includes('assessment') && /\b(answer key|correct answer|which answer|give me the answers|solve this assessment)\b/i.test(message)) return send(res,200,{ message:'I can explain the concepts and assessment instructions, but I can’t provide answers to an active assessment. You can return to your learning material for a review.', source:'safety', requestId });
    const factualAnswer = answerFromContext(message,context);
    if (factualAnswer) return send(res,200,{ message:factualAnswer, source:'application-data', requestId });
    if (!copilotAiRateLimit(user.id)) return fail(res,429,'Nexora AI reasoning is temporarily rate limited. You can still use navigation and account-data answers.');
    try {
      const result = await reasonWithAI(message,history,context);
      console.info(JSON.stringify({ event:'copilot.request', requestId, provider:result.provider, model:result.model, role:user.role, latencyMs:result.latencyMs, status:200 }));
      return send(res,200,{ message:result.text, source:'ai', requestId });
    } catch (error) {
      const transient = error.code === 'timeout' || error.code === 'rate_limit' || error.code === 'provider';
      const status = error.code === 'configuration' ? 503 : error.code === 'rate_limit' ? 429 : 503;
      const userMessage = error.code === 'configuration' ? 'AI reasoning is not configured yet. You can still use Nexora AI for navigation and account data.' : error.code === 'rate_limit' ? 'AI reasoning is temporarily rate limited. You can still use Nexora AI for navigation and account data.' : 'AI reasoning is temporarily unavailable. You can still use Nexora normally.';
      console.warn(JSON.stringify({ event:'copilot.request', requestId, provider:String(process.env.AI_PROVIDER||'openrouter'), model:String(process.env.AI_MODEL||''), role:user.role, latencyMs:Date.now()-startedAt, status, category:error.code||'provider_error', retryable:transient }));
      return send(res,status,{ error:userMessage, code:error.code||'provider_error', requestId });
    }
  }
  if (req.method === 'GET' && path === '/api/auth/me') return user ? send(res,200,{user:publicUser(user)}) : fail(res,401,'Not signed in.');
  if (req.method === 'PATCH' && path === '/api/profile') {
    if (!requireActive(user,res)) return;
    const body = await readJson(req); const name=String(body.name||'').trim();
    if (name.length < 2 || name.length > 100) return fail(res,400,'Enter a name between 2 and 100 characters.');
    const employeeId=String(body.employeeId??user.employee_id??user.profile?.employeeId??'').trim();
    if(employeeId.length<2||employeeId.length>40)return fail(res,400,'Employee ID must be between 2 and 40 characters.');
    const profile={ ...user.profile, employeeId, department:String(body.department??user.profile?.department??'').trim(), designation:String(body.designation??user.profile?.designation??'').trim(), experience:String(body.experience??user.profile?.experience??'').trim(), qualification:String(body.qualification??user.profile?.qualification??'').trim(), education:String(body.education??user.profile?.education??'').trim(), currentRole:String(body.currentRole??user.profile?.currentRole??'').trim(), organization:String(body.organization??user.profile?.organization??'').trim(), specialization:String(body.specialization??user.profile?.specialization??'').trim(), trainingExperience:String(body.trainingExperience??user.profile?.trainingExperience??'').trim(), learningGoals:String(body.learningGoals??user.profile?.learningGoals??'').trim(), skills:Array.isArray(body.skills)?body.skills.map(x=>String(x).trim()).filter(Boolean).slice(0,30):user.profile?.skills||[], interests:Array.isArray(body.interests)?body.interests.map(x=>String(x).trim()).filter(Boolean).slice(0,30):user.profile?.interests||[], competencies:Array.isArray(body.competencies)?body.competencies.map(x=>String(x).trim()).filter(Boolean).slice(0,30):user.profile?.competencies||[] };
    try{const result=await pool.query('UPDATE users SET name=$1,employee_id=$2,profile=$3,updated_at=now() WHERE id=$4 RETURNING *',[name,employeeId,profile,user.id]);return send(res,200,{user:publicUser(result.rows[0])});}catch(error){if(error.code==='23505')return fail(res,409,'That Employee ID is already registered.');throw error;}
  }
  if (req.method === 'POST' && path === '/api/feedback') {
    if (!requireRole(user,['Trainee'],res)) return;
    const body=await readJson(req);const overall=Number(body.overall),content=Number(body.content),trainer=Number(body.trainer),experience=Number(body.experience);
    if (!body.course || [overall,content,trainer,experience].some(x=>!Number.isFinite(x)||x<1||x>5)) return fail(res,400,'Choose a course and submit ratings from 1 to 5.');
    const catalog=(await pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'")).rows[0]?.data?.courses||[];
    const feedbackCourse=catalog.find(item=>item.title===String(body.course)||String(item.id)===String(body.course));
    if(!feedbackCourse)return fail(res,404,'Course not found.');
    const completed=await pool.query("SELECT 1 FROM enrollments WHERE user_id=$1 AND course_id=$2 AND status='completed'",[user.id,String(feedbackCourse.id||feedbackCourse.title)]);
    if(!completed.rowCount)return fail(res,403,'Course feedback is available after you complete the course.');
    const feedback={id:randomBytes(12).toString('hex'),course:String(feedbackCourse.title).slice(0,160),user:user.name,userId:user.id,overall,content,trainer,experience,comments:String(body.comments||'').slice(0,2000),createdAt:new Date().toISOString()};
    await pool.query("UPDATE workspace_state SET data=jsonb_set(data,'{feedbacks}',COALESCE(data->'feedbacks','[]'::jsonb)||$1::jsonb,true),updated_at=now() WHERE workspace_id='default'",[JSON.stringify([feedback])]);
    return send(res,201,{feedback});
  }
  const questionnaireResponse=path.match(/^\/api\/questionnaires\/([^/]+)\/responses$/);
  if(questionnaireResponse&&req.method==='POST'){
    if(!requireRole(user,['Trainee'],res))return;
    const body=await readJson(req),answer=Number(body.answer);
    const client=await pool.connect();
    try{await client.query('BEGIN');const row=(await client.query("SELECT data FROM workspace_state WHERE workspace_id='default' FOR UPDATE")).rows[0],data=row?.data||{},q=(data.questionnaires||[]).find(item=>item.id===questionnaireResponse[1]);if(!q){await client.query('ROLLBACK');return fail(res,404,'Questionnaire not found.');}if(Array.isArray(q.assignedTraineeIds)&&q.assignedTraineeIds.length&&!q.assignedTraineeIds.includes(user.id)){await client.query('ROLLBACK');return fail(res,403,'This questionnaire was not assigned to your account.');}if(!Number.isFinite(new Date(q.deadline).getTime())||Date.now()>new Date(q.deadline).getTime()){await client.query('ROLLBACK');return fail(res,409,'The deadline has passed.');}if(!Number.isInteger(answer)||answer<0||answer>=q.options.length){await client.query('ROLLBACK');return fail(res,400,'Choose an answer before submitting.');}const responses=data.questionnaireResponses||[];if(responses.some(r=>r.questionnaireId===q.id&&r.userId===user.id)){await client.query('ROLLBACK');return fail(res,409,'You have already submitted this questionnaire.');}const response={id:randomBytes(12).toString('hex'),questionnaireId:q.id,title:q.title,userId:user.id,userName:user.name,answer,score:answer===Number(q.correct)?100:0,submittedAt:new Date().toISOString()};data.questionnaireResponses=[...responses,response];await client.query("UPDATE workspace_state SET data=$1,updated_at=now() WHERE workspace_id='default'",[JSON.stringify(data)]);await client.query('COMMIT');return send(res,201,{response:{score:response.score,submittedAt:response.submittedAt}});}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  if(questionnaireResponse&&req.method==='GET'){
    if(!requireRole(user,['Trainer','Admin'],res))return;
    const result=await pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'");const data=result.rows[0]?.data||{},questionnaire=(data.questionnaires||[]).find(item=>item.id===questionnaireResponse[1]);if(!questionnaire)return fail(res,404,'Questionnaire not found.');if(user.role==='Trainer'&&questionnaire.ownerId!==user.id)return fail(res,403,'You can view responses to your own questionnaires only.');return send(res,200,{responses:(data.questionnaireResponses||[]).filter(r=>r.questionnaireId===questionnaire.id)});
  }
  if(req.method==='GET'&&path==='/api/enrollments'){
    if(!requireRole(user,['Trainee'],res))return;
    const data=(await pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'")).rows[0]?.data||{};
    const enrollments=(await pool.query('SELECT course_id,enrolled_at,status FROM enrollments WHERE user_id=$1 ORDER BY enrolled_at DESC',[user.id])).rows;
    const modules=(await pool.query('SELECT course_id,module_id FROM module_completions WHERE user_id=$1',[user.id])).rows;
    const items=enrollments.map(row=>{const course=(data.courses||[]).find(item=>String(item.id||item.title)===row.course_id);const required=Math.max(1,Array.isArray(course?.skills)?course.skills.length:1),count=modules.filter(item=>item.course_id===row.course_id).length;return {courseId:row.course_id,title:course?.title||row.course_id,status:count>=required?'completed':row.status,progress:Math.round(count/required*100),completedModules:count,requiredModules:required,enrolledAt:row.enrolled_at};});
    return send(res,200,{enrollments:items});
  }
  if(req.method==='POST'&&path==='/api/enrollments'){
    if(!requireRole(user,['Trainee'],res))return;
    const body=await readJson(req),courseId=String(body.courseId||'').trim();
    const data=(await pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'")).rows[0]?.data||{};
    const course=(data.courses||[]).find(item=>String(item.id||item.title)===courseId||item.title===courseId);
    if(!course||course.status==='Draft')return fail(res,404,'This course is not available for enrollment.');
    const key=String(course.id||course.title);
    try{await pool.query('INSERT INTO enrollments(user_id,course_id) VALUES($1,$2)',[user.id,key]);}
    catch(error){if(error.code==='23505')return fail(res,409,'You are already enrolled in this course.');throw error;}
    return send(res,201,{enrollment:{courseId:key,title:course.title,status:'enrolled',progress:0,completedModules:0,requiredModules:Math.max(1,course.skills?.length||1)}});
  }
  if(req.method==='POST'&&path==='/api/enrollments/modules/complete'){
    if(!requireRole(user,['Trainee'],res))return;
    const body=await readJson(req),requested=String(body.courseId||''),moduleIndex=Number(body.moduleIndex);
    if(!Number.isInteger(moduleIndex)||moduleIndex<0)return fail(res,400,'Choose a valid course module.');
    const workspace=(await pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'")).rows[0]?.data||{};
    const course=(workspace.courses||[]).find(item=>String(item.id||item.title)===requested||item.title===requested);
    if(!course)return fail(res,404,'Course not found.');
    const key=String(course.id||course.title),skills=Array.isArray(course.skills)?course.skills:[];
    if(moduleIndex>=skills.length)return fail(res,400,'That module is not part of this course.');
    const enrolled=await pool.query('SELECT 1 FROM enrollments WHERE user_id=$1 AND course_id=$2',[user.id,key]);
    if(!enrolled.rowCount)return fail(res,403,'Enroll in this course before completing a module.');
    const prior=await pool.query('SELECT COUNT(*)::int AS completed FROM module_completions WHERE user_id=$1 AND course_id=$2',[user.id,key]);
    const already=await pool.query('SELECT 1 FROM module_completions WHERE user_id=$1 AND course_id=$2 AND module_id=$3',[user.id,key,`module-${moduleIndex+1}`]);
    if(!already.rowCount&&moduleIndex!==prior.rows[0].completed)return fail(res,409,'Complete course modules in order.');
    await pool.query('INSERT INTO module_completions(user_id,course_id,module_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[user.id,key,`module-${moduleIndex+1}`]);
    const counts=await pool.query('SELECT COUNT(*)::int AS completed FROM module_completions WHERE user_id=$1 AND course_id=$2',[user.id,key]);
    const required=Math.max(1,skills.length),completed=counts.rows[0].completed,progress=Math.min(100,Math.round(completed/required*100));
    if(progress===100)await pool.query("UPDATE enrollments SET status='completed' WHERE user_id=$1 AND course_id=$2",[user.id,key]);
    return send(res,200,{courseId:key,moduleId:`module-${moduleIndex+1}`,completedModules:completed,requiredModules:required,progress,status:progress===100?'completed':'enrolled'});
  }
  if(req.method==='POST'&&path==='/api/assessments/attempt'){
    if(!requireRole(user,['Trainee'],res))return;
    const body=await readJson(req),requested=String(body.courseId||''),answers=body.answers;
    const workspace=(await pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'")).rows[0]?.data||{};
    const course=(workspace.courses||[]).find(item=>String(item.id||item.title)===requested||item.title===requested);
    if(!course)return fail(res,404,'Course not found.');
    let assessment;try{assessment=scoreAssessment(answers,assessmentKeyFor(course));}catch(error){return fail(res,400,error.message);}
    const key=String(course.id||course.title),enrollment=await pool.query("SELECT status FROM enrollments WHERE user_id=$1 AND course_id=$2",[user.id,key]);
    if(!enrollment.rowCount||enrollment.rows[0].status!=='completed')return fail(res,403,'Complete the course modules before taking this assessment.');
    const attempt=(await pool.query('INSERT INTO assessment_attempts(user_id,course_id,answers,correct_count,question_count,score) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,correct_count,question_count,score,submitted_at',[user.id,key,JSON.stringify(answers),assessment.correct,assessment.total,assessment.score])).rows[0];
    const certificate=attempt.score>=70?(await pool.query('INSERT INTO certificates(user_id,course_id,assessment_id,score) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,course_id) DO UPDATE SET assessment_id=EXCLUDED.assessment_id,score=EXCLUDED.score,issued_at=now() RETURNING id,issued_at',[user.id,key,attempt.id,attempt.score])).rows[0]:null;
    return send(res,201,{attempt:{id:attempt.id,courseId:key,answers,correct:attempt.correct_count,total:attempt.question_count,skipped:assessment.skipped,incorrect:assessment.incorrect,score:attempt.score,submittedAt:attempt.submitted_at,certificate:certificate?{id:certificate.id,issuedAt:certificate.issued_at}:null}});
  }
  if(req.method==='POST'&&path==='/api/missions/attempt'){
    if(!requireRole(user,['Trainee'],res))return;
    const body=await readJson(req),response=String(body.response||'').trim();let evaluation;try{evaluation=scoreMissionResponse(response);}catch(error){return fail(res,400,error.message);}
    const {rubric,score}=evaluation;
    const result=await pool.query('INSERT INTO mission_attempts(user_id,mission_id,response,score,rubric) VALUES($1,$2,$3,$4,$5) RETURNING id,mission_id,response,score,rubric,submitted_at',[user.id,String(body.missionId||'operational-decision-making'),response,score,JSON.stringify(rubric)]);
    return send(res,201,{attempt:result.rows[0]});
  }
  if(req.method==='POST'&&path==='/api/skill-proofs'){
    if(!requireRole(user,['Trainee'],res))return;
    const body=await readJson(req),courseId=String(body.courseId||''),skill=String(body.skill||'').trim(),title=String(body.title||'').trim(),details=String(body.details||'').trim();
    if(!skill||skill.length>120||title.length<3||title.length>160||details.length<20||details.length>6000)return fail(res,400,'Choose a skill and provide a short title and at least 20 characters of evidence.');
    const workspace=(await pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'")).rows[0]?.data||{},course=(workspace.courses||[]).find(item=>String(item.id||item.title)===courseId||item.title===courseId);
    if(!course||!(course.trainerId||course.ownerId))return fail(res,400,'Choose a completed course with an assigned trainer to submit evidence.');
    const completed=await pool.query("SELECT 1 FROM enrollments WHERE user_id=$1 AND course_id=$2 AND status='completed'",[user.id,String(course.id||course.title)]);
    if(!completed.rowCount)return fail(res,403,'Complete the course before submitting skill evidence.');
    const result=await pool.query("INSERT INTO skill_proofs(user_id,course_id,skill,title,details) VALUES($1,$2,$3,$4,$5) RETURNING id,course_id,skill,title,details,status,submitted_at",[user.id,String(course.id||course.title),skill,title,details]);
    return send(res,201,{proof:result.rows[0]});
  }
  if(req.method==='GET'&&path==='/api/skill-proofs'){
    if(!requireRole(user,['Trainee','Trainer','Admin'],res))return;
    const result=user.role==='Trainee'
      ?await pool.query('SELECT id,course_id,skill,title,details,status,review_note,submitted_at,reviewed_at FROM skill_proofs WHERE user_id=$1 ORDER BY submitted_at DESC',[user.id])
      :await pool.query(`SELECT p.id,p.user_id,p.course_id,p.skill,p.title,p.details,p.status,p.review_note,p.submitted_at,p.reviewed_at,u.name AS user_name FROM skill_proofs p JOIN users u ON u.id=p.user_id ORDER BY p.submitted_at DESC`);
    const data=(await pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'")).rows[0]?.data||{};
    const proofs=user.role==='Trainer'?result.rows.filter(proof=>(data.courses||[]).some(course=>String(course.id||course.title)===proof.course_id&&(course.trainerId===user.id||course.ownerId===user.id))):result.rows;
    return send(res,200,{proofs});
  }
  const proofReview=path.match(/^\/api\/skill-proofs\/([\da-f-]+)\/review$/i);
  if(req.method==='PATCH'&&proofReview){
    if(!requireRole(user,['Trainer'],res))return;
    const data=(await pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'")).rows[0]?.data||{},proof=(await pool.query('SELECT * FROM skill_proofs WHERE id=$1',[proofReview[1]])).rows[0];
    if(!proof)return fail(res,404,'Skill proof not found.');
    const owned=(data.courses||[]).some(course=>String(course.id||course.title)===proof.course_id&&(course.trainerId===user.id||course.ownerId===user.id));
    if(!owned)return fail(res,403,'You can only review evidence for your own courses.');
    const body=await readJson(req),status=String(body.status||'');if(!['Validated','Rejected'].includes(status))return fail(res,400,'Choose Validated or Rejected.');
    const result=await pool.query('UPDATE skill_proofs SET status=$1,reviewer_id=$2,review_note=$3,reviewed_at=now() WHERE id=$4 RETURNING id,user_id,course_id,skill,title,details,status,review_note,submitted_at,reviewed_at',[status,user.id,String(body.note||'').slice(0,2000),proof.id]);
    return send(res,200,{proof:result.rows[0]});
  }
  if(req.method==='GET'&&path==='/api/trainers'){
    if(!requireRole(user,['Trainee','Admin'],res))return;
    const result=await pool.query("SELECT id,name,profile,created_at FROM users WHERE role='Trainer' AND status='Active' ORDER BY name");
    return send(res,200,{trainers:result.rows.map(item=>{const profile=item.profile||{};return {id:item.id,name:item.name,profile:{designation:profile.designation,specialization:profile.specialization,organization:profile.organization,experience:profile.experience,skills:profile.skills||[],competencies:profile.competencies||[]},createdAt:item.created_at};})});
  }
  if(req.method==='POST'&&path==='/api/resources'){
    if(!requireRole(user,['Trainer'],res))return;
    const body=await readJson(req),courseId=String(body.courseId||''),title=String(body.title||'').trim(),description=String(body.description||'').trim(),filename=String(body.filename||'').replace(/[\\/\r\n\0]/g,'').slice(0,180),mimeType=String(body.mimeType||'').toLowerCase(),encoded=String(body.contentBase64||'');
    const allowedTypes=new Set(['application/pdf','text/plain','image/png','image/jpeg']);
    if(title.length<2||title.length>160||!filename||!allowedTypes.has(mimeType)||!encoded||encoded.length>950000||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))return fail(res,400,'Provide a title and a PDF, text, PNG, or JPEG file no larger than 700 KB.');
    const bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>700*1024)return fail(res,400,'Resource files must be 700 KB or smaller.');
    const data=(await pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'")).rows[0]?.data||{},course=(data.courses||[]).find(item=>String(item.id||item.title)===courseId||item.title===courseId);
    if(!course||(course.trainerId!==user.id&&course.ownerId!==user.id))return fail(res,403,'Resources can only be added to a course you own.');
    const result=await pool.query('INSERT INTO course_resources(course_id,trainer_id,title,description,filename,mime_type,content) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,course_id,trainer_id,title,description,filename,mime_type,created_at',[String(course.id||course.title),user.id,title,description,filename,mimeType,bytes]);
    const item=result.rows[0];return send(res,201,{resource:{id:item.id,courseId:item.course_id,trainerId:item.trainer_id,title:item.title,description:item.description,filename:item.filename,type:item.mime_type,createdAt:item.created_at,url:`/api/resources/${item.id}/content`}});
  }
  const resourceContent=path.match(/^\/api\/resources\/([\da-f-]+)\/content$/i);
  if(resourceContent&&req.method==='GET'){
    if(!requireActive(user,res))return;
    const result=await pool.query('SELECT * FROM course_resources WHERE id=$1',[resourceContent[1]]);if(!result.rowCount)return fail(res,404,'Resource not found.');
    const resource=result.rows[0];
    if(user.role==='Trainer'){const data=(await pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'")).rows[0]?.data||{},owned=(data.courses||[]).some(course=>String(course.id||course.title)===resource.course_id&&(course.trainerId===user.id||course.ownerId===user.id));if(!owned)return fail(res,403,'You can only access resources for your own courses.');}
    if(user.role==='Trainee'){const enrolled=await pool.query('SELECT 1 FROM enrollments WHERE user_id=$1 AND course_id=$2',[user.id,resource.course_id]);if(!enrolled.rowCount)return fail(res,403,'Enroll in the course to access its resources.');}
    const filename=resource.filename.replace(/[^A-Za-z0-9._ -]/g,'_');res.writeHead(200,{'Content-Type':resource.mime_type,'Content-Length':resource.content.length,'Content-Disposition':`attachment; filename="${filename}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(resource.content);
  }
  if (path === '/api/workspace-state' && req.method === 'GET') { if (!requireActive(user,res)) return; return stateGet(user,res); }
  if (path === '/api/workspace-state' && req.method === 'PUT') { if (!requireActive(user,res)) return; return statePut(user,req,res); }
  if (req.method === 'GET' && path === '/api/users') {
    if (!requireRole(user,['Admin'],res)) return;
    const result = await pool.query('SELECT id,name,email,employee_id,role,status,profile,created_at FROM users ORDER BY created_at DESC');
    return send(res,200,{users:result.rows.map(publicUser)});
  }
  if(req.method==='GET'&&path==='/api/analytics'){
    if(!requireRole(user,['Admin'],res))return;
    const [people,workspace,enrollmentCount,completedCount,progressRows,attemptStats,evidenceRows,verifiedSkills,verifiedCount]=await Promise.all([
      pool.query('SELECT role,status,COUNT(*)::int AS count FROM users GROUP BY role,status'),
      pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'"),
      pool.query('SELECT COUNT(*)::int AS count FROM enrollments'),
      pool.query("SELECT COUNT(*)::int AS count FROM enrollments WHERE status='completed'"),
      pool.query(`SELECT e.user_id,e.course_id,COUNT(DISTINCT m.module_id)::int AS completed, GREATEST(1,jsonb_array_length(COALESCE(c.course->'skills','[]'::jsonb)))::int AS required
        FROM enrollments e LEFT JOIN module_completions m ON m.user_id=e.user_id AND m.course_id=e.course_id
        LEFT JOIN LATERAL (SELECT item AS course FROM workspace_state w,jsonb_array_elements(w.data->'courses') item WHERE w.workspace_id='default' AND COALESCE(item->>'id',item->>'title')=e.course_id LIMIT 1) c ON true
        GROUP BY e.user_id,e.course_id,c.course`),
      pool.query('SELECT COUNT(*)::int AS count,COALESCE(ROUND(AVG(score)),0)::int AS average FROM assessment_attempts'),
      pool.query('SELECT course_id,score FROM assessment_attempts'),
      pool.query("SELECT skill,COUNT(*)::int AS count FROM skill_proofs WHERE status='Validated' GROUP BY skill"),
      pool.query("SELECT COUNT(*)::int AS count FROM skill_proofs WHERE status='Validated'")
    ]);
    const rows=people.rows, count=(role,status)=>rows.filter(row=>(!role||row.role===role)&&(!status||row.status===status)).reduce((n,row)=>n+row.count,0),progress=progressRows.rows.map(row=>Math.round(row.completed/row.required*100));
    const data=workspace.rows[0]?.data||{},evidence={};
    for(const item of evidenceRows.rows){const course=(data.courses||[]).find(value=>String(value.id||value.title)===item.course_id),subject=String(course?.subject||'').toLowerCase(),skill=subject.includes('analysis')||subject.includes('data')?'Data Analysis':subject.includes('climate')?'Risk Awareness':subject.includes('forecast')?'Forecasting':'Radar Interpretation';evidence[skill]??=[];evidence[skill].push(item.score);}
    for(const item of verifiedSkills.rows){evidence[item.skill]??=[];evidence[item.skill].push(...Array(item.count).fill(100));}
    const competencies=Object.fromEntries(Object.entries(evidence).map(([skill,scores])=>[skill,Math.round(scores.reduce((sum,value)=>sum+value,0)/scores.length)]));
    return send(res,200,{users:count(),activeUsers:count(null,'Active'),trainees:count('Trainee','Active'),trainers:count('Trainer','Active'),admins:count('Admin','Active'),pendingApprovals:count(null,'Pending'),courses:(data.courses||[]).filter(course=>course.status!=='Draft').length,enrollments:enrollmentCount.rows[0].count,courseCompletions:completedCount.rows[0].count,averageProgress:progress.length?Math.round(progress.reduce((a,b)=>a+Math.min(100,b),0)/progress.length):0,assessmentAttempts:attemptStats.rows[0].count,averageAssessment:attemptStats.rows[0].average,validatedSkills:verifiedCount.rows[0].count,competencies});
  }
  if(req.method==='GET'&&path==='/api/trainees'){
    if(!requireRole(user,['Trainer','Admin'],res))return;
    const [users,courseData]=await Promise.all([pool.query("SELECT id,name,status,profile,created_at FROM users WHERE role='Trainee' AND status='Active' ORDER BY created_at DESC"),pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'")]);
    const userIds=users.rows.map(row=>row.id),[enrollmentResult,attemptResult,moduleResult]=await Promise.all([pool.query('SELECT user_id,course_id,status FROM enrollments WHERE user_id=ANY($1::uuid[])',[userIds]),pool.query('SELECT user_id,course_id,score FROM assessment_attempts WHERE user_id=ANY($1::uuid[])',[userIds]),pool.query('SELECT user_id,course_id,module_id FROM module_completions WHERE user_id=ANY($1::uuid[])',[userIds])]);
    const courses=courseData.rows[0]?.data?.courses||[],ownedIds=user.role==='Trainer'?new Set(courses.filter(course=>course.trainerId===user.id||course.ownerId===user.id).map(course=>String(course.id||course.title))):null;
    const trainees=users.rows.map(row=>{const enrollments=enrollmentResult.rows.filter(item=>item.user_id===row.id&&(!ownedIds||ownedIds.has(item.course_id)));if(user.role==='Trainer'&&!enrollments.length)return null;const relevant=new Set(enrollments.map(item=>item.course_id)),scores=attemptResult.rows.filter(item=>item.user_id===row.id&&(!ownedIds||relevant.has(item.course_id))).map(item=>item.score);return {id:row.id,name:row.name,status:row.status,department:row.profile?.department||'',joined:row.created_at,score:scores.length?Math.round(scores.reduce((sum,value)=>sum+value,0)/scores.length):0,enrollments:enrollments.map(item=>{const course=courses.find(course=>String(course.id||course.title)===item.course_id),required=Math.max(1,course?.skills?.length||1),completed=moduleResult.rows.filter(module=>module.user_id===row.id&&module.course_id===item.course_id).length;return {courseId:item.course_id,title:course?.title||item.course_id,status:completed>=required?'completed':item.status,progress:Math.min(100,Math.round(completed/required*100))};})};}).filter(Boolean);
    return send(res,200,{trainees});
  }
  if (req.method === 'POST' && path === '/api/users') {
    if (!requireRole(user,['Admin'],res)) return;
    const body=await readJson(req),name=String(body.name||'').trim(),email=String(body.email||'').trim().toLowerCase(),password=String(body.password||''),role=String(body.role||'Trainee');
    if(name.length<2||name.length>100||!/^\S+@\S+\.\S+$/.test(email)||password.length<12||!['Admin','Trainer','Trainee'].includes(role))return fail(res,400,'Enter a valid name, email, role and a password of at least 12 characters.');
    try { const hash=await hashPassword(password);const status=role==='Admin'||role==='Trainee'?'Active':'Pending';const result=await pool.query('INSERT INTO users(name,email,password_hash,role,status,profile) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,email,employee_id,role,status,profile,created_at',[name,email,hash,role,status,{department:String(body.department||'').trim(),designation:role}]);return send(res,201,{user:publicUser(result.rows[0])}); }
    catch(error){if(error.code==='23505')return fail(res,409,'That email is already registered.');throw error;}
  }
  const userAction = path.match(/^\/api\/users\/([\da-f-]+)\/(approve|reject|suspend|activate)$/i);
  if (req.method === 'POST' && userAction) {
    if (!requireRole(user,['Admin'],res)) return;
    const status = ({approve:'Active',reject:'Rejected',suspend:'Suspended',activate:'Active'})[userAction[2].toLowerCase()];
    const target=(await pool.query('SELECT id,role,status FROM users WHERE id=$1',[userAction[1]])).rows[0];
    if(!target||target.id===user.id||target.role==='Admin'&&(target.status!=='Pending'||status!=='Active'))return fail(res,404,'User not found or cannot be changed.');
    const result = await pool.query('UPDATE users SET status=$1,updated_at=now() WHERE id=$2 RETURNING id,name,email,employee_id,role,status,profile,created_at',[status,userAction[1]]);
    return send(res,200,{user:publicUser(result.rows[0])});
  }
  const roleAction=path.match(/^\/api\/users\/([\da-f-]+)\/role$/i);
  if(req.method==='PATCH'&&roleAction){
    if(!requireRole(user,['Admin'],res))return;
    const body=await readJson(req),role=String(body.role||'');
    if(!['Admin','Trainer','Trainee'].includes(role))return fail(res,400,'Choose a valid platform role.');
    const status=role==='Trainer'?'Pending':'Active';
    const result=await pool.query('UPDATE users SET role=$1,status=$2,updated_at=now() WHERE id=$3 AND id<>$4 RETURNING id,name,email,employee_id,role,status,profile,created_at',[role,status,roleAction[1],user.id]);
    if(!result.rowCount)return fail(res,404,'User not found or you cannot change your own role.');
    return send(res,200,{user:publicUser(result.rows[0])});
  }
  return fail(res,404,'API route not found.');
}

await (async () => { if (pool) await migrate(); })();
createServer(async (req,res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req,res,url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405,{Allow:'GET, HEAD'}).end(); return; }
    const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if(!['index.html','app.css','app.js','onboarding-mountains.jpg'].includes(requested)){res.writeHead(404).end('Not found');return;}
    const file = resolve(root,requested);
    if (!file.startsWith(root + sep) && file !== resolve(root,'index.html')) { res.writeHead(403).end('Forbidden'); return; }
    const contents = await readFile(file);
    res.writeHead(200,{ 'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; img-src 'self' data: https://images.unsplash.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'" });
    if (req.method === 'HEAD') res.end(); else res.end(contents);
  } catch (error) {
    if (req.url?.startsWith('/api/')) return fail(res,error.status||500,error.status?error.message:'Unexpected server error.');
    console.error('Request failed:',error); res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}).end('Not found');
  }
}).listen(port,'0.0.0.0',()=>console.log(`Nexora server listening on ${port}`));
