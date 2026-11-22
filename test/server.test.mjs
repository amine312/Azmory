import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('local dashboard, one-click OAuth, scheduling, cancellation and restart',async t => {
  const directory = await mkdtemp(join(tmpdir(),'reeldesk-server-'));
  const source = fileURLToPath(new URL('../',import.meta.url));
  for (const file of ['server.mjs','providers.mjs','buffer-publisher.mjs','public']) await cp(join(source,file),join(directory,file),{recursive:true});
  const port = 30000 + Math.floor(Math.random() * 25000);
  const root = 'http://127.0.0.1:' + port;
  const db = join(directory,'.reeldesk-data');
  await mkdir(join(db,'uploads'),{recursive:true});
  const jobId = randomUUID();
  await writeFile(join(db,'uploads',jobId + '.mp4'),'stale');
  const lateId = randomUUID();
  const bufferJobId = randomUUID();
  const bytes = Buffer.from('....ftyp....');
  await writeFile(join(db,'uploads',lateId + '.mp4'),bytes);
  const destination = {platform:'youtube',name:'My channel'};
  const createdAt = new Date().toISOString();
  await writeFile(join(db,'state.json'),JSON.stringify({
    settings:{GOOGLE_CLIENT_ID:'demo-app',GOOGLE_CLIENT_SECRET:'demo-secret'},
    connections:{
      youtube:{channel:{id:'one-channel',name:'My channel'},refreshToken:'secret-token'},
      tiktok:{channels:[{id:'old',name:'TikTok from 0.6'}],fingerprint:createHash('sha256').update('buffer-key').digest('hex')},
    },
    jobs:[
      {id:jobId,title:'Interrupted',createdAt,results:[{...destination,status:'uploading'}]},
      {id:lateId,title:'Past schedule',createdAt,scheduledAt:new Date(Date.now()-60000).toISOString(),schedulePending:true,results:[{...destination,status:'scheduled'}]},
      {id:bufferJobId,title:'Pending Bluesky',createdAt,results:[
        {platform:'linkedin',name:'Work',status:'published'},
        {platform:'bluesky',name:'Sky',status:'submitted',ref:'sky-post',staging:'reeldesk-' + bufferJobId},
      ]},
    ],
  }));
  const uploads = join(directory,'mock-uploads.txt');
  const descriptions = join(directory,'mock-descriptions.txt');
  const selectedChannels = join(directory,'mock-youtube-channels.txt');
  await writeFile(join(directory,'mock.mjs'),`
    import { appendFile } from 'node:fs/promises';
    globalThis.fetch = async (url, options) => {
      const endpoint = new URL(url);
      if (endpoint.hostname === 'api.cloudinary.com') {
        if (endpoint.pathname.endsWith('/destroy')) return Response.json({result:'ok'});
        return Response.json({public_id:options.body.get('public_id')});
      }
      if (endpoint.hostname === 'api.buffer.com') {
        const payload = JSON.parse(options.body);
        const data = result => Response.json({data:result});
        if (!payload.variables) return data({account:{organizations:[{id:'azmory',name:'Studio'}]}});
        if (payload.variables.organization) return data({channels:[
          {id:'old',service:'tiktok',name:'TikTok'},
          {id:'second',service:'tiktok',name:'TikTok Studio'},
          {id:'new',service:'threads',name:'Threads'},
          {id:'sky',service:'bluesky',name:'Bluesky'},
        ]});
        if (['old','second'].includes(payload.variables.input?.channelId)) {
          const post = payload.variables.input;
          if (post.metadata.tiktok.isAiGenerated !== true) throw new Error('Missing AI disclosure');
          const number = post.channelId === 'old' ? 100 : 200;
          return data({createPost:{post:{id:'tt-' + number,status:'sent',externalLink:'https://www.tiktok.com/@demo/video/' + number}}});
        }
        if (payload.variables.input?.text === 'نص بوحدو' && payload.variables.input.assets.length === 0) {
          return data({createPost:{post:{id:'text-post',status:'sent'}}});
        }
        if (payload.variables.input?.text === 'صورة' && payload.variables.input.assets[0]?.image?.url.includes('/image/download')) {
          return data({createPost:{post:{id:'image-post',status:'sent'}}});
        }
        if (payload.variables.id === 'sky-post') return data({post:{id:'sky-post',status:'sent',externalLink:'https://bsky.app/profile/studio.bsky.social/post/example'}});
        if (payload.variables.input?.channelId === 'new' && payload.variables.input.text === 'وصف Threads') {
          return data({createPost:{post:{id:'threads-post',status:'sent',externalLink:'https://www.threads.com/@creator/post/Example'}}});
        }
      }
      if (endpoint.hostname === 'oauth2.googleapis.com') {
        const id = options.body.get('code') || options.body.get('refresh_token');
        const channel = id === 'secret-token' ? 'one-channel' : id;
        return Response.json({access_token:channel,refresh_token:channel});
      }
      if (endpoint.pathname === '/youtube/v3/channels') {
        const id = options.headers.Authorization.slice('Bearer '.length);
        return Response.json({items:[{id,snippet:{title:id === 'one-channel' ? 'My channel' : id}}]});
      }
      if (endpoint.pathname === '/upload/youtube/v3/videos' && options.method === 'POST') {
        await appendFile(${JSON.stringify(selectedChannels)},options.headers.Authorization.slice('Bearer '.length) + '\\n');
        await appendFile(${JSON.stringify(descriptions)},JSON.parse(options.body).snippet.description);
        return new Response(null,{headers:{Location:'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test'}});
      }
      if (endpoint.searchParams.get('upload_id') === 'test') {
        const parts = [];
        for await (const part of options.body) parts.push(part);
        await appendFile(${JSON.stringify(uploads)},Buffer.concat(parts).toString() + '\\n');
        return Response.json({id:'AbCdEf12345'});
      }
      if (endpoint.pathname === '/youtube/v3/videos') {
        return Response.json({items:[{status:{uploadStatus:'processed',privacyStatus:'private'}}]});
      }
      throw new Error('Unexpected call: ' + endpoint.hostname);
    };
  `);
  let child;
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child,'exit');
      child.kill();
      await closed;
    }
  }
  async function start() {
    child = spawn(process.execPath,['--import',pathToFileURL(join(directory,'mock.mjs')).href,join(directory,'server.mjs')],{
      env:{...process.env,REELDESK_PORT:String(port),GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',META_APP_ID:'',META_APP_SECRET:'',META_CONFIG_ID:'',BUFFER_API_KEY:'buffer-key',CLOUDINARY_CLOUD_NAME:'azmory-test',CLOUDINARY_API_KEY:'cloud-key',CLOUDINARY_API_SECRET:'cloud-secret'},
      stdio:['ignore','pipe','pipe'],
    });
    let errors = '';
    child.stderr.on('data',part => { errors += part; });
    await Promise.race([
      once(child.stdout,'data',{signal:AbortSignal.timeout(5000)}),
      once(child,'exit',{signal:AbortSignal.timeout(5000)}).then(([code]) => { throw new Error('server exited: ' + code + ' ' + errors); }),
    ]);
    return (await (await fetch(root + '/api/bootstrap')).json()).key;
  }
  t.after(async () => { await stop(); await rm(directory,{recursive:true,force:true}); });
  await start();
  const home = await fetch(root);
  assert.equal(home.status,200);
  const html = await home.text();
  assert.match(html,/AZMORY/);
  assert.match(html,/preflightList/);
  const clientScript = await fetch(root + '/preflight.cjs');
  assert.equal(clientScript.status,200);
  assert.match(clientScript.headers.get('content-type'),/javascript/);
  assert.match(await clientScript.text(),/AzmoryPreflight/);
  assert.match(html,/plannerList/);
  assert.doesNotMatch(html,/Client Secret|setupList/);
  assert.match(home.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const response = await fetch(root + '/api/bootstrap');
  const boot = await response.json();
  assert.equal(boot.targets[0].name,'My channel');
  assert.deepEqual(boot.targets[1],{id:'tiktok:old',name:'TikTok from 0.6',platform:'tiktok'});
  assert.doesNotMatch(JSON.stringify(boot),/secret-token/);
  assert.equal((await fetch(root + '/api/bootstrap',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await fetch(root + '/api/jobs')).status,403);
  let headers = {'X-ReelDesk-Key':boot.key,Origin:root};
  const list = async () => (await fetch(root + '/api/jobs',{headers})).json();
  const history = await (await fetch(root + '/api/jobs',{headers})).json();
  assert.equal(history[0].results[0].status,'unknown');
  assert.equal(history.find(job => job.id === lateId).results[0].status,'missed');
  await assert.rejects(readFile(join(db,'uploads',lateId + '.mp4')),{code:'ENOENT'});
  await assert.rejects(readFile(join(db,'uploads',jobId + '.mp4')), { code:'ENOENT' });
  async function linkYouTube(code) {
    const consent = await fetch(root + '/api/connect/youtube',{method:'POST',headers});
    assert.equal(consent.status,200);
    const url = new URL((await consent.json()).url);
    assert.equal(url.hostname,'accounts.google.com');
    const callback = new URL('/oauth/youtube',root);
    callback.search = new URLSearchParams({state:url.searchParams.get('state'),code});
    const linked = await fetch(callback,{redirect:'manual'});
    assert.match(linked.headers.get('location'),/notice=youtube_ok/);
  }
  for (let index = 2; index <= 10; index++) await linkYouTube('channel-' + index);
  await linkYouTube('channel-2');
  const linkedChannels = (await (await fetch(root + '/api/bootstrap')).json()).targets.filter(item => item.platform === 'youtube');
  assert.equal(linkedChannels.length,10);
  assert.equal(linkedChannels[0].id,'youtube:one-channel');
  assert.equal(linkedChannels[1].id,'youtube:channel-2');
  const invalid = await fetch(root + '/oauth/youtube?state=invalid&code=bogus',{redirect:'manual'});
  assert.match(invalid.headers.get('location'),/notice=denied/);
  assert.equal((await fetch(root + '/api/connect/youtube',{method:'DELETE',headers:{...headers,Origin:'https://outside.example'}})).status,403);
  const post = {id:randomUUID(),title:'Test',caption:'',targets:[boot.targets[0].id],privacy:'private',kids:'no',consent:true,duration:5,width:1080,height:1920};
  const rejected = await fetch(root + '/api/jobs',{
    method:'POST',headers:{...headers,'Content-Type':'video/mp4','X-ReelDesk-Post':encodeURIComponent(JSON.stringify(post))},
    body:Buffer.from('not a valid mp4'),
  });
  assert.equal(rejected.status,400);
  await assert.rejects(readFile(join(db,'uploads',post.id + '.mp4')), { code:'ENOENT' });
  assert.equal((await fetch(root + '/api/settings/youtube',{method:'PUT',headers})).status,404);
  assert.doesNotMatch(JSON.stringify(boot),/demo-app|demo-secret|GOOGLE_CLIENT_SECRET/);
  const upload = (data,encode = value => encodeURIComponent(value)) => fetch(root + '/api/jobs',{
    method:'POST',headers:{...headers,'Content-Type':'video/mp4','X-ReelDesk-Post':encode(JSON.stringify(data))},body:bytes,
  });
  const date = milliseconds => new Date(Date.now() + milliseconds).toISOString();
  assert.equal((await upload({...post,scheduledAt:date(-1000)})).status,400);
  const invalidVideo = await upload({...post,id:randomUUID(),width:1920,height:1080});
  assert.equal(invalidVideo.status,400);
  assert.match((await invalidVideo.json()).error,/Short/);
  assert.equal((await upload({...post,id:randomUUID(),captions:{youtube:'✨'.repeat(1800)}})).status,400);
  assert.equal((await upload({...post,id:randomUUID(),captions:{invalid:'description'}})).status,400);
  const future = {...post,id:randomUUID(),scheduledAt:date(20*60*1000)};
  assert.equal((await upload(future)).status,202);
  assert.equal((await upload(future)).status,200);
  assert.equal((await fetch(root + '/api/connect/youtube/one-channel',{method:'DELETE',headers})).status,409);
  assert.equal((await list()).filter(job => job.id === future.id).length,1);
  const move = (job,scheduledAt,previousScheduledAt = job.scheduledAt) => fetch(root + '/api/jobs/' + job.id + '/schedule',{
    method:'PATCH',headers:{...headers,'Content-Type':'application/json'},
    body:JSON.stringify({scheduledAt,previousScheduledAt}),
  });
  assert.equal((await move(future,date(-1000))).status,400);
  assert.equal((await move(future,date(31*24*60*60*1000))).status,400);
  const movedAt = date(40*60*1000);
  const moved = await move(future,movedAt);
  assert.equal(moved.status,200);
  assert.equal((await moved.json()).scheduledAt,movedAt);
  assert.equal((await move(future,date(30*60*1000))).status,409);
  await assert.rejects(readFile(uploads),{code:'ENOENT'});
  await stop();
  headers = {...headers,'X-ReelDesk-Key':await start()};
  const afterRestart = (await (await fetch(root + '/api/bootstrap')).json()).targets.filter(item => item.platform === 'youtube');
  assert.deepEqual(afterRestart,linkedChannels);
  const pending = (await list()).find(job => job.id === future.id);
  assert.equal(pending.schedulePending,true);
  assert.equal(pending.scheduledAt,movedAt);
  assert.deepEqual(await readFile(join(db,'uploads',future.id + '.mp4')),bytes);
  assert.equal((await fetch(root + '/api/jobs/' + future.id + '/schedule',{method:'DELETE',headers})).status,200);
  assert.equal((await list()).find(job => job.id === future.id).results[0].status,'cancelled');
  assert.equal((await move(future,date(50*60*1000),movedAt)).status,409);
  await assert.rejects(readFile(join(db,'uploads',future.id + '.mp4')),{code:'ENOENT'});
  const soon = {...post,id:randomUUID(),caption:'Common caption',captions:{youtube:'الوصف الخاص بيوتيوب'},scheduledAt:date(20*60*1000)};
  const base64 = value => 'b64:' + Buffer.from(value).toString('base64');
  assert.equal((await upload(soon,base64)).status,202);
  assert.equal((await move(soon,date(1300))).status,200);
  let sent;
  for (let attempt=0;attempt<25;attempt++) {
    sent = (await list()).find(job => job.id === soon.id);
    if (sent.results[0].status === 'uploaded') break;
    await wait(200);
  }
  assert.equal(sent.schedulePending,false);
  assert.equal(sent.results[0].status,'uploaded');
  assert.equal(await readFile(uploads,'utf8'),bytes.toString() + '\n');
  assert.equal(await readFile(descriptions,'utf8'),'الوصف الخاص بيوتيوب');
  assert.equal((await upload(soon,base64)).status,200);
  assert.equal(await readFile(uploads,'utf8'),bytes.toString() + '\n');
  const bufferResponse = await fetch(root + '/api/connect/buffer',{method:'POST',headers});
  assert.equal((await bufferResponse.json()).count,4);
  const channels = (await (await fetch(root + '/api/bootstrap')).json()).targets;
  assert.deepEqual(channels.slice(10).map(item => item.platform),['tiktok','tiktok','threads','bluesky']);
  const multiple = {...post,id:randomUUID(),targets:['youtube:one-channel','youtube:channel-2','tiktok:old','tiktok:second'],tiktokAi:true,bufferTransfer:true};
  assert.equal((await upload(multiple)).status,202);
  let multiResults;
  for (let attempt = 0; attempt < 25; attempt++) {
    multiResults = (await list()).find(job => job.id === multiple.id).results;
    if (multiResults.slice(0,2).every(item => item.note?.includes('المعالجة')) &&
        multiResults.slice(2).every(item => item.status === 'published')) break;
    await wait(50);
  }
  assert.deepEqual(multiResults.map(item => item.status),['uploaded','uploaded','published','published']);
  assert.deepEqual(multiResults.slice(2).map(item => item.ref),['tt-100','tt-200']);
  assert.deepEqual((await readFile(selectedChannels,'utf8')).trim().split('\n').sort(),['channel-2','one-channel','one-channel']);
  const thread = {...post,id:randomUUID(),targets:['threads:new'],captions:{threads:'وصف Threads'}};
  assert.equal((await upload(thread)).status,400);
  assert.equal((await upload({...thread,tiktokTransfer:true})).status,400);
  assert.equal((await upload({...thread,bufferTransfer:true})).status,202);
  let threadResult;
  for (let attempt = 0; attempt < 25; attempt++) {
    threadResult = (await list()).find(job => job.id === thread.id).results[0];
    if (threadResult.status === 'published') break;
    await wait(50);
  }
  assert.equal(threadResult.status,'published');
  assert.match(threadResult.url,/^https:\/\/www\.threads\.com/);
  assert.equal((await fetch(root + '/api/jobs/' + bufferJobId + '/buffer/0',{method:'POST',headers})).status,404);
  assert.equal((await fetch(root + '/api/jobs/' + bufferJobId + '/buffer/1',{method:'POST',headers})).status,200);
  const refreshed = (await list()).find(job => job.id === bufferJobId);
  assert.equal(refreshed.results[1].status,'published');
  assert.equal(refreshed.results[1].checkable,false);
  const content = (job,body,type) => fetch(root + '/api/jobs',{
    method:'POST',headers:{...headers,'X-ReelDesk-Post':base64(JSON.stringify(job)),...(type && {'Content-Type':type})},body,
  });
  const textPost = {id:randomUUID(),kind:'text',caption:'نص بوحدو',consent:true,targets:['threads:new'],scheduledAt:date(20*60*1000)};
  const photo = {id:randomUUID(),kind:'image',caption:'صورة',consent:true,targets:['threads:new'],width:1080,height:1080,
    bufferTransfer:true,scheduledAt:date(20*60*1000)};
  const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  assert.equal((await content({...textPost,caption:''})).status,400);
  assert.equal((await content(textPost,bytes,'video/mp4')).status,400);
  assert.equal((await content({...textPost,targets:['tiktok:old']})).status,400);
  assert.equal((await content({...photo,bufferTransfer:false},png,'image/png')).status,400);
  assert.equal((await content(photo,bytes,'image/png')).status,400);
  assert.equal((await content(textPost)).status,202);
  assert.equal((await content(photo,png,'image/png')).status,202);
  await assert.rejects(readFile(join(db,'uploads',textPost.id + '.mp4')),{code:'ENOENT'});
  await stop();
  headers = {...headers,'X-ReelDesk-Key':await start()};
  assert.deepEqual(await readFile(join(db,'uploads',photo.id + '.png')),png);
  const due = date(1300);
  assert.equal((await move(textPost,due)).status,200);
  assert.equal((await move(photo,due)).status,200);
  let published;
  for (let attempt = 0; attempt < 25; attempt++) {
    published = (await list()).filter(job => [textPost.id,photo.id].includes(job.id));
    if (published.length === 2 && published.every(job => job.results[0].status === 'published')) break;
    await wait(150);
  }
  assert.deepEqual(published.map(job => [job.kind,job.results[0].ref]),[['image','image-post'],['text','text-post']]);
  await assert.rejects(readFile(join(db,'uploads',photo.id + '.png')),{code:'ENOENT'});
  assert.equal((await fetch(root + '/api/connect/buffer',{method:'DELETE',headers})).status,200);
  assert.equal((await fetch(root + '/api/connect/youtube/channel-2',{method:'DELETE',headers})).status,200);
  const remaining = (await (await fetch(root + '/api/bootstrap')).json()).targets;
  assert.deepEqual(remaining,linkedChannels.filter(item => item.id !== 'youtube:channel-2'));
  assert.equal((await fetch(root + '/api/connect/youtube/channel-2',{method:'DELETE',headers})).status,404);
  assert.equal((await fetch(root + '/api/connect/youtube',{method:'DELETE',headers})).status,200);
  const disconnected = await (await fetch(root + '/api/bootstrap')).json();
  assert.deepEqual(disconnected.targets,[]);
});
