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

function mountPromoVideo(promo, youtubeId, videoPath) {
  const link = promo.querySelector(".promo-player");
  const motion = promo.querySelector(".promo-motion");
  const youtubeUrl = youtubeId ? "https://www.youtube.com/watch?v=" + youtubeId : "";
  const uploadedVideo = videoPath && new URL(videoPath, location.origin).origin === location.origin ? videoPath : "";
  if (!youtubeUrl && !uploadedVideo) return false;

  const bluRayPreview = !uploadedVideo && youtubeId === "f8t4gAIy5t0";
  const previewUrl = bluRayPreview ? "/assets/written-in-the-light-promo-preview.mp4" : uploadedVideo;
  const poster = bluRayPreview ? "/assets/written-in-the-light-promo-poster.webp" :
    youtubeId ? "https://i.ytimg.com/vi/" + youtubeId + "/mqdefault.jpg" : "";
  link.href = youtubeUrl || uploadedVideo;
  if (poster) {
    const image = document.createElement("img");
    image.alt = "";
    image.src = poster;
    image.addEventListener("error", () => image.remove(), {once: true});
    link.prepend(image);
  }

  let preview;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (previewUrl && (!reducedMotion || !poster)) {
    preview = document.createElement("video");
    preview.muted = true;
    preview.defaultMuted = true;
    preview.playsInline = true;
    preview.autoplay = !reducedMotion;
    preview.loop = true;
    preview.preload = "metadata";
    preview.setAttribute("aria-hidden", "true");
    preview.addEventListener("loadeddata", () => preview.classList.add("is-ready"));
    preview.addEventListener("playing", () => {
      motion.hidden = false;
      motion.textContent = "Pause preview";
    });
    preview.addEventListener("pause", () => { motion.textContent = "Resume preview"; });
    preview.addEventListener("error", () => { preview.remove(); motion.hidden = true; }, {once: true});
    if (uploadedVideo) preview.addEventListener("timeupdate", () => {
      if (preview.currentTime >= 12) preview.currentTime = 0;
    });
    motion.addEventListener("click", () => {
      if (preview.paused) preview.play().catch(() => {});
      else preview.pause();
    });
    preview.src = previewUrl;
    link.prepend(preview);
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
    const {enabled, videoId, videoPath, title, buttonLabel, buttonPath} = await response.json();
    if (!enabled || !title || !mountPromoVideo(promo, /^[\w-]{11}$/.test(videoId || "") ? videoId : "", videoPath)) return;

    promo.querySelector("h1").textContent = title;
    if (buttonLabel && buttonPath && new URL(buttonPath, location.origin).origin === location.origin) {
      const button = promo.querySelector("[data-promo-button]");
      button.textContent = buttonLabel;
      button.href = buttonPath;
      button.hidden = false;
    }

    document.querySelector("#top").hidden = true;
    promo.hidden = false;
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
