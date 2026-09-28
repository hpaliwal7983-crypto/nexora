import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';

const { Pool } = pg;
const scrypt = promisify(scryptCallback);
const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 10 }) : null;
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const sessionCookie = 'nexora_session';
const publicUser = ({ id, name, email, role, status, profile, created_at }) => ({ id, name, email, role, status, profile, createdAt: created_at });

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}
function fail(res, status, error) { send(res, status, { error }); }
async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw Object.assign(new Error('Request is too large.'), { status: 413 });
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
    INSERT INTO workspace_state(workspace_id, data) VALUES ('default', '{}') ON CONFLICT DO NOTHING;
  `);
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
  const demoEmail = process.env.DEMO_EMAIL?.trim().toLowerCase();
  const demoPassword = process.env.DEMO_PASSWORD;
  if (demoEmail && demoPassword && demoPassword.length >= 12) {
    const exists = await pool.query('SELECT id FROM users WHERE lower(email) = $1', [demoEmail]);
    if (!exists.rowCount) {
      const hash = await hashPassword(demoPassword);
      await pool.query("INSERT INTO users(name,email,password_hash,role,status,profile) VALUES ($1,$2,$3,'Trainee','Active',$4)", [process.env.DEMO_NAME || 'Harsh', demoEmail, hash, { department: 'Meteorology', designation: 'Demo learner' }]);
      console.log('Public Harsh demo account is ready.');
    }
  }
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
const personalKeys = new Set(['competencies','completedModules','missionComplete','assessmentDone','assessmentCorrect','assessmentSkipped','assessmentIncorrect','assessmentScore','missionScore','missionResponse','proofSkill','proofSubmitted','courseProgress','enrolled','events','profile','reminders','questionnaireResponses','questionnaireSubmissions','assessmentAnswers','selectedCourse','courseSearch','userRoleFilter']);
const adminSharedKeys = new Set(['courses','announcements','feedbacks','resources','questionnaires','competencyMapping','organizationCompetencies']);
const trainerSharedKeys = new Set(['courses','questionnaires','resources']);
async function stateGet(user, res) {
  const [shared, personal] = await Promise.all([
    pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'"),
    pool.query('SELECT data FROM user_state WHERE user_id=$1', [user.id])
  ]);
  const userData = personal.rows[0]?.data || {};
  const workspace=shared.rows[0]?.data||{};
  if(user.role==='Trainee'){
    if(Array.isArray(workspace.questionnaires))workspace.questionnaires=workspace.questionnaires.map(({correct,...q})=>q);
    delete workspace.questionnaireResponses;
  } else if(user.role==='Trainer') {
    const owned=new Set((workspace.questionnaires||[]).filter(q=>q.ownerId===user.id).map(q=>q.id));
    workspace.questionnaireResponses=(workspace.questionnaireResponses||[]).filter(response=>owned.has(response.questionnaireId));
  }
  send(res, 200, { shared: workspace, personal: { ...userData, profile: user.profile }, user: publicUser(user) });
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
    await pool.query('DELETE FROM user_state WHERE user_id=$1',[user.id]);
    return send(res,200,{cleared:true});
  }
  if (req.method === 'POST' && path === '/api/auth/register') {
    const body = await readJson(req);
    const name = String(body.name || '').trim(); const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || ''); const role = String(body.role || 'Trainee');
    if (name.length < 2 || name.length > 100 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 12 || !['Trainer','Trainee'].includes(role)) return fail(res, 400, 'Enter a valid name and email, choose Trainer or Trainee, and use a password with at least 12 characters.');
    const profile = { employeeId: String(body.employeeId || '').trim(), phone: String(body.phone || '').trim(), department: String(body.department || '').trim(), designation: String(body.designation || '').trim() };
    const hash = await hashPassword(password);
    try {
      const result = await pool.query("INSERT INTO users(name,email,employee_id,password_hash,role,status,profile) VALUES ($1,$2,$3,$4,$5,'Active',$6) RETURNING *", [name,email,profile.employeeId||null,hash,role,profile]);
      return send(res, 201, { user: publicUser(result.rows[0]), message: 'Account created. You can sign in now.' });
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
  if (req.method === 'GET' && path === '/api/auth/me') return user ? send(res,200,{user:publicUser(user)}) : fail(res,401,'Not signed in.');
  if (req.method === 'PATCH' && path === '/api/profile') {
    if (!requireActive(user,res)) return;
    const body = await readJson(req); const name=String(body.name||'').trim();
    if (name.length < 2 || name.length > 100) return fail(res,400,'Enter a name between 2 and 100 characters.');
    const profile={ employeeId:String(body.employeeId||'').trim(), department:String(body.department||'').trim(), designation:String(body.designation||'').trim(), experience:String(body.experience||'').trim() };
    const result=await pool.query('UPDATE users SET name=$1,profile=$2,updated_at=now() WHERE id=$3 RETURNING *',[name,profile,user.id]);
    return send(res,200,{user:publicUser(result.rows[0])});
  }
  if (req.method === 'POST' && path === '/api/feedback') {
    if (!requireRole(user,['Trainee'],res)) return;
    const body=await readJson(req);const overall=Number(body.overall),content=Number(body.content),trainer=Number(body.trainer),experience=Number(body.experience);
    if (!body.course || [overall,content,trainer,experience].some(x=>!Number.isFinite(x)||x<1||x>5)) return fail(res,400,'Choose a course and submit ratings from 1 to 5.');
    const feedback={id:randomBytes(12).toString('hex'),course:String(body.course).slice(0,160),user:user.name,userId:user.id,overall,content,trainer,experience,comments:String(body.comments||'').slice(0,2000),createdAt:new Date().toISOString()};
    await pool.query("UPDATE workspace_state SET data=jsonb_set(data,'{feedbacks}',COALESCE(data->'feedbacks','[]'::jsonb)||$1::jsonb,true),updated_at=now() WHERE workspace_id='default'",[JSON.stringify([feedback])]);
    return send(res,201,{feedback});
  }
  const questionnaireResponse=path.match(/^\/api\/questionnaires\/([^/]+)\/responses$/);
  if(questionnaireResponse&&req.method==='POST'){
    if(!requireRole(user,['Trainee'],res))return;
    const body=await readJson(req),answer=Number(body.answer);
    const client=await pool.connect();
    try{await client.query('BEGIN');const row=(await client.query("SELECT data FROM workspace_state WHERE workspace_id='default' FOR UPDATE")).rows[0],data=row?.data||{},q=(data.questionnaires||[]).find(item=>item.id===questionnaireResponse[1]);if(!q){await client.query('ROLLBACK');return fail(res,404,'Questionnaire not found.');}if(Date.now()>new Date(q.deadline).getTime()){await client.query('ROLLBACK');return fail(res,409,'The deadline has passed.');}if(!Number.isInteger(answer)||answer<0||answer>=q.options.length){await client.query('ROLLBACK');return fail(res,400,'Choose an answer before submitting.');}const responses=data.questionnaireResponses||[];if(responses.some(r=>r.questionnaireId===q.id&&r.userId===user.id)){await client.query('ROLLBACK');return fail(res,409,'You have already submitted this questionnaire.');}const response={id:randomBytes(12).toString('hex'),questionnaireId:q.id,title:q.title,userId:user.id,userName:user.name,answer,score:answer===Number(q.correct)?100:0,submittedAt:new Date().toISOString()};data.questionnaireResponses=[...responses,response];await client.query("UPDATE workspace_state SET data=$1,updated_at=now() WHERE workspace_id='default'",[JSON.stringify(data)]);await client.query('COMMIT');return send(res,201,{response:{score:response.score,submittedAt:response.submittedAt}});}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  if(questionnaireResponse&&req.method==='GET'){
    if(!requireRole(user,['Trainer','Admin'],res))return;
    const result=await pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'");const data=result.rows[0]?.data||{},questionnaire=(data.questionnaires||[]).find(item=>item.id===questionnaireResponse[1]);if(!questionnaire)return fail(res,404,'Questionnaire not found.');if(user.role==='Trainer'&&questionnaire.ownerId!==user.id)return fail(res,403,'You can view responses to your own questionnaires only.');return send(res,200,{responses:(data.questionnaireResponses||[]).filter(r=>r.questionnaireId===questionnaire.id)});
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
    const [people,workspace]=await Promise.all([pool.query('SELECT u.id,u.role,u.status,us.data FROM users u LEFT JOIN user_state us ON us.user_id=u.id'),pool.query("SELECT data FROM workspace_state WHERE workspace_id='default'")]);
    const rows=people.rows,active=rows.filter(u=>u.status==='Active'),trainees=active.filter(u=>u.role==='Trainee');
    const progress=trainees.flatMap(u=>Object.values(u.data?.courseProgress||{}).map(Number).filter(Number.isFinite));
    const assessmentScores=trainees.filter(u=>u.data?.assessmentDone&&Number.isFinite(Number(u.data?.assessmentScore))).map(u=>Number(u.data.assessmentScore));
    const enrollments=trainees.reduce((n,u)=>n+(Array.isArray(u.data?.enrolled)?u.data.enrolled.length:0),0);
    const competencies={};for(const trainee of trainees)for(const [key,value] of Object.entries(trainee.data?.competencies||{})){const n=Number(value);if(Number.isFinite(n)){competencies[key]??={sum:0,count:0};competencies[key].sum+=n;competencies[key].count++;}}
    const competencyAverages=Object.fromEntries(Object.entries(competencies).map(([key,value])=>[key,Math.round(value.sum/value.count)]));
    const validatedSkills=trainees.filter(u=>u.data?.proofSubmitted===true).length;
    const data=workspace.rows[0]?.data||{};
    return send(res,200,{users:rows.length,activeUsers:active.length,trainees:trainees.length,trainers:active.filter(u=>u.role==='Trainer').length,admins:active.filter(u=>u.role==='Admin').length,pendingApprovals:rows.filter(u=>u.status==='Pending').length,courses:(data.courses||[]).length,enrollments,averageProgress:progress.length?Math.round(progress.reduce((a,b)=>a+b,0)/progress.length):0,assessmentAttempts:assessmentScores.length,averageAssessment:assessmentScores.length?Math.round(assessmentScores.reduce((a,b)=>a+b,0)/assessmentScores.length):0,validatedSkills,competencies:competencyAverages});
  }
  if(req.method==='GET'&&path==='/api/trainees'){
    if(!requireRole(user,['Trainer','Admin'],res))return;
    const result=await pool.query("SELECT u.id,u.name,u.status,u.profile,u.created_at,us.data FROM users u LEFT JOIN user_state us ON us.user_id=u.id WHERE u.role='Trainee' ORDER BY u.created_at DESC");
    return send(res,200,{trainees:result.rows.map(row=>({id:row.id,name:row.name,status:row.status,department:row.profile?.department||'',joined:row.created_at,score:row.data?.competencies?.['Radar Interpretation']||0,progress:row.data?.courseProgress||{},enrolled:row.data?.enrolled||[]}))});
  }
  if (req.method === 'POST' && path === '/api/users') {
    if (!requireRole(user,['Admin'],res)) return;
    const body=await readJson(req),name=String(body.name||'').trim(),email=String(body.email||'').trim().toLowerCase(),password=String(body.password||''),role=String(body.role||'Trainee');
    if(name.length<2||name.length>100||!/^\S+@\S+\.\S+$/.test(email)||password.length<12||!['Admin','Trainer','Trainee'].includes(role))return fail(res,400,'Enter a valid name, email, role and a password of at least 12 characters.');
    try { const hash=await hashPassword(password);const status=role==='Admin'?'Active':'Pending';const result=await pool.query('INSERT INTO users(name,email,password_hash,role,status,profile) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,email,employee_id,role,status,profile,created_at',[name,email,hash,role,status,{department:String(body.department||'').trim(),designation:role}]);return send(res,201,{user:publicUser(result.rows[0])}); }
    catch(error){if(error.code==='23505')return fail(res,409,'That email is already registered.');throw error;}
  }
  const userAction = path.match(/^\/api\/users\/([\da-f-]+)\/(approve|reject|suspend|activate)$/i);
  if (req.method === 'POST' && userAction) {
    if (!requireRole(user,['Admin'],res)) return;
    const status = ({approve:'Active',reject:'Rejected',suspend:'Suspended',activate:'Active'})[userAction[2].toLowerCase()];
    const result = await pool.query('UPDATE users SET status=$1,updated_at=now() WHERE id=$2 AND role<>\'Admin\' RETURNING id,name,email,employee_id,role,status,profile,created_at',[status,userAction[1]]);
    if (!result.rowCount) return fail(res,404,'User not found or cannot be changed.');
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
