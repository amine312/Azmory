'use strict';

(function exposePreflight() {
  const MAX_BYTES = 100_000_000;
  const MAX_IMAGE_BYTES = 8_000_000;
  const IMAGE_TYPES = Object.freeze({'image/jpeg':'jpg','image/png':'png'});
  const KINDS = Object.freeze(['video','image','text']);
  const BUFFER_PLATFORMS = Object.freeze(['tiktok','threads','linkedin','bluesky']);
  const PLATFORM_IDS = Object.freeze(['facebook','instagram','youtube',...BUFFER_PLATFORMS]);
  const graphemes = new Intl.Segmenter(undefined,{granularity:'grapheme'});

  function hasMp4Header(bytes) {
    return bytes.length >= 12 && bytes[4] === 102 && bytes[5] === 116 && bytes[6] === 121 && bytes[7] === 112;
  }

  function imageType(bytes) {
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if ([137,80,78,71,13,10,26,10].every((value,index) => bytes[index] === value)) return 'image/png';
  }

  function supportsKind(platform,kind,cloudMedia = true) {
    if (!cloudMedia && kind !== 'text' && BUFFER_PLATFORMS.includes(platform)) return false;
    if (kind === 'video') return PLATFORM_IDS.includes(platform);
    if (kind === 'image' && platform === 'instagram') return Boolean(cloudMedia);
    return ['facebook','threads','linkedin','bluesky'].includes(platform);
  }

  function checkImage(platform,{size,type,width,height}) {
    const issues = [];
    if (platform === 'bluesky' && size >= 1_000_000) issues.push('نقص حجم الصورة لأقل من 1 MB باش تنشر فـ Bluesky.');
    if (platform === 'instagram') {
      if (type !== 'image/jpeg') issues.push('صدّر الصورة بصيغة JPG باش تنشر فـ Instagram.');
      if (width / height < .8 || width / height > 1.91) issues.push('اختار نسبة بين 4:5 و1.91:1 باش تنشر فـ Instagram.');
    }
    return issues;
  }

  function hasVideoMetadata({duration,width,height}) {
    return Number.isFinite(duration) && duration > 0 &&
      Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0;
  }

  function checkVideo(platform,{duration,width,height}) {
    const issues = [];
    switch (platform) {
      case 'facebook':
        if (duration < 4 || duration > 60.1) issues.push('قصّر أو طوّل الفيديو باش يكون بين 4 و60 ثانية.');
        if (Math.abs(width / height - 9 / 16) > .01) issues.push('حوّل الإطار لعمودي 9:16.');
        if (width < 540 || height < 960) issues.push('صدّر الفيديو بدقّة 540 × 960 أو أكثر.');
        break;
      case 'instagram':
        if (duration < 3 || duration > 900.1) issues.push('خلّي المدة بين 3 ثواني و15 دقيقة.');
        if (width > 1920) issues.push('نقص العرض لـ 1920 بكسل أو أقل.');
        break;
      case 'youtube':
        if (duration > 180.1) issues.push('قصّر الفيديو لـ 3 دقايق باش يكون Short.');
        if (width > height) issues.push('حوّل الإطار لمربع أو عمودي باش يكون Short.');
        break;
      case 'tiktok':
        if (duration < 3 || duration > 600.1) issues.push('خلّي المدة بين 3 ثواني و10 دقايق.');
        if (width < 360 || height < 360) issues.push('صدّر الفيديو بعرض وارتفاع 360 بكسل على الأقل.');
        break;
      case 'threads':
        if (duration > 300.1) issues.push('قصّر الفيديو لـ 5 دقايق أو أقل.');
        break;
      case 'linkedin':
        if (duration < 3 || duration > 1800.1) issues.push('خلّي المدة بين 3 ثواني و30 دقيقة.');
        if (width / height < 9 / 16 - .01 || width / height > 16 / 9 + .01) issues.push('اختار إطار بين 9:16 و16:9.');
        break;
      case 'bluesky':
        if (duration > 600.1) issues.push('قصّر الفيديو لـ 10 دقايق أو أقل.');
        break;
    }
    return issues;
  }

  function captionFor(platform,caption,captions) {
    return captions?.[platform]?.trim() || caption.trim();
  }

  function checkCaption(platform,caption,title = '') {
    if (platform === 'youtube' && new TextEncoder().encode(caption).length > 5000) {
      return ['قصّر الوصف. YouTube كيسمح حتى لـ 5000 بايت.'];
    }
    if (platform === 'tiktok' && ((caption || title).match(/#[\p{L}\p{N}_]+/gu) || []).length > 5) {
      return ['خلّي حتى لـ 5 هاشتاغات فـ TikTok.'];
    }
    const text = caption || title;
    if (platform === 'threads' && new TextEncoder().encode(text).length > 500) {
      return ['قصّر الوصف. Threads كيسمح حتى لـ 500 بايت.'];
    }
    if (platform === 'bluesky' && [...graphemes.segment(text)].length > 300) {
      return ['قصّر الوصف. Bluesky كيسمح حتى لـ 300 حرف.'];
    }
    return [];
  }

  const checks = Object.freeze({MAX_BYTES,MAX_IMAGE_BYTES,IMAGE_TYPES,KINDS,BUFFER_PLATFORMS,PLATFORM_IDS,hasMp4Header,imageType,supportsKind,hasVideoMetadata,checkVideo,checkImage,checkCaption,captionFor});
  if (typeof module === 'object' && module.exports) module.exports = checks;
  else globalThis.AzmoryPreflight = checks;
})();
