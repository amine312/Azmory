import {test} from 'node:test';
import assert from 'node:assert/strict';
import preflight from '../public/preflight.cjs';

test('a short vertical export passes all seven destination checks', () => {
  const sample = {duration:40,width:1080,height:1920};
  assert.equal(preflight.hasVideoMetadata(sample),true);
  for (const platform of preflight.PLATFORM_IDS) {
    assert.deepEqual(preflight.checkVideo(platform,sample),[]);
  }
});

test('a wide 75-second clip explains the failing conditions by network', () => {
  const sample = {duration:75,width:1920,height:1080};
  assert.equal(preflight.checkVideo('facebook',sample).length,2);
  assert.equal(preflight.checkVideo('youtube',sample).length,1);
  assert.deepEqual(preflight.checkVideo('instagram',sample),[]);
  assert.deepEqual(preflight.checkVideo('tiktok',sample),[]);
  assert.equal(preflight.hasVideoMetadata({...sample,duration:Infinity}),false);
});

test('checks use the actual outgoing caption and count YouTube description bytes', () => {
  const common = '#واحد #جوج #تلاتة #ربعة #خمسة #ستة';
  const override = {tiktok:' TikTok #المغرب ', youtube:'✨'.repeat(1800)};
  assert.equal(preflight.checkCaption('tiktok',common).length,1);
  assert.deepEqual(preflight.checkCaption('tiktok',preflight.captionFor('tiktok',common,override)),[]);
  assert.equal(preflight.checkCaption('tiktok','',common).length,1);
  assert.equal(preflight.checkCaption('youtube',preflight.captionFor('youtube',common,override)).length,1);
  assert.equal(preflight.captionFor('facebook',common,override),common);
});

test('MP4 header is detected from bytes rather than the filename', () => {
  assert.equal(preflight.hasMp4Header(Buffer.from('....ftypisom')),true);
  assert.equal(preflight.hasMp4Header(Buffer.from('....fakeisom')),false);
  assert.equal(preflight.hasMp4Header(Buffer.from('ftyp')),false);
});

test('new destinations enforce duration, ratio and platform-specific caption rules', () => {
  const sample = {duration:650,width:1080,height:1920};
  assert.equal(preflight.checkVideo('threads',sample).length,1);
  assert.equal(preflight.checkVideo('bluesky',sample).length,1);
  assert.equal(preflight.checkVideo('linkedin',{...sample,width:3840}).length,1);
  assert.deepEqual(preflight.checkCaption('threads','م'.repeat(250)),[]);
  assert.equal(preflight.checkCaption('threads','م'.repeat(251)).length,1);
  assert.deepEqual(preflight.checkCaption('bluesky','👍🏽'.repeat(300)),[]);
  assert.equal(preflight.checkCaption('bluesky','a'.repeat(301)).length,1);
});
