export const homepagePromoKey = 'website/homepage-promo';
const uploadPartBytes = 3_000_000;
// Keep each request within Netlify's binary upload limit and the whole
// video within the streamed response limit, including clients without Range.
const uploadMaxBytes = 18_000_000;
const uploadIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const validVideoSize = size => Number.isSafeInteger(size) && size >= 12 && size <= uploadMaxBytes;
const partCount = size => Math.ceil(size / uploadPartBytes);
const partKey = (id, part) => `website/homepage-promo-video/${id}/${part}`;
const playbacks = new Set(['click', 'autoplay']);
const thumbnails = new Set(['auto', 'maxresdefault', 'hqdefault', '1', '2', '3']);
const builtInPreviewId = 'f8t4gAIy5t0';

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

export function promoPresentation(promo) {
  return {
    // Existing MP4 previews, including the original homepage promotion, keep
    // their muted preview. Other existing YouTube promos stay click to play.
    playback: playbacks.has(promo?.playback) ? promo.playback :
      promo?.video || promo?.videoId === builtInPreviewId ? 'autoplay' : 'click',
    // Auto retains the current local poster or default YouTube thumbnail.
    thumbnail: thumbnails.has(promo?.thumbnail) ? promo.thumbnail : 'auto'
  };
}

export function promoSettings(record) {
  const promo = record?.data ?? initialHomepagePromo;
  const {enabled, videoId, title, buttonLabel, buttonPath, video} = promo;
  return {
    enabled,
    videoUrl: videoId ? 'https://youtu.be/' + videoId : '',
    title,
    buttonLabel,
    buttonPath,
    ...promoPresentation(promo),
    uploadedVideo: video ? {name: video.name, size: video.size} : null,
    uploadPartBytes,
    uploadMaxBytes,
    revision: record?.etag ?? ''
  };
}

export function validatePromo(body, requireThat, previousVideo, previousPromo) {
  const text = value => typeof value === 'string' ? value.trim() : '';
  const videoUrl = text(body.videoUrl), title = text(body.title);
  const buttonLabel = text(body.buttonLabel), buttonPath = text(body.buttonPath);
  requireThat(typeof body.enabled === 'boolean', 'Choose whether the promo is visible.');
  requireThat(title.length <= 120, 'Keep the title to 120 characters.');
  requireThat(videoUrl.length <= 500, 'Enter a valid YouTube video link.');
  requireThat(body.playback === undefined || playbacks.has(body.playback), 'Choose click to play or muted autoplay.');
  requireThat(body.thumbnail === undefined || thumbnails.has(body.thumbnail), 'Choose one of the supplied YouTube thumbnails.');

  let videoId = '';
  if (videoUrl) {
    try { videoId = youtubeVideoId(videoUrl); } catch { /* The field error below covers invalid URLs. */ }
    requireThat(/^[\w-]{11}$/.test(videoId || ''), 'Enter a YouTube video link, such as https://youtu.be/f8t4gAIy5t0.');
  }
  let video = body.removeVideo === true ? undefined : previousVideo;
  if (body.upload) {
    const {id, size} = body.upload;
    const name = text(body.upload.name);
    requireThat(typeof id === 'string' && uploadIdPattern.test(id) && validVideoSize(size) &&
      /\.mp4$/i.test(name) && name.length <= 240, 'Choose an MP4 file up to 18 MB.');
    video = {id, size, name};
  }
  requireThat(!body.enabled || (videoId || video) && title, 'Enter a title and add an MP4 or a YouTube link to show the promo.');
  requireThat(!!buttonLabel === !!buttonPath, 'Enter both a button label and page path, or leave both blank.');
  requireThat(buttonLabel.length <= 40, 'Keep the button label to 40 characters.');
  requireThat(buttonPath.length <= 240 && (!buttonPath || /^\/(?!\/)[^\\\s\u0000-\u001f\u007f]*$/.test(buttonPath)),
    'Use a page path on this website, such as /merch/.');
  const presentation = promoPresentation({videoId, video,
    playback: body.playback === undefined ? previousPromo?.playback : body.playback,
    thumbnail: body.thumbnail === undefined ? previousPromo?.thumbnail : body.thumbnail});
  return {enabled: body.enabled, videoId, title, buttonLabel, buttonPath, ...presentation, ...(video ? {video} : {})};
}

export async function savePromoVideoPart(store, req, params, admin, requireThat) {
  const id = params.get('id') ?? '';
  const size = Number(params.get('size'));
  const part = Number(params.get('part') ?? -1);
  const revision = params.get('revision') ?? '';
  requireThat(uploadIdPattern.test(id) && validVideoSize(size) && Number.isInteger(part) &&
    part >= 0 && part < partCount(size) && revision.length <= 128, 'Invalid video upload.');
  requireThat(req.headers.get('content-type') === 'application/octet-stream', 'Choose an MP4 file.');
  const expectedSize = Math.min(uploadPartBytes, size - part * uploadPartBytes);
  const bytes = new Uint8Array(await req.arrayBuffer());
  requireThat(bytes.length === expectedSize, 'The video upload was interrupted. Try saving again.');
  if (part === 0) {
    // ISO base media files exported as MP4 start with a file type box.
    const fileType = new TextDecoder().decode(bytes.subarray(4, 8));
    const boxSize = new DataView(bytes.buffer).getUint32(0);
    requireThat(fileType === 'ftyp' && boxSize >= 16 && boxSize <= bytes.length, 'Choose a valid MP4 video.');
  }
  const key = partKey(id, part);
  const result = await store.set(key, bytes, {onlyIfNew: true, metadata: {size, admin, revision}});
  if (!result.modified) {
    const existing = (await store.getMetadata(key))?.metadata;
    requireThat(existing?.size === size && existing.admin === admin && existing.revision === revision,
      'This video upload has changed. Choose the file again.', 409);
  }
}

export async function verifyPromoVideo(store, video, admin, revision, requireThat) {
  const entries = await Promise.all(Array.from({length: partCount(video.size)}, (_, part) =>
    store.getMetadata(partKey(video.id, part))));
  requireThat(entries.every(entry => entry?.metadata?.size === video.size && entry.metadata.admin === admin &&
    entry.metadata.revision === revision), 'The video upload is incomplete. Choose the file again and save.');
}

export async function removePromoVideo(store, video) {
  await Promise.allSettled(Array.from({length: partCount(video.size)}, (_, part) =>
    store.delete(partKey(video.id, part))));
}

export function promoVideoResponse(store, req, {id, size}, headers) {
  const responseHeaders = {...headers, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes'};
  const range = req.headers.get('range');
  let start = 0;
  let end = size - 1;
  if (range && req.method !== 'HEAD') {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
    if (match?.[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(Number(match[2]), end);
    } else if (match?.[2]) {
      start = Math.max(0, size - Number(match[2]));
    } else {
      start = size;
    }
    if (start > end) {
      return new Response(null, {status: 416, headers: {...responseHeaders, 'Content-Range': `bytes */${size}`}});
    }
    responseHeaders['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  responseHeaders['Content-Length'] = String(end - start + 1);
  if (req.method === 'HEAD') return new Response(null, {headers: responseHeaders});
  let offset = start;
  const stream = new ReadableStream({
    async pull(controller) {
      const part = Math.floor(offset / uploadPartBytes);
      const base = part * uploadPartBytes;
      const data = await store.get(partKey(id, part), {type: 'arrayBuffer'});
      if (!data) throw new Error('Promo video part is unavailable.');
      const bytes = new Uint8Array(data).subarray(offset - base, end - base + 1);
      controller.enqueue(bytes);
      offset += bytes.length;
      if (offset > end) controller.close();
    }
  });
  return new Response(stream, {status: range ? 206 : 200, headers: responseHeaders});
}
