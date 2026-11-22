const c = window.SITE_CONTENT || {};

function safeHref(value) {
  return (/^(https?:\/\/|#|\/|\.\/)/i).test(value || "") ? value : "#";
}

function renderFeatured() {
  const target = document.querySelector("#featured-content");
  if (!target || !c.featured) return;
  const f = c.featured;
  target.innerHTML = `
    <div class="featured-art">
      <img src="${f.image}" alt="Official poster for ${f.title}">
    </div>
    <div class="featured-copy">
      <span class="eyebrow red">${f.eyebrow}</span>
      <h2>${f.title}</h2>
      <span class="mini-line"></span>
      <p>${f.description}</p>
      <div class="button-row">
        <a class="btn btn-primary" href="${safeHref(f.primaryUrl)}" target="_blank" rel="noopener noreferrer">${f.primaryText} <span aria-hidden="true">↗</span></a>
        <a class="btn btn-outline" href="${safeHref(f.secondaryUrl)}" target="_blank" rel="noopener noreferrer">${f.secondaryText} <span aria-hidden="true">↗</span></a>
      </div>
    </div>`;
}

function renderAnnouncement() {
  const target = document.querySelector("#announcement-content");
  if (!target || !c.announcement) return;
  const a = c.announcement;
  target.innerHTML = `
    <span class="eyebrow">${a.label}</span>
    <h2>${a.title}</h2>
    <p>${a.body}</p>
    <a class="text-link" href="${safeHref(a.buttonUrl)}">${a.buttonText} <span aria-hidden="true">→</span></a>`;
}

let youtubeApiPromise;
function loadYouTubeApi() {
  if (typeof window.YT?.Player === "function") return Promise.resolve(window.YT);
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    let script = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    const owned = !script;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.removeEventListener("error", failed);
      if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = previous;
      if (error) {
        if (owned) script.remove();
        reject(error);
      } else resolve(window.YT);
    };
    const failed = () => finish(Error("YouTube could not be loaded."));
    const ready = () => {
      try { if (typeof previous === "function") previous(); } catch {}
      finish(typeof window.YT?.Player === "function" ? null : Error("YouTube is unavailable."));
    };
    const timer = setTimeout(failed, 10000);
    window.onYouTubeIframeAPIReady = ready;
    if (owned) {
      script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
    }
    script.addEventListener("error", failed, {once: true});
    if (owned) document.head.append(script);
  });
  youtubeApiPromise.catch(() => { youtubeApiPromise = undefined; });
  return youtubeApiPromise;
}

function promoPosterUrls(youtubeId, thumbnail, builtInPreview) {
  if (!youtubeId) return [];
  const choices = ["auto", "maxresdefault", "hqdefault", "1", "2", "3"];
  const choice = choices.includes(thumbnail) ? thumbnail : "auto";
  const base = "https://i.ytimg.com/vi/" + youtubeId + "/";
  const poster = choice === "auto" ? builtInPreview ? "/assets/written-in-the-light-promo-poster.webp" : base + "mqdefault.jpg" : base + choice + ".jpg";
  return [...new Set([poster, base + "hqdefault.jpg"])];
}

function applyPromoPoster(target, urls) {
  if (!urls.length) return;
  const image = target.tagName === "IMG" ? target : document.createElement("img");
  let current = 0;
  const show = () => {
    if (target !== image) target.poster = urls[current];
    image.src = urls[current];
  };
  const next = () => {
    if (++current < urls.length) show();
    else if (target === image) image.remove();
    else target.removeAttribute("poster");
  };
  image.addEventListener("error", next);
  image.addEventListener("load", () => {
    // Missing max-resolution thumbnails can be a small placeholder with HTTP 200.
    if (urls[current]?.endsWith("/maxresdefault.jpg") && image.naturalWidth < 480) next();
  });
  show();
}

function promoPlaybackStatus(frame) {
  const status = document.createElement("p");
  status.className = "promo-youtube-status";
  status.setAttribute("role", "status");
  status.hidden = true;
  frame.parentNode.append(status);
  return status;
}

function mountYouTubePlayer(frame, motion, sound, youtubeId, autoplay) {
  const host = document.createElement("div");
  host.className = "promo-youtube";
  host.hidden = true;
  host.inert = true;
  host.setAttribute("inert", "");
  frame.after(host);
  const status = promoPlaybackStatus(frame);
  let player, readyTimer, generation = 0, ready = false, loading = false, playing = false, hasPlayed = false, muted = true;
  const paint = () => {
    motion.hidden = false;
    motion.disabled = loading;
    motion.textContent = loading ? "Loading preview…" : playing ? "Pause preview" : hasPlayed ? "Resume preview" : "Play preview";
    motion.setAttribute("aria-pressed", String(playing));
    sound.hidden = false;
    sound.disabled = !ready;
    sound.textContent = muted ? "Unmute preview" : "Mute preview";
    sound.setAttribute("aria-pressed", String(!muted));
  };
  const unavailable = () => {
    generation++;
    clearTimeout(readyTimer);
    loading = ready = playing = hasPlayed = false;
    host.hidden = true;
    frame.hidden = false;
    status.hidden = false;
    status.textContent = "The video preview is unavailable. Select Play preview to try again.";
    try { player?.destroy(); } catch {}
    player = undefined;
    paint();
  };
  const play = () => {
    playing = true;
    status.hidden = true;
    paint();
    player.playVideo();
  };
  const start = automatic => {
    if (loading) return;
    const current = ++generation;
    const failed = () => { if (current === generation) unavailable(); };
    loading = true;
    muted = true;
    status.hidden = true;
    frame.hidden = true;
    host.hidden = false;
    const target = document.createElement("div");
    host.replaceChildren(target);
    paint();
    loadYouTubeApi().then(api => {
      if (current !== generation) return;
      readyTimer = setTimeout(failed, 12000);
      player = new api.Player(target, {
        width: "100%", height: "100%", videoId: youtubeId,
        playerVars: {autoplay: 0, controls: 0, disablekb: 1, fs: 0, cc_load_policy: 1, enablejsapi: 1, playsinline: 1, loop: 1, playlist: youtubeId, origin: location.origin},
        events: {
          onReady: event => {
            if (current !== generation) return;
            clearTimeout(readyTimer);
            loading = false;
            ready = true;
            const iframe = event.target.getIframe();
            iframe.title = "Homepage promotional video";
            iframe.setAttribute("allow", "autoplay; encrypted-media");
            iframe.removeAttribute("allowfullscreen");
            iframe.setAttribute("tabindex", "-1");
            iframe.setAttribute("aria-hidden", "true");
            iframe.inert = true;
            iframe.setAttribute("inert", "");
            event.target.mute();
            paint();
            if (!automatic || !matchMedia("(prefers-reduced-motion: reduce)").matches) play();
          },
          onAutoplayBlocked: () => {
            if (current !== generation) return;
            playing = false;
            status.hidden = false;
            status.textContent = "Playback is paused. Select Play preview to start it.";
            paint();
          },
          onStateChange: event => {
            if (current !== generation) return;
            if (event.data === 1) { playing = hasPlayed = true; status.hidden = true; }
            else if ([0, 2, 5].includes(event.data)) playing = false;
            paint();
          },
          onError: failed
        }
      });
    }).catch(failed);
  };
  motion.addEventListener("click", () => {
    if (loading) return;
    try {
      if (!ready) start(false);
      else if (playing) { player.pauseVideo(); playing = false; paint(); }
      else play();
    } catch { unavailable(); }
  });
  sound.addEventListener("click", () => {
    if (!ready) return;
    try {
      if (muted) player.unMute(); else player.mute();
      muted = !muted;
      paint();
    } catch { unavailable(); }
  });
  paint();
  if (autoplay) start(true);
}

function mountPromoVideo(promo, youtubeId, videoPath, options = {}) {
  const frame = promo.querySelector(".promo-player");
  const motion = promo.querySelector(".promo-motion");
  const sound = promo.querySelector(".promo-sound");
  youtubeId = /^[\w-]{11}$/.test(youtubeId || "") ? youtubeId : "";
  const uploadedVideo = videoPath && new URL(videoPath, location.origin).origin === location.origin ? videoPath : "";
  if (!youtubeId && !uploadedVideo) return false;

  const bluRayPreview = !uploadedVideo && youtubeId === "f8t4gAIy5t0";
  const previewUrl = bluRayPreview ? "/assets/written-in-the-light-promo-preview.mp4" : uploadedVideo;
  const posters = promoPosterUrls(youtubeId, options.thumbnail, bluRayPreview);
  function showPoster() {
    if (!posters.length || frame.querySelector("img")) return;
    const image = document.createElement("img");
    image.alt = "";
    applyPromoPoster(image, posters);
    frame.prepend(image);
  }

  let preview;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const autoplay = !reducedMotion && (options.playback === "autoplay" || options.playback !== "click" && !!previewUrl);
  if (previewUrl) {
    preview = document.createElement("video");
    applyPromoPoster(preview, posters);
    preview.muted = true;
    preview.defaultMuted = true;
    preview.playsInline = true;
    preview.controls = false;
    preview.disablePictureInPicture = true;
    preview.disableRemotePlayback = true;
    preview.setAttribute("tabindex", "-1");
    preview.autoplay = autoplay;
    preview.loop = true;
    preview.preload = !autoplay && posters.length ? "none" : "metadata";
    if (bluRayPreview) {
      const captions = document.createElement("track");
      captions.kind = "captions";
      captions.label = "English";
      captions.srclang = "en";
      captions.src = "/assets/written-in-the-light-promo-preview.en.vtt";
      captions.default = true;
      preview.append(captions);
      captions.track.mode = "showing";
    }
    preview.setAttribute("aria-hidden", "true");
    const status = promoPlaybackStatus(frame);
    let failed = false;
    const paint = () => {
      motion.textContent = failed ? "Play preview" : !preview.paused ? "Pause preview" : preview.played.length ? "Resume preview" : "Play preview";
      motion.setAttribute("aria-pressed", String(!failed && !preview.paused));
      sound.hidden = false;
      sound.disabled = failed;
      sound.textContent = preview.muted ? "Unmute preview" : "Mute preview";
      sound.setAttribute("aria-pressed", String(!preview.muted));
    };
    const play = () => preview.play().catch(() => {
      status.hidden = false;
      status.textContent = "Playback is paused. Select Play preview to try again.";
      paint();
    });
    motion.hidden = false;
    preview.addEventListener("playing", () => {
      status.hidden = true;
      paint();
    });
    preview.addEventListener("pause", paint);
    preview.addEventListener("volumechange", paint);
    preview.addEventListener("error", () => {
      failed = true;
      preview.pause();
      preview.hidden = true;
      status.hidden = false;
      status.textContent = "The video preview is unavailable. Select Play preview to try again.";
      showPoster();
      paint();
    });
    if (uploadedVideo) preview.addEventListener("timeupdate", () => {
      if (preview.currentTime >= 12) preview.currentTime = 0;
    });
    motion.addEventListener("click", () => {
      if (failed) {
        failed = false;
        preview.hidden = false;
        preview.muted = true;
        frame.querySelector("img")?.remove();
        preview.load();
        play();
      } else if (preview.paused) play();
      else preview.pause();
    });
    sound.addEventListener("click", () => { if (!failed) { preview.muted = !preview.muted; paint(); } });
    preview.src = previewUrl;
    frame.prepend(preview);
    paint();
  } else {
    showPoster();
    mountYouTubePlayer(frame, motion, sound, youtubeId, autoplay);
  }
  return true;
}

async function renderHomepagePromo() {
  const promo = document.querySelector("#homepage-promo");
  if (!promo) return;

  try {
    const response = await fetch("/.netlify/functions/portal?action=homepagePromo", {
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(3500)
    });
    if (!response.ok) return;
    const {enabled, videoId, videoPath, title, buttonLabel, buttonPath, playback, thumbnail} = await response.json();
    if (!enabled || !title || !mountPromoVideo(promo, videoId, videoPath, {playback, thumbnail})) return;

    // Keep the product name together when the promo headline wraps.
    promo.querySelector("h1").textContent = title.replace(/\b(blu)-(rays?)\b/gi, "$1\u2011$2");
    if (buttonLabel && buttonPath && new URL(buttonPath, location.origin).origin === location.origin) {
      const button = promo.querySelector("[data-promo-button]");
      button.textContent = buttonLabel;
      button.href = buttonPath;
      button.hidden = false;
    }

    document.querySelector("#top").hidden = true;
    promo.hidden = false;
    const preview = promo.querySelector(".promo-player video");
    if (preview?.autoplay) preview.play().catch(() => {
      // When the browser blocks autoplay, the Play preview button is available.
    });
  } catch {
    // The site's original banner is the fallback if promo settings are unavailable.
  }
}

function initNavigation() {
  const button = document.querySelector("#menu-toggle");
  const nav = document.querySelector("#main-nav");
  if (!button || !nav) return;

  const close = () => {
    nav.classList.remove("open");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "Open navigation");
    const label = button.querySelector(".menu-label");
    if (label) label.textContent = "Menu";
  };

  button.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    const label = button.querySelector(".menu-label");
    if (label) label.textContent = open ? "Close" : "Menu";
  });

  nav.querySelectorAll("a").forEach(link => link.addEventListener("click", close));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      close();
      button.focus();
    }
  });
}

renderFeatured();
renderAnnouncement();
initNavigation();
renderHomepagePromo();
