const c = window.SITE_CONTENT;
function safeHref(v) { return (/^(https?:\/\/|#|\/|\.\/)/i).test(v || '') ? v : '#'; }
function featured() {
 const x=document.querySelector('#featured-content'); if(!x)return;
 x.innerHTML = `<div class="featured-art"><img src="${c.featured.image}" alt="${c.featured.title} official film poster"></div><div class="featured-copy"><span class="eyebrow red">${c.featured.eyebrow}</span><h2>${c.featured.title}</h2><span class="mini-line"></span><p>${c.featured.description}</p><div class="button-row"><a class="btn btn-primary" href="${safeHref(c.featured.primaryUrl)}" target="_blank" rel="noopener noreferrer">${c.featured.primaryText} <span>↗</span></a><a class="btn btn-outline" href="${safeHref(c.featured.secondaryUrl)}" target="_blank" rel="noopener noreferrer">${c.featured.secondaryText} <span>↗</span></a></div></div>`;
}
function announcement(){const x=document.querySelector('#announcement-content');if(!x)return;x.innerHTML=`<span class="eyebrow">${c.announcement.label}</span><h2>${c.announcement.title}</h2><p>${c.announcement.body}</p><a class="text-link" href="${safeHref(c.announcement.buttonUrl)}">${c.announcement.buttonText} <span>↗</span></a>`;}
function contact(){const el=document.querySelector('#email-link');if(!el)return; if(c.contactEmail){el.href='mailto:'+c.contactEmail;el.textContent=c.contactEmail;}else{el.remove();}}
function nav(){const b=document.querySelector('#menu-toggle');const n=document.querySelector('#main-nav');if(!b||!n)return;b.addEventListener('click',()=>{const open=n.classList.toggle('open');b.setAttribute('aria-expanded',String(open));});n.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{n.classList.remove('open');b.setAttribute('aria-expanded','false');}));}
featured();announcement();contact();nav();
