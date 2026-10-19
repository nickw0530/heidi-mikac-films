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