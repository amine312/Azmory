import { createHash, randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';

import preflight from './public/preflight.cjs';

const {BUFFER_PLATFORMS,IMAGE_TYPES} = preflight;
const platformNames = {tiktok:'TikTok',threads:'Threads',linkedin:'LinkedIn',bluesky:'Bluesky'};
const postLinks = {
  tiktok:/^https:\/\/(www\.)?tiktok\.com\/@[A-Za-z0-9_.-]+\/video\/\d+(?:\?[^#]*)?$/,
  threads:/^https:\/\/(www\.)?threads\.(net|com)\/@[^/]+\/post\//,
  linkedin:/^https:\/\/(www\.)?linkedin\.com\/(feed\/update\/|posts\/)/,
  bluesky:/^https:\/\/bsky\.app\/profile\/[^/]+\/post\//,
};
const bufferUrl = 'https://api.buffer.com';
const bufferId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const failed = note => ({ status:'failed',note });
const pending = { status:'submitted',note:'Buffer قبل الطلب. حدّث الحالة أو شوف Buffer من بعد.' };

export function createBufferPublisher(settings, request = fetch, delay = wait) {
  const configured = Boolean(settings.bufferKey);
  const cloudConfigured = Boolean(/^[A-Za-z0-9_-]+$/.test(settings.cloudName || '') && settings.cloudKey && settings.cloudSecret);
  const cloudUrl = resource => 'https://api.cloudinary.com/v1_1/' + settings.cloudName + '/' + resource + '/';

  async function send(url,options = {},timeout = 25000) {
    return request(url,{...options,redirect:'error',signal:AbortSignal.timeout(timeout)});
  }

  async function buffer(query,variables) {
    const response = await send(bufferUrl,{
      method:'POST',
      headers:{ Authorization:'Bearer ' + settings.bufferKey, 'Content-Type':'application/json' },
      body:JSON.stringify({query,variables}),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.errors?.length || !result.data) throw new Error('Buffer request failed');
    return result.data;
  }

  async function discover() {
    const {account} = await buffer('query { account { organizations { id name } } }');
    if (!Array.isArray(account?.organizations)) throw new Error('No Buffer account');
    const groups = await Promise.all(account.organizations.map(async organization => {
      const {channels} = await buffer(
        'query ($organization: OrganizationId!) { channels(input: {organizationId: $organization}) { id service name displayName isDisconnected isLocked } }',
        {organization:organization.id},
      );
      return (channels || []).filter(channel => BUFFER_PLATFORMS.includes(channel.service) && !channel.isDisconnected && !channel.isLocked && bufferId(channel.id))
        .map(channel => ({id:channel.id,platform:channel.service,name:[channel.displayName || channel.name,organization.name].filter(Boolean).join(' · ') || platformNames[channel.service]}));
    }));
    return [...new Map(groups.flat().map(channel => [channel.platform + ':' + channel.id,channel])).values()];
  }

  function sign(params) {
    const values = { timestamp:String(Math.floor(Date.now() / 1000)), ...params };
    const data = Object.keys(values).sort().map(name => name + '=' + values[name]).join('&');
    return { ...values, api_key:settings.cloudKey, signature:createHash('sha256').update(data + settings.cloudSecret).digest('hex') };
  }

  async function stage(media,publicId,resource) {
    const form = new FormData();
    for (const [key,value] of Object.entries(sign({ public_id:publicId, type:'authenticated', overwrite:'false' }))) form.set(key,value);
    const format = resource === 'image' ? IMAGE_TYPES[media.type] : 'mp4';
    form.set('file',await openAsBlob(media.path,{type:media.type || 'video/mp4'}),'post.' + format);
    const response = await send(cloudUrl(resource) + 'upload',{method:'POST',body:form},240000);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.public_id !== publicId) throw new Error('Cloudinary upload failed');
    const expires = Math.floor(Date.now() / 1000) + 60 * 60;
    const download = new URL(cloudUrl(resource) + 'download');
    download.search = new URLSearchParams(sign({public_id:publicId,type:'authenticated',format,expires_at:String(expires)}));
    return download.href;
  }

  async function clean(publicId,resource) {
    if (!/^reeldesk-[a-f0-9-]{36}$/.test(publicId)) return false;
    try {
      const response = await send(cloudUrl(resource) + 'destroy',{
        method:'POST',body:new URLSearchParams(sign({public_id:publicId,type:'authenticated',invalidate:'true'})),
      });
      const data = await response.json();
      return response.ok && ['ok','not found'].includes(data.result);
    } catch { return false; }
  }

  async function finalize(result,publicId,resource) {
    if (!publicId) return result;
    const cleaned = await clean(publicId,resource);
    if (cleaned) return { ...result, staging:null };
    return { ...result, staging:publicId,note:[result.note,'النسخة الخاصة باقية فـ Cloudinary؛ تقدر تحيدها من Media Library.'].filter(Boolean).join(' ') };
  }

  async function readStatus(ref,publicId,platform,resource = 'video',known) {
    if (!bufferId(ref)) return pending;
    const post = known || (await buffer(
      'query ($id: PostId!) { post(input: {id: $id}) { id status externalLink } }',
      {id:ref},
    )).post;
    if (post?.status === 'sent') {
      const result = { status:'published',ref,note:'Buffer أكد النشر فـ ' + platformNames[platform] + '.' };
      if (typeof post.externalLink === 'string' && postLinks[platform]?.test(post.externalLink)) result.url = post.externalLink;
      return finalize(result,publicId,resource);
    }
    if (['error','draft','needs_approval'].includes(post?.status)) {
      const result = failed('Buffer ما أكدش النشر الأوتوماتيكي. راجع تفاصيل المنشور فـ Buffer.');
      // Keep the temporary asset for a draft or a post awaiting approval.
      if (post.status !== 'error') return { ...result,ref,staging:publicId };
      return finalize({...result,ref},publicId,resource);
    }
    return { ...pending,ref,staging:publicId };
  }

  async function withTemporaryImage(media,update,publishImage) {
    const publicId = 'reeldesk-' + randomUUID();
    await update({staging:publicId});
    let url;
    try { url = await stage(media,publicId,'image'); }
    catch { return finalize(failed('تعذّر رفع الصورة المؤقتة لـ Cloudinary.'),publicId,'image'); }
    return finalize(await publishImage(url),publicId,'image');
  }

  async function publish(target,job,media,update) {
    const {platform} = target;
    const resource = job.kind === 'image' ? 'image' : 'video';
    const publicId = media ? 'reeldesk-' + randomUUID() : null;
    let url;
    if (publicId) {
      await update({staging:publicId});
      try { url = await stage(media,publicId,resource); }
      catch { return finalize(failed('تعذّر رفع النسخة المؤقتة لـ Cloudinary.'),publicId,resource); }
    }
    const unknown = {status:'unknown',staging:publicId,note:'راجع Buffer قبل ما تعاود الإرسال.' +
      (publicId ? ' النسخة الخاصة باقية مؤقتاً فـ Cloudinary.' : '')};
    let data;
    try {
      data = await buffer(`mutation ($input: CreatePostInput!) {
        createPost(input: $input) {
          ... on PostActionSuccess { post { id status externalLink } }
          ... on MutationError { message }
        }
      }`,{input:{
        text:resource === 'video' && media ? job.caption || job.title : job.caption,
        channelId:target.accountId,
        schedulingType:'automatic',
        mode:'shareNow',
        needsApproval:false,
        assets:url ? [{[resource]:{url}}] : [],
        ...(platform === 'tiktok' && {metadata:{tiktok:{isAiGenerated:job.tiktokAi === true}}}),
      }});
    } catch {
      return unknown;
    }
    const item = data.createPost?.post;
    if (!bufferId(item?.id)) {
      if (data.createPost?.message) return finalize(failed('Buffer رفض النشر. راجع اتصال المنصة وإعدادات الحساب.'),publicId,resource);
      return unknown;
    }
    const ref = item.id;
    await update({...pending,ref,staging:publicId});
    let result = await readStatus(ref,publicId,platform,resource,item);
    for (let attempt = 0; attempt < 6 && result.status === 'submitted'; attempt++) {
      await delay(15000);
      try { result = await readStatus(ref,publicId,platform,resource); }
      catch { break; }
    }
    return result;
  }

  return { configured,cloudConfigured,discover,publish,readStatus,withTemporaryImage };
}
