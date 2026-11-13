export const homepagePromoKey = 'website/homepage-promo';

// The first promotion is visible until an administrator saves their own settings.
export const initialHomepagePromo = {
  enabled: true,
  videoId: 'f8t4gAIy5t0',
  title: 'Get your signed Written in the Light Blu-ray',
  buttonLabel: 'Shop Merch',
  buttonPath: '/merch/'
};

function youtubeVideoId(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return '';
  if (url.hostname === 'youtu.be') return url.pathname.match(/^\/([\w-]+)\/?$/)?.[1];
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(url.hostname)) return '';
  if (url.pathname === '/watch') return url.searchParams.get('v');
  return url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)\/?$/)?.[1];
}

export function promoSettings(record) {
  const {enabled, videoId, title, buttonLabel, buttonPath} = record?.data ?? initialHomepagePromo;
  return {
    enabled,
    videoUrl: videoId ? 'https://youtu.be/' + videoId : '',
    title,
    buttonLabel,
    buttonPath,
    revision: record?.etag ?? ''
  };
}

export function validatePromo(body, requireThat) {
  const text = value => typeof value === 'string' ? value.trim() : '';
  const videoUrl = text(body.videoUrl), title = text(body.title);
  const buttonLabel = text(body.buttonLabel), buttonPath = text(body.buttonPath);
  requireThat(typeof body.enabled === 'boolean', 'Choose whether the promo is visible.');
  requireThat(title.length <= 120, 'Keep the title to 120 characters.');
  requireThat(videoUrl.length <= 500, 'Enter a valid YouTube video link.');

  let videoId = '';
  if (videoUrl) {
    try { videoId = youtubeVideoId(videoUrl); } catch { /* The field error below covers invalid URLs. */ }
    requireThat(/^[\w-]{11}$/.test(videoId || ''), 'Enter a YouTube video link, such as https://youtu.be/f8t4gAIy5t0.');
  }
  requireThat(!body.enabled || videoId && title, 'Enter a title and YouTube video link to show the promo.');
  requireThat(!!buttonLabel === !!buttonPath, 'Enter both a button label and page path, or leave both blank.');
  requireThat(buttonLabel.length <= 40, 'Keep the button label to 40 characters.');
  requireThat(buttonPath.length <= 240 && (!buttonPath || /^\/(?!\/)[^\\\s\u0000-\u001f\u007f]*$/.test(buttonPath)),
    'Use a page path on this website, such as /merch/.');
  return {enabled: body.enabled, videoId, title, buttonLabel, buttonPath};
}
