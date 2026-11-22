import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBufferPublisher } from '../buffer-publisher.mjs';

const settings = {bufferKey:'buffer-secret',cloudName:'reeldesk-test',cloudKey:'cloud-key',cloudSecret:'cloud-secret'};
const result = data => Response.json({data});

function verifySignature(entries) {
  const params = new URLSearchParams(entries);
  const provided = params.get('signature');
  params.delete('signature');
  params.delete('api_key');
  params.delete('file');
  params.sort();
  const raw = [...params].map(([key,value]) => key + '=' + value).join('&');
  assert.equal(provided,createHash('sha256').update(raw + settings.cloudSecret).digest('hex'));
}

test('Buffer discovery lists connected video channels and skips locked or unsupported channels',async () => {
  const api = createBufferPublisher(settings,async (_url,options) => {
    assert.equal(options.headers.Authorization,'Bearer buffer-secret');
    const body = JSON.parse(options.body);
    if (!body.variables) return result({account:{organizations:[{id:'org1',name:'Studio'}]}});
    assert.equal(body.variables.organization,'org1');
    return result({channels:[
      {id:'ready',service:'tiktok',name:'@ready',isDisconnected:false,isLocked:false},
      {id:'closed',service:'tiktok',name:'@closed',isDisconnected:true,isLocked:false},
      {id:'thread-account',service:'threads',name:'Creator'},
      {id:'work-account',service:'linkedin',name:'My company'},
      {id:'sky-account',service:'bluesky',name:'Sky account'},
      {id:'locked',service:'threads',name:'Locked',isLocked:true},
      {id:'other',service:'youtube',name:'other'},
    ]});
  });
  assert.equal(api.configured,true);
  assert.deepEqual(await api.discover(),[
    {id:'ready',platform:'tiktok',name:'@ready · Studio'},
    {id:'thread-account',platform:'threads',name:'Creator · Studio'},
    {id:'work-account',platform:'linkedin',name:'My company · Studio'},
    {id:'sky-account',platform:'bluesky',name:'Sky account · Studio'},
  ]);
});

test('TikTok stages a protected video, shares once, waits for confirmation and removes the temporary copy',async t => {
  const directory = await mkdtemp(join(tmpdir(),'reeldesk-tiktok-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const path = join(directory,'test.mp4');
  const bytes = Buffer.from('....ftyp....');
  await writeFile(path,bytes);
  const job = {id:randomUUID(),title:'فيديو',caption:'وصف',tiktokAi:true};
  const ref = 'buffer-post';
  let stagedId;
  const calls = [];
  const api = createBufferPublisher(settings,async (input,options) => {
    const url = new URL(input);
    assert.equal(options.redirect,'error');
    if (url.pathname.endsWith('/upload')) {
      calls.push('upload');
      assert.equal(options.body.get('type'),'authenticated');
      verifySignature(options.body);
      assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()),bytes);
      stagedId = options.body.get('public_id');
      assert.match(stagedId,/^reeldesk-[a-f0-9-]{36}$/);
      return Response.json({public_id:stagedId});
    }
    if (url.pathname.endsWith('/destroy')) {
      calls.push('destroy');
      assert.equal(options.body.get('public_id'),stagedId);
      verifySignature(options.body);
      return Response.json({result:'ok'});
    }
    const request = JSON.parse(options.body);
    if (request.variables.input) {
      calls.push('create');
      const post = request.variables.input;
      assert.equal(post.channelId,'my-channel');
      assert.equal(post.mode,'shareNow');
      assert.equal(post.schedulingType,'automatic');
      assert.equal(post.metadata.tiktok.isAiGenerated,true);
      const download = new URL(post.assets[0].video.url);
      assert.equal(download.hostname,'api.cloudinary.com');
      assert.equal(download.searchParams.get('type'),'authenticated');
      assert.equal(download.searchParams.get('public_id'),stagedId);
      assert.equal(Number(download.searchParams.get('expires_at')) - Number(download.searchParams.get('timestamp')),3600);
      verifySignature(download.searchParams);
      assert.doesNotMatch(JSON.stringify(request),/cloud-secret/);
      return result({createPost:{post:{id:ref,status:'sending'}}});
    }
    calls.push('status');
    assert.equal(request.variables.id,ref);
    return result({post:{id:ref,status:'sent',externalLink:'https://www.tiktok.com/@creator/video/123'}});
  },async () => {});
  const updates = [];
  const done = await api.publish({accountId:'my-channel',platform:'tiktok'},job,{path},patch => updates.push(patch));
  assert.deepEqual(calls,['upload','create','status','destroy']);
  assert.ok(updates.some(patch => patch.status === 'submitted'));
  assert.equal(done.status,'published');
  assert.equal(done.staging,null);
  assert.equal(done.url,'https://www.tiktok.com/@creator/video/123');
});

test('an ambiguous Buffer response is left for review without a second post or deleting the pending video',async t => {
  const directory = await mkdtemp(join(tmpdir(),'reeldesk-tiktok-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const path = join(directory,'test.mp4');
  await writeFile(path,'....ftyp....');
  const id = randomUUID();
  const calls = [];
  let stagedId;
  const api = createBufferPublisher(settings,async (input,options) => {
    const url = new URL(input);
    calls.push(url.hostname);
    if (url.pathname.endsWith('/upload')) {
      stagedId = options.body.get('public_id');
      return Response.json({public_id:stagedId});
    }
    throw new Error('response lost');
  },async () => {});
  const outcome = await api.publish({accountId:'my-channel',platform:'tiktok'},{id,title:'Test'},{path},() => {});
  assert.equal(outcome.status,'unknown');
  assert.deepEqual(calls,['api.cloudinary.com','api.buffer.com']);
  assert.equal(outcome.staging,stagedId);
});

test('new destinations publish independently and each cleans its own staged asset',async t => {
  const directory = await mkdtemp(join(tmpdir(),'azmory-buffer-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const path = join(directory,'test.mp4');
  await writeFile(path,'....ftyp....');
  const staged = new Set();
  const cleaned = new Set();
  const links = {
    threads:'https://www.threads.com/@creator/post/Example',
    linkedin:'https://www.linkedin.com/feed/update/urn:li:activity:123',
    bluesky:'https://bsky.app/profile/creator.bsky.social/post/example',
  };
  const api = createBufferPublisher(settings,async (input,options) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/upload')) {
      const publicId = options.body.get('public_id');
      assert.ok(!staged.has(publicId));
      staged.add(publicId);
      return Response.json({public_id:publicId});
    }
    if (url.pathname.endsWith('/destroy')) {
      const publicId = options.body.get('public_id');
      assert.ok(staged.has(publicId));
      cleaned.add(publicId);
      return Response.json({result:'ok'});
    }
    const {variables:{input:post}} = JSON.parse(options.body);
    const source = new URL(post.assets[0].video.url);
    verifySignature(source.searchParams);
    assert.equal(post.text,'caption ' + post.channelId);
    assert.equal(post.metadata,undefined);
    assert.equal(post.mode,'shareNow');
    return result({createPost:{post:{id:'post-' + post.channelId,status:'sent',externalLink:links[post.channelId]}}});
  });
  const id = randomUUID();
  const outcomes = await Promise.all(Object.keys(links).map(platform => api.publish(
    {platform,accountId:platform},{id,title:'Video',caption:'caption ' + platform},{path},() => {},
  )));
  assert.equal(staged.size,3);
  assert.deepEqual(cleaned,staged);
  assert.deepEqual(outcomes.map(item => item.status),['published','published','published']);
  assert.deepEqual(outcomes.map(item => item.url),Object.values(links));
});
