// Practice accounts let production rehearse the portal. They are never published,
// counted or chased. An account is a practice account when its name starts with the
// word "Test", or when an admin has marked it as one on the person's page.
// Every part of the portal uses this one rule so a practice account cannot be
// private in one place and public in another.
export const practiceName=name=>/^test(?:\s|$)/i.test(String(name||'').trim());
export const isPractice=member=>!!member&&(member.practice===true||practiceName(member.name));
