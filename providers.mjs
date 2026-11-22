import { createHash } from 'node:crypto';
import { createReadStream, openAsBlob } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';

const googleScopes = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
].join(' ');
const oauthForm = values => new URLSearchParams(values);
const queryUrl = (base, values) => {
  const url = new URL(base);
  url.search = new URLSearchParams(values);
  return url;
};
const bearer = token => ({ Authorization: 'Bearer ' + token });
const numericId = value => typeof value === 'string' && /^\d{1,40}$/.test(value);
const youtubeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
const instagramUrl = value => typeof value === 'string' && /^https:\/\/www\.instagram\.com\/(reel|p)\/[A-Za-z0-9_-]+\/?$/.test(value);
const fail = note => ({ status: 'failed', note });

class ProviderError extends Error {
  constructor(responseStatus, payload) {
    const providerCode = payload?.error?.code || payload?.error?.errors?.[0]?.reason || payload?.error;
    const safeCode = typeof providerCode === 'string' || typeof providerCode === 'number'
      ? String(providerCode).match(/^[a-zA-Z0-9_-]{1,50}$/)?.[0] : '';
    const code = [responseStatus, safeCode].filter(Boolean).join(' / ');
    super(code ? 'المنصة رفضات الطلب (' + code + '). راجع الصلاحيات وإعدادات الفيديو.' : 'ما قدرناش نتأكدو من جواب المنصة.');
    this.definitive = responseStatus >= 400 && responseStatus < 500 && responseStatus !== 408;
  }
}

function uploadEndpoint(input, host, prefix) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.host !== host || url.username || url.password || !url.pathname.startsWith(prefix)) {
    throw new Error('Unexpected upload endpoint');
  }
  return url;
}

export function createProviders(settings, request = fetch, delay = wait) {
  async function send(url, options = {}, timeout = 25000) {
    return request(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
  }

  async function json(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.error) throw new ProviderError(response.status, data);
    return data;
  }

  async function get(url, token) {
    return json(await send(url, { headers: bearer(token) }));
  }

  async function post(url, body, headers = {}) {
    return json(await send(url, { method: 'POST', headers, body }));
  }

  const graph = path => 'https://graph.facebook.com/' + settings.meta.version + '/' + path;
  const graphGet = (path, token, params) => get(queryUrl(graph(path), params), token);
  const graphPost = (path, token, params) => post(graph(path), oauthForm(params), bearer(token));
  const googleToken = values => post('https://oauth2.googleapis.com/token', oauthForm({
    client_id: settings.youtube.id, client_secret: settings.youtube.secret, ...values,
  }));

  function authorize(provider, state, verifier) {
    if (provider === 'meta') {
      return queryUrl('https://www.facebook.com/' + settings.meta.version + '/dialog/oauth', {
        client_id: settings.meta.id, redirect_uri: settings.meta.redirect, config_id: settings.meta.configId,
        state, response_type: 'code', override_default_response_type: 'true',
      });
    }
    return queryUrl('https://accounts.google.com/o/oauth2/v2/auth', {
      client_id: settings.youtube.id, redirect_uri: settings.youtube.redirect, response_type: 'code',
      scope: googleScopes, access_type: 'offline', prompt: 'consent select_account', state,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
  }

  async function connectMeta(code) {
    const initial = await json(await send(queryUrl(graph('oauth/access_token'), {
      client_id: settings.meta.id, client_secret: settings.meta.secret, redirect_uri: settings.meta.redirect, code,
    })));
    if (!initial.access_token) throw new Error('Missing Meta token');
    const extended = await json(await send(queryUrl(graph('oauth/access_token'), {
      grant_type: 'fb_exchange_token', client_id: settings.meta.id, client_secret: settings.meta.secret,
      fb_exchange_token: initial.access_token,
    })));
    if (!extended.access_token) throw new Error('Missing extended Meta token');
    const permissions = await graphGet('me/permissions', extended.access_token, {});
    const granted = new Set((permissions.data || []).filter(item => item.status === 'granted').map(item => item.permission));
    const canPublishFacebook = ['pages_show_list','pages_read_engagement','pages_manage_posts'].every(scope => granted.has(scope));
    const canPublishInstagram = ['pages_show_list','pages_read_engagement','instagram_basic','instagram_content_publish'].every(scope => granted.has(scope));
    const pages = [];
    if (!canPublishFacebook && !canPublishInstagram) return { pages };
    let after;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const data = await graphGet('me/accounts', extended.access_token, {
        fields: 'id,name,access_token,tasks' + (canPublishInstagram ? ',instagram_business_account{id,username}' : ''), limit: '50',
        ...(after ? { after } : {}),
      });
      for (const page of data.data || []) {
        if (!numericId(page.id) || !page.access_token || !page.tasks?.some(task => ['CREATE_CONTENT','MANAGE','PROFILE_PLUS_CREATE_CONTENT','PROFILE_PLUS_FULL_CONTROL'].includes(task))) continue;
        if (!canPublishFacebook && !numericId(page.instagram_business_account?.id)) continue;
        pages.push({
          canPublishFacebook, canPublishInstagram, id: page.id, name: page.name || 'Facebook Page', token: page.access_token,
          instagram: numericId(page.instagram_business_account?.id) ? page.instagram_business_account : null,
        });
      }
      after = data.paging?.next && data.paging?.cursors?.after;
      if (!after) break;
    }
    return { pages };
  }

  async function identifyYouTube(accessToken) {
    const data = await get(queryUrl('https://www.googleapis.com/youtube/v3/channels', {
      part:'id,snippet', mine:'true', maxResults:'2',
    }),accessToken);
    if (data.items?.length !== 1 || data.nextPageToken) return undefined;
    const channel = data.items[0];
    if (typeof channel?.id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(channel.id) || !channel.snippet?.title) return undefined;
    return {id:channel.id,name:channel.snippet.title};
  }

  async function connectYouTube(code, verifier) {
    const token = await googleToken({
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: settings.youtube.redirect,
    });
    if (!token.access_token || !token.refresh_token) throw new Error('Missing Google token');
    const channel = await identifyYouTube(token.access_token);
    if (!channel) throw new Error('A single channel must be selected');
    return {channel,refreshToken:token.refresh_token};
  }

  async function uploadBinary(url, video, headers, method = 'POST') {
    const stream = createReadStream(video.path);
    try {
      return await json(await send(url, {
        method, duplex: 'half', body: stream,
        headers: { 'Content-Length': String(video.size), 'Content-Type': 'application/octet-stream', ...headers },
      }, 240000));
    } finally {
      stream.destroy();
    }
  }

  async function publishFacebook(target, job, video, update) {
    const created = await graphPost('me/video_reels', target.token, { upload_phase: 'start' });
    if (!numericId(created.video_id) || !created.upload_url) return fail('Facebook ما رجّعاتش جلسة صالحة للرفع.');
    const ref = created.video_id;
    await update({ ref });
    const url = uploadEndpoint(created.upload_url, 'rupload.facebook.com', '/video-upload/');
    const upload = await uploadBinary(url, video, { Authorization: 'OAuth ' + target.token, offset: '0', file_size: String(video.size) });
    if (!upload.success) return fail('Facebook ما أكداتش رفع الفيديو.');
    await update({ status:'processing', ref });
    const finish = await graphPost('me/video_reels', target.token, {
      upload_phase:'finish', video_id:ref, video_state:'PUBLISHED', title:job.title, description:job.caption,
    });
    if (!finish.success) return { status:'unknown', note:'راجع الصفحة قبل ما تعاود الإرسال.' };
    await update({ status:'submitted', ref, note:'Facebook قبلات طلب النشر.' });
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await delay(10000);
      let result;
      try { result = await graphGet(ref, target.token, { fields:'status' }); }
      catch { break; }
      const status = result.status;
      const phase = status?.publishing_phase;
      if (phase?.publish_status === 'published' || (phase?.status === 'complete' && status.video_status === 'ready')) {
        return { status:'published', ref, url:'https://www.facebook.com/reel/' + ref, note:'' };
      }
      if ([status?.video_status,phase?.status,status?.processing_phase?.status].some(value => ['error','failed'].includes(value))) {
        return { ...fail('Facebook بلغات على خطأ أثناء المعالجة.'), ref };
      }
    }
    return { status:'submitted', ref, note:'Facebook قبلات الطلب. التأكيد النهائي كيبان فالصفحة.' };
  }

  async function publishFacebookPost(target,job,media) {
    const path = target.accountId + (job.kind === 'image' ? '/photos' : '/feed');
    let result;
    if (job.kind === 'image') {
      const form = new FormData();
      form.set('source',await openAsBlob(media.path,{type:media.type}),media.type === 'image/png' ? 'photo.png' : 'photo.jpg');
      form.set('message',job.caption);
      form.set('published','true');
      result = await post(graph(path),form,bearer(target.token));
    } else {
      result = await graphPost(path,target.token,{message:job.caption,published:'true'});
    }
    const ref = result.post_id || result.id;
    if (typeof ref !== 'string' || !/^\d{1,40}(?:_\d{1,40})?$/.test(ref)) {
      return {status:'unknown',note:'راجع الصفحة قبل ما تعاود الإرسال.'};
    }
    const url = ref.includes('_')
      ? 'https://www.facebook.com/' + ref.replace('_','/posts/')
      : job.kind === 'image' ? 'https://www.facebook.com/photo/?fbid=' + ref : undefined;
    return {status:'published',ref,url};
  }

  async function publishInstagram(target, job, video, update) {
    const image = job.kind === 'image';
    const created = await graphPost(target.accountId + '/media', target.token, image
      ? {image_url:video.url,caption:job.caption}
      : {media_type:'REELS',upload_type:'resumable',caption:job.caption || job.title,share_to_feed:'true'});
    if (!numericId(created.id) || (!image && !created.uri)) return fail('Instagram ما رجّعاتش جلسة صالحة للرفع.');
    const ref = created.id;
    await update({ ref });
    if (!image) {
      const url = uploadEndpoint(created.uri, 'rupload.facebook.com', '/ig-api-upload/');
      const upload = await uploadBinary(url, video, { Authorization:'OAuth ' + target.token, offset:'0', file_size:String(video.size) });
      if (!upload.success) return fail('Instagram ما أكداتش رفع الفيديو.');
    }
    await update({ status:'processing', ref });
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await delay(image ? 5000 : 60000);
      const result = await graphGet(ref, target.token, { fields:'status_code' });
      if (['ERROR','EXPIRED'].includes(result.status_code)) return { ...fail('Instagram رفضات معالجة الملف أو سالات جلسة الرفع.'), ref };
      if (result.status_code !== 'FINISHED') continue;
      const published = await graphPost(target.accountId + '/media_publish', target.token, { creation_id:ref });
      if (!numericId(published.id)) return { status:'unknown', ref, note:'راجع حساب Instagram قبل ما تعاود الإرسال.' };
      const item = { status:'published', ref:published.id };
      await update(item);
      try {
        const data = await graphGet(published.id, target.token, { fields:'permalink' });
        if (instagramUrl(data.permalink)) item.url = data.permalink;
      } catch {}
      return item;
    }
    return { ...fail('الملف باقي كيتعالج. التطبيق وقف قبل خطوة النشر. تقدر تجرب من جديد.'), ref };
  }

  async function publishYouTube(target, job, video, update) {
    const token = await googleToken({ grant_type:'refresh_token', refresh_token:target.refreshToken });
    if (!token.access_token) return fail('عاود ربط قناة YouTube.');
    let channel;
    try { channel = await identifyYouTube(token.access_token); }
    catch { return fail('تعذّر التحقق من قناة YouTube قبل الرفع.'); }
    if (channel?.id !== target.accountId) return fail('قناة YouTube اللي رجعات من Google مختلفة. عاود ربط القناة المقصودة.');
    const auth = bearer(token.access_token);
    const session = await send(queryUrl('https://www.googleapis.com/upload/youtube/v3/videos', {
      uploadType:'resumable', part:'snippet,status',
    }), {
      method:'POST',
      headers:{ ...auth, 'Content-Type':'application/json', 'X-Upload-Content-Type':'video/mp4', 'X-Upload-Content-Length':String(video.size) },
      body:JSON.stringify({
        snippet:{ title:job.title, description:job.caption, categoryId:'22' },
        status:{ privacyStatus:job.privacy, selfDeclaredMadeForKids:job.kids === 'yes' },
      }),
    });
    if (!session.ok) await json(session);
    const url = uploadEndpoint(session.headers.get('location'), 'www.googleapis.com', '/upload/youtube/v3/videos');
    await session.body?.cancel();
    const item = await uploadBinary(url, video, { ...auth, 'Content-Type':'video/mp4' }, 'PUT');
    if (!youtubeId(item.id)) return { status:'unknown', note:'راجع YouTube Studio قبل ما تعاود الإرسال.' };
    const ref = item.id;
    const link = 'https://www.youtube.com/watch?v=' + ref;
    const uploaded = { status:'uploaded', ref, url:link, note:'ترفع الفيديو. شوف الحالة النهائية والخصوصية فـ YouTube Studio.' };
    await update(uploaded);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await delay(10000);
      let result;
      try { result = await get(queryUrl('https://www.googleapis.com/youtube/v3/videos', { part:'status,processingDetails', id:ref }), token.access_token); }
      catch { break; }
      const status = result.items?.[0]?.status;
      const processing = result.items?.[0]?.processingDetails?.processingStatus;
      if (['failed','rejected','deleted'].includes(status?.uploadStatus) || ['failed','terminated'].includes(processing)) {
        return { ...fail('YouTube بلغ على خطأ أثناء المعالجة.'), ref, url:link };
      }
      if (status?.uploadStatus === 'processed' || processing === 'succeeded') {
        if (status?.privacyStatus === 'public') return { status:'published', ref, url:link, note:'الفيديو عام.' };
        if (status?.privacyStatus === 'private') return { ...uploaded, note:'المعالجة كملات. الفيديو خاص.' };
        if (status?.privacyStatus === 'unlisted') return { ...uploaded, note:'المعالجة كملات. الفيديو غير مُدرج.' };
      }
    }
    return uploaded;
  }

  const publish = { facebook:publishFacebook, instagram:publishInstagram, youtube:publishYouTube };
  return {
    authorize, connectMeta, connectYouTube,
    async publish(target, job, video, update) {
      try {
        if (target.platform === 'facebook' && ['text','image'].includes(job.kind)) return await publishFacebookPost(target,job,video);
        return await publish[target.platform](target, job, video, update);
      } catch (error) {
        if (error instanceof ProviderError && error.definitive) return fail(error.message);
        return { status:'unknown', note:'الاتصال تقطع أو الجواب ما كانش واضح. تأكد من المنصة قبل ما تعاود.' };
      }
    },
  };
}
