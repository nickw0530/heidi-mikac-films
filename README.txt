HEIDI MIKAC FILMS — WEBSITE

STACK
Static HTML, CSS, and JavaScript deployed from GitHub to Netlify.

SOURCE OF TRUTH
Always work from the current main branch of this repository. Do not rebuild from an old ZIP or preview.

DEPLOYMENT
Netlify deploys automatically when changes are committed to main. Every commit pushed to main is a paid Netlify production deploy, so publish in batches:
1. Do a work session's changes on a branch, never straight on main.
2. Check them on the free Netlify Deploy Preview (opening a pull request from the branch posts the preview link).
3. Merge into main once, at the end of the work session, as a single publish.
A commit that only changes notes like this file can add [skip netlify] to its commit message so it doesn't trigger a deploy.

EDITABLE HOMEPAGE CONTENT
site-content.js contains the current-production and upcoming-project copy/links.

CURRENT FILM ROUTES
/films/wherein-lies-continue/
/films/written-in-the-light/

EXTERNAL FILM SITE
Written in the Dark: https://writteninthedarkfilm.com

CONTENT RULES
- Only publish confirmed film facts, credits, awards, links, and release information.
- Use elegant “Details coming soon” states rather than developer placeholder copy.
- Preserve the dark cinematic visual identity.
- Keep the footer credit: Site by Mosaic Minds Media.

SEO
robots.txt and sitemap.xml are included at the site root.
Canonical production URL: https://heidimikacfilms.com/

CONTACT
A dedicated studio email has not yet been supplied. The site currently directs visitors to official social channels and clearly notes that professional contact details are forthcoming.

Merch checkout
Set HMF_PAYPAL_MODE=live, HMF_PAYPAL_CLIENT_ID and HMF_PAYPAL_SECRET in
Netlify's Functions environment for production. Use sandbox credentials and
HMF_PAYPAL_MODE=sandbox in a separate deploy preview to test. The PayPal
secret belongs in Netlify only. Configure product prices, stock quantities
and the flat U.S. shipping rate in the Film Portal under Website > Merch
and sales, then enable checkout. Check a sale's status from the same screen.
The sales report shows gross collections before PayPal fees and refunds.
Shipping details are available in the merchant's PayPal transaction.
