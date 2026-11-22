import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createWriteStream, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { exec } from 'node:child_process';
import { createProviders } from './providers.mjs';
import { createBufferPublisher } from './buffer-publisher.mjs';
import preflight from './public/preflight.cjs';

const appDir = dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(join(appDir,'.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const env = process.env;
const port = Number(env.REELDESK_PORT || '8787');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('REELDESK_PORT must be between 1024 and 65535.');
const base = 'http://127.0.0.1:' + port;
const localhost = 'http://localhost:' + port;
const origins = new Set([base,localhost]);
const hosts = new Set([...origins].map(origin => new URL(origin).host));
const {MAX_BYTES,MAX_IMAGE_BYTES,IMAGE_TYPES,KINDS,BUFFER_PLATFORMS,PLATFORM_IDS,hasMp4Header,imageType,
  supportsKind,hasVideoMetadata,checkVideo,checkImage,checkCaption,captionFor} = preflight;
const maxActive = 3;
const maxScheduled = 10;
const maxScheduleAhead = 30 * 24 * 60 * 60 * 1000;
const maxScheduleDelay = 60 * 1000;
const providerFields = {
  meta:['META_APP_ID','META_APP_SECRET','META_CONFIG_ID','META_GRAPH_VERSION'],
  youtube:['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET'],
  tiktok:['BUFFER_API_KEY','CLOUDINARY_CLOUD_NAME','CLOUDINARY_API_KEY','CLOUDINARY_API_SECRET'],
};
const callbacks = {meta:localhost + '/oauth/meta',youtube:base + '/oauth/youtube'};
const dataDir = join(appDir,'.reeldesk-data');
const uploadsDir = join(dataDir,'uploads');
const statePath = join(dataDir,'state.json');
const html = readFileSync(join(appDir,'public','index.html'),'utf8');
const preflightJs = readFileSync(join(appDir,'public','preflight.cjs'));
const scriptHash = createHash('sha256').update(html.match(/<script>([\s\S]+)<\/script>/)[1]).digest('base64');
const key = randomBytes(32).toString('base64url');
const oauthStates = new Map();
const receiving = new Set();
const checkingBuffer = new Set();
const connecting = new Set();
const activeJobs = new Set();
let state, runtime;

class InputError extends Error {
  constructor(status,message) { super(message); this.status = status; }
}

function save(next = state) {
  const temp = statePath + '.tmp';
  writeFileSync(temp, JSON.stringify(next), { mode:0o600 });
  renameSync(temp,statePath);
}

function createRuntime(overrides = {}, legacy = false) {
  const entries = Object.values(providerFields).flat().map(name => [
    name,legacy ? (overrides[name] ?? env[name] ?? '') : (env[name] || overrides[name] || ''),
  ]);
  const fields = Object.fromEntries(entries);
  fields.META_GRAPH_VERSION ||= 'v25.0';
  const buffer = createBufferPublisher({
    bufferKey:fields.BUFFER_API_KEY, cloudName:fields.CLOUDINARY_CLOUD_NAME,
    cloudKey:fields.CLOUDINARY_API_KEY, cloudSecret:fields.CLOUDINARY_API_SECRET,
  });
  const providers = createProviders({
    meta:{
      id:fields.META_APP_ID, secret:fields.META_APP_SECRET, configId:fields.META_CONFIG_ID,
      version:fields.META_GRAPH_VERSION, redirect:callbacks.meta,
    },
    youtube:{ id:fields.GOOGLE_CLIENT_ID, secret:fields.GOOGLE_CLIENT_SECRET, redirect:callbacks.youtube },
  });
  return {
    providers, buffer,
    identity:Object.fromEntries(Object.entries(providerFields).map(([provider,names]) => {
      const authNames = provider === 'tiktok' ? ['BUFFER_API_KEY'] : names.filter(name => name !== 'META_GRAPH_VERSION');
      return [provider,createHash('sha256').update(JSON.stringify(authNames.map(name => fields[name]))).digest('hex')];
    })),
    bufferFingerprint:createHash('sha256').update(fields.BUFFER_API_KEY).digest('hex'),
    configured:{
      meta:providerFields.meta.every(name => Boolean(fields[name])) && /^v\d{1,2}\.0$/.test(fields.META_GRAPH_VERSION),
      youtube:providerFields.youtube.every(name => Boolean(fields[name])),
      tiktok:buffer.configured,
      cloudMedia:buffer.cloudConfigured,
    },
  };
}

function mediaPath(job) {
  if (job.kind === 'text') return null;
  const extension = job.kind === 'image' ? IMAGE_TYPES[job.mediaType] : 'mp4';
  return join(uploadsDir,job.id + '.' + extension);
}

function initialize() {
  mkdirSync(uploadsDir,{ recursive:true, mode:0o700 });
  try { state = JSON.parse(readFileSync(statePath,'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { connections:{}, jobs:[] };
  }
  runtime = createRuntime(state.settings);
  const previousIdentity = state.providerIdentity || createRuntime(state.settings,true).identity;
  let changed = false;
  for (const [provider,identity] of Object.entries(runtime.identity)) {
    if (previousIdentity[provider] && previousIdentity[provider] !== identity) {
      delete state.connections[provider];
      changed = true;
    }
  }
  if (state.connections.youtube?.channel) {
    state.connections.youtube = [state.connections.youtube];
    changed = true;
  }
  if (JSON.stringify(state.providerIdentity) !== JSON.stringify(runtime.identity)) {
    state.providerIdentity = runtime.identity;
    changed = true;
  }
  const retained = new Set();
  for (const job of state.jobs) {
    if (job.schedulePending) {
      if (Date.parse(job.scheduledAt) <= Date.now()) {
        job.schedulePending = false;
        for (const result of job.results) {
          result.status = 'missed';
          result.note = 'فات الوقت قبل تشغيل AZMORY. برمج المنشور من جديد.';
        }
        changed = true;
      } else {
        const path = mediaPath(job);
        if (path) retained.add(path);
      }
      continue;
    }
    for (const result of job.results) {
      if (!['queued','uploading','processing'].includes(result.status)) continue;
      result.status = 'unknown';
      result.note = 'التطبيق تعاود تشغّل. تأكد من الحساب قبل ما تعاود الإرسال.';
      changed = true;
    }
  }
  if (changed) save();
  for (const name of readdirSync(uploadsDir)) {
    const path = join(uploadsDir,name);
    if (/^[a-f0-9-]{36}\.(?:mp4|jpg|png)$/.test(name) && !retained.has(path)) rmSync(path,{force:true});
  }
}

function availableTargets() {
  const {configured,bufferFingerprint} = runtime;
  const accounts = [];
  if (configured.meta) {
    for (const page of state.connections.meta?.pages || []) {
      if (page.canPublishFacebook) accounts.push({ id:'facebook:' + page.id, accountId:page.id, name:page.name, platform:'facebook', token:page.token });
      if (page.canPublishInstagram && page.instagram && !accounts.some(account => account.id === 'instagram:' + page.instagram.id)) {
        accounts.push({
          id:'instagram:' + page.instagram.id, accountId:page.instagram.id, platform:'instagram', token:page.token,
          name:page.instagram.username ? '@' + page.instagram.username : 'Instagram · ' + page.name,
        });
      }
    }
  }
  if (configured.youtube) {
    for (const {channel,refreshToken} of state.connections.youtube || []) {
      accounts.push({ id:'youtube:' + channel.id, accountId:channel.id, platform:'youtube', name:channel.name, refreshToken });
    }
  }
  const linkedTikTok = state.connections.tiktok;
  if (configured.tiktok && linkedTikTok?.fingerprint === bufferFingerprint) {
    for (const channel of linkedTikTok.channels) {
      const platform = channel.platform || 'tiktok';
      if (BUFFER_PLATFORMS.includes(platform)) {
        accounts.push({ id:platform + ':' + channel.id, accountId:channel.id, platform, name:channel.name });
      }
    }
  }
  return accounts;
}

function securityHeaders(res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; media-src blob:; img-src blob:; style-src 'unsafe-inline'; script-src 'self' 'sha256-" + scriptHash + "'");
}

function json(res,status,data) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(data));
}

function authorized(req) {
  const provided = req.headers['x-reeldesk-key'];
  return typeof provided === 'string' && provided.length === key.length && timingSafeEqual(Buffer.from(provided),Buffer.from(key));
}

function redirect(res, location) {
  res.writeHead(303, { Location:location });
  res.end();
}

function noticeRedirect(res, code, provider) {
  const origin = provider === 'meta' ? localhost : base;
  redirect(res,origin + '/?notice=' + code + '#accounts');
}

function beginOAuth(provider,res) {
  if (!runtime.configured[provider]) throw new InputError(409,'الربط كيتفعّل من طرف مدير AZMORY.');
  if (connecting.has(provider)) throw new InputError(409,'كاين ربط قيد المعالجة.');
  const now = Date.now();
  for (const [stateId,entry] of oauthStates) {
    if (entry.expires < now || entry.provider === provider) oauthStates.delete(stateId);
  }
  const stateId = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  oauthStates.set(stateId,{ provider,verifier,expires:now + 10 * 60 * 1000 });
  json(res,200,{ url:runtime.providers.authorize(provider,stateId,verifier).href });
}

async function completeOAuth(provider,url,res) {
  const id = url.searchParams.get('state');
  const entry = oauthStates.get(id);
  if (!entry || entry.provider !== provider || entry.expires < Date.now()) return noticeRedirect(res,'denied',provider);
  oauthStates.delete(id);
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.has('error') || connecting.has(provider)) return noticeRedirect(res,'denied',provider);
  connecting.add(provider);
  const {providers} = runtime;
  try {
    if (provider === 'meta') {
      const connection = await providers.connectMeta(code);
      state.connections.meta = connection;
      save();
      noticeRedirect(res,connection.pages.length ? 'meta_ok' : 'meta_empty',provider);
    } else {
      const connection = await providers.connectYouTube(code,entry.verifier);
      const channels = state.connections.youtube || [];
      const exists = channels.some(item => item.channel.id === connection.channel.id);
      const youtube = exists
        ? channels.map(item => item.channel.id === connection.channel.id ? connection : item)
        : [...channels,connection];
      const next = {...state,connections:{...state.connections,youtube}};
      save(next);
      state = next;
      noticeRedirect(res,'youtube_ok',provider);
    }
  } catch {
    noticeRedirect(res,'oauth_error',provider);
  } finally {
    connecting.delete(provider);
  }
}

function parsePost(req) {
  let payload;
  const header = req.headers['x-reeldesk-post'] || '';
  try {
    const value = header.startsWith('b64:') ? Buffer.from(header.slice(4),'base64').toString('utf8') : decodeURIComponent(header);
    payload = JSON.parse(value);
  } catch {}
  if (!payload || typeof payload.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(payload.id)) {
    throw new InputError(400,'بيانات الطلب غير صالحة.');
  }
  return payload;
}

function validatePost(post,type,size) {
  const { id,kind = 'video',title = '',caption,captions,targets,privacy,kids,duration,width,height,consent,tiktokAi,tiktokTransfer,bufferTransfer,scheduledAt } = post;
  if (!KINDS.includes(kind)) throw new InputError(400,'اختار نوع المنشور.');
  if (typeof title !== 'string' || (kind === 'video' && !title.trim()) || title.length > 100 || typeof caption !== 'string' || caption.length > 2200) {
    throw new InputError(400,'راجع العنوان والوصف.');
  }
  if (captions !== undefined && (
    !captions || typeof captions !== 'object' || Array.isArray(captions) ||
    Object.entries(captions).some(([platform,value]) => !PLATFORM_IDS.includes(platform) || typeof value !== 'string' || value.length > 2200)
  )) throw new InputError(400,'راجع الوصف الخاص بكل منصة.');
  if (consent !== true || !Array.isArray(targets) || !targets.length || new Set(targets).size !== targets.length) {
    throw new InputError(400,'اختار الحسابات وأكّد الإرسال.');
  }
  if (targets.length > 20) throw new InputError(400,'اختار حتى لـ 20 حساب فهاد العملية.');
  const accounts = new Map(availableTargets().map(target => [target.id,target]));
  const destinations = targets.map(target => accounts.get(target));
  if (destinations.some(target => !target)) throw new InputError(409,'شي حساب تبدّل أو تفصل. حدّث الصفحة واختار من جديد.');
  const metadata = {duration,width,height};
  if (kind === 'video' && !hasVideoMetadata(metadata)) throw new InputError(400,'الأبعاد أو المدة غير صالحة.');
  if (kind === 'image' && !hasVideoMetadata({duration:1,width,height})) throw new InputError(400,'أبعاد الصورة غير صالحة.');
  const platforms = new Set(destinations.map(target => target.platform));
  for (const platform of platforms) {
    if (!supportsKind(platform,kind,runtime.configured.cloudMedia)) {
      throw new InputError(400,'هاد النوع ديال المنشور غير متاح للحساب المختار فـ ' + platform + '.');
    }
    const text = captionFor(platform,caption,captions);
    if (kind === 'text' && !text) throw new InputError(400,'كتب نص المنشور لكل حساب مختار.');
    const issues = checkCaption(platform,text,kind === 'video' ? title.trim() : '');
    if (kind === 'video') issues.push(...checkVideo(platform,metadata));
    if (kind === 'image') issues.push(...checkImage(platform,{size,type,width,height}));
    if (issues.length) throw new InputError(400,platform + ' — ' + issues.join(' '));
  }
  if (platforms.has('youtube') && (!['private','unlisted','public'].includes(privacy) || !['yes','no'].includes(kids))) {
    throw new InputError(400,'راجع خصوصية YouTube واختيار الجمهور ديال الأطفال.');
  }
  const tiktokCount = destinations.filter(target => target.platform === 'tiktok').length;
  if (tiktokCount && typeof tiktokAi !== 'boolean') {
    throw new InputError(400,'راجع خيار الذكاء الاصطناعي ديال TikTok.');
  }
  const buffered = destinations.filter(target => BUFFER_PLATFORMS.includes(target.platform));
  const legacyConsent = kind === 'video' && tiktokCount > 0 && tiktokCount === buffered.length && tiktokTransfer === true;
  const needsCloud = (kind !== 'text' && buffered.length) || (kind === 'image' && platforms.has('instagram'));
  if (needsCloud && bufferTransfer !== true && !legacyConsent) {
    throw new InputError(400,'أكّد إرسال نسخة مؤقتة من الملف.');
  }
  const platformCaptions = Object.fromEntries([...platforms]
    .filter(platform => captions?.[platform]?.trim()).map(platform => [platform,captions[platform].trim()]));
  const label = title.trim() || (caption.trim() || Object.values(platformCaptions)[0] || 'منشور بصورة').slice(0,100);
  const job = {id,kind,title:label,caption:caption.trim(),captions:platformCaptions,privacy,kids,tiktokAi};
  if (kind === 'image') job.mediaType = type;
  if (scheduledAt !== undefined) {
    job.scheduledAt = futureTime(scheduledAt);
    job.schedulePending = true;
  }
  return { job, destinations };
}

function futureTime(value) {
  const due = typeof value === 'string' ? Date.parse(value) : NaN;
  const now = Date.now();
  if (!Number.isFinite(due) || due <= now || due > now + maxScheduleAhead) {
    throw new InputError(400,'اختار موعد فالمستقبل، حتى لـ 30 يوم.');
  }
  return new Date(due).toISOString();
}

async function receiveMedia(req,path,size,type) {
  let firstBytes = Buffer.alloc(0);
  let received = 0;
  const check = new Transform({
    transform(chunk,encoding,done) {
      received += chunk.length;
      if (firstBytes.length < 12) firstBytes = Buffer.concat([firstBytes,chunk.subarray(0,12 - firstBytes.length)]);
      done(null,chunk);
    },
  });
  await pipeline(req,check,createWriteStream(path,{ flags:'wx',mode:0o600 }));
  const valid = type === 'video/mp4' ? hasMp4Header(firstBytes) : imageType(firstBytes) === type;
  if (received !== size || !valid) throw new InputError(400,'محتوى الملف ما كيطابقش الصيغة المختارة.');
}

async function publishJob(job,destinations,media) {
  const {providers,buffer} = runtime;
  try {
    await Promise.allSettled(destinations.map(async (target,index) => {
      const update = changes => {
        Object.assign(job.results[index],changes);
        save();
      };
      update({status:media ? 'uploading' : 'processing'});
      let result;
      try {
        const post = {...job,caption:captionFor(target.platform,job.caption,job.captions)};
        if (BUFFER_PLATFORMS.includes(target.platform)) {
          result = await buffer.publish(target,post,media,update);
        } else if (target.platform === 'instagram' && job.kind === 'image') {
          result = await buffer.withTemporaryImage(media,update,url => providers.publish(target,post,{...media,url},update));
        } else {
          result = await providers.publish(target,post,media,update);
        }
      } catch {
        result = {status:'unknown',note:'التطبيق ما قدرش يتأكد من النتيجة. راجع المنصة قبل ما تعاود.'};
      }
      update(result);
    }));
  } finally {
    activeJobs.delete(job.id);
    if (media) rmSync(media.path,{force:true});
  }
}

function startPublication(job,destinations,path,size) {
  activeJobs.add(job.id);
  const media = path ? {path,size,type:job.mediaType || 'video/mp4'} : null;
  void publishJob(job,destinations,media).catch(() => {
    process.stderr.write('ReelDesk could not complete local job cleanup.\n');
  });
}

function replaceScheduledJob(job,results) {
  const updated = {...job,schedulePending:false,results};
  const next = {...state,jobs:state.jobs.map(item => item.id === job.id ? updated : item)};
  save(next);
  state = next;
  return updated;
}

function finishSchedule(job,status,note) {
  replaceScheduledJob(job,job.results.map(result => ({...result,status,note})));
  const path = mediaPath(job);
  if (path) rmSync(path,{force:true});
}

function runSchedule() {
  const now = Date.now();
  const dueJobs = state.jobs.filter(job => job.schedulePending && Date.parse(job.scheduledAt) <= now);
  dueJobs.sort((first,second) => Date.parse(first.scheduledAt) - Date.parse(second.scheduledAt));
  for (const job of dueJobs) {
    if (now - Date.parse(job.scheduledAt) > maxScheduleDelay) {
      finishSchedule(job,'missed','فات الموعد. برمج المنشور من جديد.');
      continue;
    }
    if (activeJobs.size + receiving.size >= maxActive) break;
    const available = new Map(availableTargets().map(target => [target.id,target]));
    const destinations = job.targetIds.map(id => available.get(id));
    if (destinations.some(target => !target)) {
      finishSchedule(job,'failed','شي حساب من الحسابات المختارة تفصل. راجع الربط وبرمج المنشور من جديد.');
      continue;
    }
    if (destinations.some(target => !supportsKind(target.platform,job.kind || 'video',runtime.configured.cloudMedia))) {
      finishSchedule(job,'failed','الإعدادات تبدلات وهاد النوع ديال المنشور ما بقاش متاح للحساب المختار.');
      continue;
    }
    const path = mediaPath(job);
    let size;
    if (path) {
      try { size = statSync(path).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (size !== (job.mediaSize ?? job.videoSize)) {
        finishSchedule(job,'failed','الملف ديال المنشور تبدّل أو تحيد.');
        continue;
      }
    }
    const ready = replaceScheduledJob(job,job.results.map(result => ({...result,status:'queued'})));
    startPublication(ready,destinations,path,size);
  }
}

function cancelSchedule(id,res) {
  const job = state.jobs.find(item => item.id === id);
  if (!job?.schedulePending) throw new InputError(409,'هاد المنشور ما بقاش مبرمج.');
  finishSchedule(job,'cancelled','تلغى الموعد قبل النشر.');
  return json(res,200,{id});
}

async function reschedule(id,req,res) {
  const length = Number(req.headers['content-length']);
  if (req.headers['content-type'] !== 'application/json' || !Number.isInteger(length) || length < 2 || length > 512) {
    throw new InputError(400,'طلب تعديل الموعد غير صالح.');
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
  if (typeof data?.previousScheduledAt !== 'string') throw new InputError(400,'طلب تعديل الموعد غير صالح.');
  const job = state.jobs.find(item => item.id === id);
  if (!job?.schedulePending || Date.parse(job.scheduledAt) <= Date.now()) {
    throw new InputError(409,'هاد الموعد ما بقاش قابل للتعديل. راجع السجل.');
  }
  if (job.scheduledAt !== data.previousScheduledAt) throw new InputError(409,'الموعد تبدّل. افتحو من جديد باش تعدّلو.');
  const scheduledAt = futureTime(data.scheduledAt);
  const next = {...state,jobs:state.jobs.map(item => item.id === id ? {...job,scheduledAt} : item)};
  save(next);
  state = next;
  return json(res,200,{id,scheduledAt});
}

async function createJob(req,res) {
  const post = parsePost(req);
  const existing = state.jobs.find(job => job.id === post.id);
  if (existing) {
    req.resume();
    return json(res,200,{id:existing.id,scheduledAt:existing.scheduledAt});
  }
  if (receiving.has(post.id)) throw new InputError(409,'هاد الفيديو راه كيترفع. شوف السجل قبل ما تعاود.');
  if (receiving.size + activeJobs.size >= maxActive) throw new InputError(429,'كاينين طلبات كيتعالجو. تسنّى شوية.');
  const kind = post.kind ?? 'video';
  const type = req.headers['content-type'];
  const size = Number(req.headers['content-length'] ?? 0);
  if (kind === 'text' && (size !== 0 || req.headers['transfer-encoding'])) {
    throw new InputError(400,'النص ما خاصوش ملف.');
  }
  if (kind === 'image' && (!Object.hasOwn(IMAGE_TYPES,type) || !Number.isSafeInteger(size) || size < 8 || size > MAX_IMAGE_BYTES)) {
    throw new InputError(400,'اختار JPG ولا PNG بحجم حتى لـ 8 MB.');
  }
  if (kind === 'video' && (type !== 'video/mp4' || !Number.isSafeInteger(size) || size < 12 || size > MAX_BYTES)) {
    throw new InputError(400,'اختار MP4 صالح وحجمو حتى لـ 100 MB.');
  }
  const {job,destinations} = validatePost(post,type,size);
  const path = mediaPath(job);
  receiving.add(job.id);
  try {
    if (path) await receiveMedia(req,path,size,type);
    if (job.schedulePending) {
      if (Date.parse(job.scheduledAt) <= Date.now()) throw new InputError(400,'فات موعد النشر. اختار وقت جديد.');
      if (state.jobs.filter(item => item.schedulePending).length >= maxScheduled) {
        throw new InputError(409,'وصلتي لـ 10 منشورات مبرمجة. لغِ واحد أو تسنّى حتى ينزل.');
      }
      job.targetIds = destinations.map(target => target.id);
      if (path) job.mediaSize = size;
    }
    job.createdAt = new Date().toISOString();
    job.results = destinations.map(target => ({platform:target.platform,name:target.name,status:job.schedulePending ? 'scheduled' : 'queued'}));
    const jobs = [job,...state.jobs].filter((item,index) => index < 75 || item.schedulePending || activeJobs.has(item.id));
    const next = {...state,jobs};
    save(next);
    state = next;
    if (!job.schedulePending) startPublication(job,destinations,path,size);
    json(res,202,{id:job.id,scheduledAt:job.scheduledAt});
  } catch (error) {
    if (path) rmSync(path,{force:true});
    throw error;
  } finally {
    receiving.delete(job.id);
  }
}

async function connectBuffer(res) {
  const {configured,buffer,bufferFingerprint} = runtime;
  if (!configured.tiktok) throw new InputError(409,'الربط عبر Buffer كيتفعّل من طرف مدير AZMORY.');
  if (connecting.has('tiktok')) throw new InputError(409,'كاين ربط قيد المعالجة.');
  connecting.add('tiktok');
  try {
    let channels;
    try { channels = await buffer.discover(); }
    catch { throw new InputError(502,'تعذّر الاتصال بـ Buffer. راجع المفتاح والحساب.'); }
    state.connections.tiktok = { channels,fingerprint:bufferFingerprint };
    save();
    return json(res,200,{ count:channels.length });
  } finally {
    connecting.delete('tiktok');
  }
}

function disconnectYouTube(channelId,res) {
  if (activeJobs.size || receiving.size || connecting.has('youtube')) {
    throw new InputError(409,'تسنّى حتى يكملو الطلبات اللي كيتعالجو.');
  }
  const channels = state.connections.youtube || [];
  const youtube = channels.filter(item => item.channel.id !== channelId);
  if (youtube.length === channels.length) throw new InputError(404,'هاد القناة ما بقاش الربط ديالها موجود.');
  if (state.jobs.some(job => job.schedulePending && job.targetIds.includes('youtube:' + channelId))) {
    throw new InputError(409,'كاين موعد بهاد القناة. تسنّى حتى يكمل أو لغِ الموعد قبل فصلها.');
  }
  const next = {...state,connections:{...state.connections,youtube}};
  save(next);
  state = next;
  return json(res,200,{ok:true});
}

function bufferCheckable(item,kind) {
  return Boolean(item && BUFFER_PLATFORMS.includes(item.platform) && ['submitted','unknown'].includes(item.status) &&
    item.ref && (item.staging || kind === 'text'));
}

async function checkBuffer(jobId,index,res) {
  const {configured,buffer} = runtime;
  if (!configured.tiktok) throw new InputError(409,'راجع إعدادات Buffer وCloudinary.');
  if (activeJobs.has(jobId) || checkingBuffer.has(jobId)) throw new InputError(409,'تسنّى شوية. الحالة كيتحقق منها دابا.');
  const job = state.jobs.find(item => item.id === jobId);
  const result = index === undefined
    ? job?.results.find(item => item.platform === 'tiktok' && bufferCheckable(item,job.kind))
    : job?.results[index];
  if (!bufferCheckable(result,job?.kind)) throw new InputError(404,'ما كايناش حالة Buffer قابلة للتحديث لهاد الحساب.');
  checkingBuffer.add(jobId);
  try {
    Object.assign(result,await buffer.readStatus(result.ref,result.staging,result.platform,job.kind === 'image' ? 'image' : 'video'));
    save();
    return json(res,200,{ ok:true });
  } catch {
    throw new InputError(502,'تعذّر تحديث الحالة من Buffer. تقدر تعاود التحقق من بعد.');
  } finally {
    checkingBuffer.delete(jobId);
  }
}

async function route(req,res) {
  securityHeaders(res);
  if (!hosts.has(req.headers.host)) throw new InputError(403,'استعمل العنوان المحلي ديال التطبيق.');
  const fetchSite = req.headers['sec-fetch-site'];
  const url = new URL(req.url,base);
  if (url.origin !== base) throw new InputError(400,'عنوان غير صالح.');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    return res.end(html);
  }
  if (req.method === 'GET' && url.pathname === '/preflight.cjs') {
    res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});
    return res.end(preflightJs);
  }
  const callback = url.pathname.match(/^\/oauth\/(meta|youtube)$/);
  if (req.method === 'GET' && callback) return completeOAuth(callback[1],url,res);
  if (fetchSite && !['same-origin','none'].includes(fetchSite)) throw new InputError(403,'طلب خارجي مرفوض.');
  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    const {configured,bufferFingerprint} = runtime;
    return json(res,200,{
      key,configured,
      linked:{ meta:Boolean(state.connections.meta), youtube:Boolean(state.connections.youtube?.length), tiktok:state.connections.tiktok?.fingerprint === bufferFingerprint },
      targets:availableTargets().map(({ id,platform,name }) => ({ id,platform,name })),
    });
  }
  if (!authorized(req)) throw new InputError(403,'حدّث صفحة التطبيق وعاود.');
  if (req.method !== 'GET' && !origins.has(req.headers.origin)) throw new InputError(403,'طلب خارجي مرفوض.');
  const channel = url.pathname.match(/^\/api\/connect\/youtube\/([A-Za-z0-9_-]{1,120})$/);
  if (channel && req.method === 'DELETE') return disconnectYouTube(channel[1],res);
  const connect = url.pathname.match(/^\/api\/connect\/(meta|youtube|tiktok|buffer)$/);
  const provider = connect?.[1] === 'buffer' ? 'tiktok' : connect?.[1];
  if (provider && req.method === 'POST') return provider === 'tiktok' ? connectBuffer(res) : beginOAuth(provider,res);
  if (provider && req.method === 'DELETE') {
    if (activeJobs.size || receiving.size || connecting.has(provider)) throw new InputError(409,'تسنّى حتى يساليو الطلبات اللي كيتعالجو.');
    for (const [id,entry] of oauthStates) if (entry.provider === provider) oauthStates.delete(id);
    delete state.connections[provider];
    save();
    return json(res,200,{ ok:true });
  }
  if (url.pathname === '/api/jobs' && req.method === 'GET') {
    return json(res,200,state.jobs.map(({id,kind = 'video',title,createdAt,scheduledAt,schedulePending,results}) => ({
      id,kind,title,createdAt,scheduledAt,schedulePending,results:results.map(item => {
        const {staging,...result} = item;
        return {...result,checkable:bufferCheckable(item,kind) && !activeJobs.has(id)};
      }),
    })));
  }
  if (url.pathname === '/api/jobs' && req.method === 'POST') return createJob(req,res);
  const scheduled = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/schedule$/);
  if (scheduled && req.method === 'DELETE') return cancelSchedule(scheduled[1],res);
  if (scheduled && req.method === 'PATCH') return reschedule(scheduled[1],req,res);
  const statusCheck = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/(?:tiktok|buffer\/(\d{1,2}))$/);
  if (statusCheck && req.method === 'POST') return checkBuffer(statusCheck[1],statusCheck[2] === undefined ? undefined : Number(statusCheck[2]),res);
  throw new InputError(404,'هاد الصفحة ما كايناش.');
}

const server = createServer({ maxHeaderSize:98304, requestTimeout:300000 },(req,res) => {
  route(req,res).catch(error => {
    if (res.headersSent || res.destroyed) return;
    req.resume();
    json(res,error.status || 500,{ error:error.status ? error.message : 'وقع مشكل فالسيرفر المحلي.' });
    if (!error.status) process.stderr.write('ReelDesk could not complete a local request.\n');
  });
});
server.on('error',error => {
  if (error.code === 'EADDRINUSE') {
    process.stderr.write('Port ' + port + ' is already in use. Check ' + base + '/ in Chrome. If an older AZMORY or ReelDesk window is running, close it and retry.\n');
  } else {
    process.stderr.write('ReelDesk could not start: ' + error.code + '\n');
  }
  process.exitCode = 1;
});
server.listen(port,'127.0.0.1',() => {
  try { initialize(); }
  catch (error) {
    process.stderr.write('ReelDesk could not open local data: ' + (error.code || error.name) + '\n');
    server.close();
    process.exitCode = 1;
    return;
  }
  setInterval(() => {
    try { runSchedule(); }
    catch { process.stderr.write('ReelDesk could not process the schedule.\n'); }
  },1000).unref();
  process.stdout.write('AZMORY v0.9 is running.\nOpen in Chrome: ' + base + '/\nKeep this window open while you use AZMORY.\n');
  if (process.platform === 'win32' && process.argv.includes('--open')) {
    exec('start "" ' + base + '/', {windowsHide:true}, error => {
      if (error) process.stderr.write('Browser did not open automatically. Use the Chrome address above.\n');
    });
  }
});
