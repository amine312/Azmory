import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviders } from '../providers.mjs';

const settings = {
  meta:{ id:'meta-app', secret:'fake-meta-secret', configId:'meta-config', version:'v25.0', redirect:'http://localhost:8787/oauth/meta' },
  youtube:{ id:'google-app', secret:'fake-google-secret', redirect:'http://127.0.0.1:8787/oauth/youtube' },
};
const job = { title:'فيديو',caption:'وصف',privacy:'private',kids:'no' };
const answer = (body,status = 200) => Response.json(body,{status});

async function fixture(t,handler) {
  const folder = await mkdtemp(join(tmpdir(),'reeldesk-video-'));
  t.after(() => rm(folder,{recursive:true,force:true}));
  const path = join(folder,'video.mp4');
  const bytes = Buffer.from('....ftyp....');
  await writeFile(path,bytes);
  const calls = [];
  const api = createProviders(settings, async (input,options) => {
    const url = new URL(input);
    calls.push([url.pathname,options.method || 'GET']);
    if (options.body?.[Symbol.asyncIterator]) {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks),bytes);
      assert.equal(options.headers['Content-Length'],String(bytes.length));
    }
    return handler(url,options);
  }, async () => {});
  return { api,video:{path,size:bytes.length},calls };
}

test('Meta consent uses configuration and discovers eligible Pages and linked Instagram accounts',async () => {
  const api = createProviders(settings,async (url,options) => {
    if (url.pathname.endsWith('/oauth/access_token')) {
      return answer({access_token:url.searchParams.has('code') ? 'short-token' : 'long-token'});
    }
    assert.equal(options.headers.Authorization,'Bearer long-token');
    if (url.pathname.endsWith('/me/permissions')) {
      return answer({data:['pages_show_list','pages_read_engagement','pages_manage_posts','instagram_basic','instagram_content_publish'].map(permission => ({permission,status:'granted'}))});
    }
    assert.match(url.searchParams.get('fields'),/instagram_business_account/);
    return answer({data:[
      { id:'1', name:'Page', access_token:'page-token', tasks:['CREATE_CONTENT'], instagram_business_account:{id:'2',username:'creator'} },
      { id:'3', name:'Read only', access_token:'other-token', tasks:['ANALYZE'] },
    ]});
  });
  const url = api.authorize('meta','state','');
  assert.equal(url.searchParams.get('config_id'),'meta-config');
  assert.equal(url.searchParams.get('redirect_uri'),settings.meta.redirect);
  const {pages} = await api.connectMeta('one-time-code');
  assert.equal(pages.length,1);
  assert.equal(pages[0].canPublishFacebook,true);
  assert.equal(pages[0].canPublishInstagram,true);
  assert.equal(pages[0].instagram.username,'creator');
});

test('Facebook uploads local bytes and requires publishing confirmation',async t => {
  const {api,video,calls} = await fixture(t,(url,options) => {
    if (url.hostname === 'rupload.facebook.com') {
      assert.equal(options.headers.Authorization,'OAuth page-token');
      return answer({success:true});
    }
    if (options.body?.get('upload_phase') === 'start') return answer({video_id:'123',upload_url:'https://rupload.facebook.com/video-upload/v25.0/123'});
    if (options.body?.get('upload_phase') === 'finish') {
      assert.equal(options.body.get('video_state'),'PUBLISHED');
      assert.equal(options.body.get('description'),job.caption);
      return answer({success:true});
    }
    return answer({status:{video_status:'ready',publishing_phase:{status:'complete'}}});
  });
  const steps = [];
  const result = await api.publish({platform:'facebook',token:'page-token'},job,video,value => steps.push(value));
  assert.equal(result.status,'published');
  assert.equal(result.url,'https://www.facebook.com/reel/123');
  assert.equal(calls.length,4);
  assert.ok(steps.some(step => step.status === 'submitted'));
});

test('Instagram waits for the container before sending media_publish',async t => {
  let checks = 0;
  const {api,video,calls} = await fixture(t,(url,options) => {
    if (url.hostname === 'rupload.facebook.com') return answer({success:true});
    if (url.pathname.endsWith('/media')) {
      assert.equal(options.body.get('upload_type'),'resumable');
      assert.equal(options.body.get('caption'),job.caption);
      return answer({id:'234',uri:'https://rupload.facebook.com/ig-api-upload/v25.0/234'});
    }
    if (url.pathname.endsWith('/234')) return answer({status_code:++checks === 1 ? 'IN_PROGRESS' : 'FINISHED'});
    if (url.pathname.endsWith('/media_publish')) {
      assert.equal(options.body.get('creation_id'),'234');
      return answer({id:'345'});
    }
    return answer({permalink:'https://www.instagram.com/reel/demo_1/'});
  });
  const result = await api.publish({platform:'instagram',accountId:'2',token:'page-token'},job,video,() => {});
  assert.equal(result.status,'published');
  assert.equal(result.url,'https://www.instagram.com/reel/demo_1/');
  assert.equal(calls[4][0],'/v25.0/2/media_publish');
});

test('YouTube uses PKCE, uploads once and records actual private visibility',async t => {
  const {api,video} = await fixture(t,(url,options) => {
    if (url.hostname === 'oauth2.googleapis.com') return answer({access_token:'google-token',refresh_token:'refresh-token'});
    if (url.pathname.endsWith('/channels')) return answer({items:[{id:'one-channel',snippet:{title:'My channel'}}]});
    if (options.method === 'POST') {
      assert.equal(url.searchParams.get('uploadType'),'resumable');
      assert.equal(JSON.parse(options.body).status.selfDeclaredMadeForKids,false);
      return new Response(null,{status:200,headers:{Location:'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=demo'}});
    }
    if (options.method === 'PUT') return answer({id:'AbCdEf12345'},201);
    return answer({items:[{status:{uploadStatus:'processed',privacyStatus:'private'}}]});
  });
  assert.equal(api.authorize('youtube','state','verifier').searchParams.get('code_challenge_method'),'S256');
  const connection = await api.connectYouTube('code','verifier');
  const result = await api.publish({platform:'youtube',accountId:connection.channel.id,refreshToken:connection.refreshToken},job,video,() => {});
  assert.equal(result.status,'uploaded');
  assert.match(result.note,/خاص/);
  assert.equal(result.url,'https://www.youtube.com/watch?v=AbCdEf12345');
});

test('YouTube refuses to open an upload session when the refreshed token points to another channel',async t => {
  const {api,video,calls} = await fixture(t,(url) => {
    if (url.hostname === 'oauth2.googleapis.com') return answer({access_token:'google-token'});
    return answer({items:[{id:'other-channel',snippet:{title:'Different channel'}}]});
  });
  const result = await api.publish({platform:'youtube',accountId:'one-channel',refreshToken:'token'},job,video,() => {});
  assert.equal(result.status,'failed');
  assert.match(result.note,/مختلفة/);
  assert.equal(calls.length,2);
});

test('one platform rejection does not abort others, and uncertain errors have their own status',async t => {
  const {api,video} = await fixture(t,(url) => {
    if (url.hostname === 'graph.facebook.com') return answer({error:{code:190,message:'secret should never appear'}},401);
    throw new TypeError('connection lost');
  });
  const results = await Promise.all([
    api.publish({platform:'facebook',token:'page-token'},job,video,() => {}),
    api.publish({platform:'youtube',refreshToken:'refresh-token'},job,video,() => {}),
  ]);
  assert.deepEqual(results.map(result => result.status),['failed','unknown']);
  assert.doesNotMatch(results[0].note,/secret/);
});

test('upload URL validation never sends bytes to an untrusted host',async t => {
  const {api,video,calls} = await fixture(t,() => answer({video_id:'123',upload_url:'https://untrusted.example/video-upload/123'}));
  const result = await api.publish({platform:'facebook',token:'page-token'},job,video,() => {});
  assert.equal(result.status,'unknown');
  assert.equal(calls.length,1);
});

test('Facebook sends a text post and uploads a photo directly with the page token',async t => {
  const folder = await mkdtemp(join(tmpdir(),'azmory-photo-'));
  t.after(() => rm(folder,{recursive:true,force:true}));
  const path = join(folder,'photo.png');
  const bytes = Buffer.from([137,80,78,71,13,10,26,10]);
  await writeFile(path,bytes);
  const paths = [];
  const api = createProviders(settings,async (input,options) => {
    const url = new URL(input);
    paths.push(url.pathname);
    assert.equal(options.headers.Authorization,'Bearer page-token');
    assert.equal(options.body.get('message'),'منشور جديد');
    if (url.pathname.endsWith('/photos')) {
      const file = options.body.get('source');
      assert.equal(file.type,'image/png');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes);
      return answer({id:'333',post_id:'100_444'});
    }
    return answer({id:'100_222'});
  });
  const target = {platform:'facebook',accountId:'100',token:'page-token'};
  const text = await api.publish(target,{kind:'text',caption:'منشور جديد'},null,() => {});
  const photo = await api.publish(target,{kind:'image',caption:'منشور جديد'},{path,type:'image/png'},() => {});
  assert.deepEqual(paths,['/v25.0/100/feed','/v25.0/100/photos']);
  assert.equal(text.url,'https://www.facebook.com/100/posts/222');
  assert.equal(photo.url,'https://www.facebook.com/100/posts/444');
});

test('Instagram photo uses the temporary image URL and publishes the finished container',async t => {
  const url = 'https://api.cloudinary.com/v1_1/test/image/download?signature=example';
  const {api,calls} = await fixture(t,(endpoint,options) => {
    if (endpoint.pathname.endsWith('/media')) {
      assert.equal(options.body.get('image_url'),url);
      assert.equal(options.body.get('caption'),'Caption');
      assert.equal(options.body.has('upload_type'),false);
      return answer({id:'234'});
    }
    if (endpoint.pathname.endsWith('/234')) return answer({status_code:'FINISHED'});
    if (endpoint.pathname.endsWith('/media_publish')) return answer({id:'345'});
    return answer({permalink:'https://www.instagram.com/p/example/'});
  });
  const result = await api.publish({platform:'instagram',accountId:'2',token:'page-token'},
    {kind:'image',caption:'Caption'},{url},() => {});
  assert.equal(result.status,'published');
  assert.equal(result.url,'https://www.instagram.com/p/example/');
  assert.deepEqual(calls.map(([path]) => path),['/v25.0/2/media','/v25.0/234','/v25.0/2/media_publish','/v25.0/345']);
});
