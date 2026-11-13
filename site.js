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
    const {enabled, videoId, title, buttonLabel, buttonPath} = await response.json();
    if (!enabled || !/^[\w-]{11}$/.test(videoId || "") || !title) return;

    promo.querySelector("h1").textContent = title;
    const player = document.createElement("iframe");
    player.src = "https://www.youtube-nocookie.com/embed/" + videoId + "?playsinline=1";
    player.title = title;
    player.allow = "encrypted-media; picture-in-picture; fullscreen";
    player.allowFullscreen = true;
    promo.querySelector(".promo-player").append(player);
    promo.querySelector("[data-promo-youtube]").href = "https://www.youtube.com/watch?v=" + videoId;
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
