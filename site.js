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

function mountYouTubePlayer(promo, link, motion, youtubeId, autoplay) {
  const host = document.createElement("div"), target = document.createElement("div");
  host.className = "promo-youtube";
  host.hidden = true;
  host.append(target);
  const fallback = document.createElement("a");
  fallback.className = "promo-youtube-fallback";
  fallback.href = "https://www.youtube.com/watch?v=" + youtubeId;
  fallback.textContent = "Watch on YouTube ↗";
  fallback.hidden = true;
  const status = document.createElement("p");
  status.className = "promo-youtube-status";
  status.setAttribute("role", "status");
  status.hidden = true;
  link.parentNode.append(host, status, fallback);
  let started = false, failed = false, player, readyTimer;
  const unavailable = () => {
    if (failed) return;
    failed = true;
    clearTimeout(readyTimer);
    host.hidden = true;
    link.hidden = false;
    fallback.hidden = false;
    status.hidden = false;
    status.textContent = "The embedded video is unavailable. Watch it on YouTube instead.";
    try { player?.destroy(); } catch {}
  };
  const start = muted => {
    if (started || failed) return;
    started = true;
    link.hidden = true;
    host.hidden = false;
    fallback.hidden = false;
    motion.hidden = true;
    loadYouTubeApi().then(api => {
      if (failed) return;
      readyTimer = setTimeout(unavailable, 12000);
      player = new api.Player(target, {
        width: "100%", height: "100%", videoId: youtubeId,
        playerVars: {autoplay: 0, controls: 1, enablejsapi: 1, playsinline: 1, loop: 1, playlist: youtubeId, origin: location.origin},
        events: {
          onReady: event => {
            if (failed) return;
            clearTimeout(readyTimer);
            const iframe = event.target.getIframe();
            iframe.title = "Homepage promotional video";
            iframe.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen");
            iframe.setAttribute("allowfullscreen", "");
            if (muted) event.target.mute();
            if (!muted || !matchMedia("(prefers-reduced-motion: reduce)").matches) event.target.playVideo();
          },
          onAutoplayBlocked: () => {
            status.hidden = false;
            status.textContent = "Playback did not start automatically. Use the video's Play button or watch on YouTube.";
          },
          onStateChange: event => { if (event.data === 1) status.hidden = true; },
          onError: unavailable
        }
      });
    }).catch(unavailable);
  };
  link.addEventListener("click", event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0 || failed) return;
    event.preventDefault();
    start(false);
  });
  if (autoplay) start(true);
}

function mountPromoVideo(promo, youtubeId, videoPath, options = {}) {
  const link = promo.querySelector(".promo-player");
  const motion = promo.querySelector(".promo-motion");
  youtubeId = /^[\w-]{11}$/.test(youtubeId || "") ? youtubeId : "";
  const youtubeUrl = youtubeId ? "https://www.youtube.com/watch?v=" + youtubeId : "";
  const uploadedVideo = videoPath && new URL(videoPath, location.origin).origin === location.origin ? videoPath : "";
  if (!youtubeUrl && !uploadedVideo) return false;

  const bluRayPreview = !uploadedVideo && youtubeId === "f8t4gAIy5t0";
  const previewUrl = bluRayPreview ? "/assets/written-in-the-light-promo-preview.mp4" : uploadedVideo;
  const posters = promoPosterUrls(youtubeId, options.thumbnail, bluRayPreview);
  link.href = youtubeUrl || uploadedVideo;
  function showPoster() {
    if (!posters.length) return;
    const image = document.createElement("img");
    image.alt = "";
    applyPromoPoster(image, posters);
    link.prepend(image);
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
    motion.hidden = false;
    preview.addEventListener("playing", () => {
      motion.textContent = "Pause preview";
    });
    preview.addEventListener("pause", () => {
      motion.textContent = preview.played.length ? "Resume preview" : "Play preview";
    });
    preview.addEventListener("error", () => {
      preview.remove();
      motion.hidden = true;
      showPoster();
    }, {once: true});
    if (uploadedVideo) preview.addEventListener("timeupdate", () => {
      if (preview.currentTime >= 12) preview.currentTime = 0;
    });
    motion.addEventListener("click", () => {
      if (preview.paused) preview.play().catch(() => {});
      else preview.pause();
    });
    preview.src = previewUrl;
    link.prepend(preview);
  } else {
    showPoster();
    mountYouTubePlayer(promo, link, motion, youtubeId, autoplay);
  }

  const viewer = promo.querySelector(".promo-viewer");
  if (!youtubeUrl && typeof viewer.showModal === "function") {
    const fullVideo = viewer.querySelector("video");
    let resumePreview = false;
    link.addEventListener("click", event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      resumePreview = preview && !preview.paused;
      preview?.pause();
      viewer.showModal();
      fullVideo.src = uploadedVideo;
      fullVideo.play().catch(() => {});
    });
    viewer.addEventListener("close", () => {
      fullVideo.removeAttribute("src");
      fullVideo.load();
      if (resumePreview) preview.play().catch(() => {});
    });
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
